//! stdio JSON-lines sidecar. One request per line, one response per line.
//!
//! Methods:
//!   {"id":N,"method":"ping"}
//!   {"id":N,"method":"resetCache"}
//!   {"id":N,"method":"parseBatch","files":["/abs/path.js", ...]}
//!     -> results: [{absPath,lang,symbols,signatures,partial,mtimeMs,size} | {absPath,error}]
//!   {"id":N,"method":"findSymbols","files":[...],"name":"x","kinds":["function"]|null}
//!     -> {items:[{absPath,qualifiedName,kind,occurrence,startLine,endLine,commentStartLine?,signature}],parsed:N}
//!   {"id":N,"method":"traceFacts","files":[...]}
//!     -> results: [TraceFileOutcome | {error}] in input order (module and JS-family
//!        languages; the caller re-extracts error entries on its WASM path)
//!   {"id":N,"method":"textFacts","text":"...","syntax":"javascript"|"typescript"|"tsx"}
//!     -> {facts, partial} for an inline script body
//!
//! A per-process (mtime,size) cache lives in this long-running process so a
//! warm findSymbols pays only a stat per file, no re-parse and no full-tree
//! serialization.

mod candidates;
mod collect;
mod facts;
mod find;
mod lang;
mod symbol;

use collect::Collector;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufWriter, Read, Write};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

const MAX_AST_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CACHED_FILES: usize = 6000;

#[derive(Serialize, Clone)]
struct FileOut {
    lang: Option<String>,
    symbols: Vec<symbol::Symbol>,
    signatures: std::collections::BTreeMap<u32, String>,
    partial: bool,
    mtime_ms: u64,
    size: u64,
}

#[derive(Clone)]
struct Entry {
    mtime_ms: u64,
    size: u64,
    out: Arc<FileOut>,
    last_used: std::time::Instant,
}

fn fs_meta(path: &str) -> Option<(u64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let size = m.len();
    let mtime_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some((mtime_ms, size))
}

fn read_capped(path: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    if meta.len() > MAX_AST_FILE_BYTES {
        return Err(format!("exceeds {MAX_AST_FILE_BYTES} byte AST cap"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(MAX_AST_FILE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("read: {e}"))?;
    if bytes.len() as u64 > MAX_AST_FILE_BYTES {
        return Err(format!("exceeds {MAX_AST_FILE_BYTES} byte AST cap"));
    }
    Ok(bytes)
}

/// BOM-stripped, LF-normalized text (`normalizeText`).
fn normalize(bytes: &[u8]) -> String {
    let raw = String::from_utf8_lossy(bytes);
    let no_bom = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    no_bom.replace("\r\n", "\n").replace('\r', "\n")
}

fn read_normalized(path: &str) -> Result<String, String> {
    read_capped(path).map(|bytes| normalize(&bytes))
}

fn signature_map(symbols: &[symbol::Symbol], text: &str) -> std::collections::BTreeMap<u32, String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut map = std::collections::BTreeMap::new();
    fn visit(syms: &[symbol::Symbol], lines: &[&str], map: &mut std::collections::BTreeMap<u32, String>) {
        for sym in syms {
            let line = lines.get((sym.start_line.saturating_sub(1)) as usize).copied().unwrap_or("");
            map.insert(sym.start_line, line.chars().take(500).collect());
            visit(&sym.children, lines, map);
        }
    }
    visit(symbols, &lines, &mut map);
    map
}

fn compute(abs: &str, mtime_ms: u64, size: u64) -> Result<FileOut, String> {
    let Some(l) = lang::detect_lang(abs) else {
        return Ok(FileOut { lang: None, symbols: Vec::new(), signatures: Default::default(), partial: false, mtime_ms, size });
    };
    if !lang::supported(l) {
        return Ok(FileOut { lang: Some(l.to_string()), symbols: Vec::new(), signatures: Default::default(), partial: false, mtime_ms, size });
    }
    let text = read_normalized(abs)?;
    let (symbols, partial) = Collector::extract(&text, l);
    let signatures = signature_map(&symbols, &text);
    Ok(FileOut { lang: Some(l.to_string()), symbols, signatures, partial, mtime_ms, size })
}

/// Parse-or-cache a batch, keyed by (mtime, size). Phase 1 stats + cache-checks
/// in one pass, phase 2 parallel-parses the misses (rayon), phase 3 fills the
/// cache. Returned order matches the input order. Each worker constructs its own
/// Parser inside `compute`, so nothing non-`Send` crosses a thread boundary.
/// Returns the per-file results plus the number of files that actually had to
/// be **parsed** (cache misses). The miss count is the honest cache-effectiveness
/// signal: a fully warm call reports 0.
fn load_parallel(cache: &mut HashMap<String, Entry>, files: &[String]) -> (Vec<(String, Result<Arc<FileOut>, String>)>, usize) {
    let n = files.len();
    // Stat every path in parallel — a warm query is exactly this per-file stat,
    // and serial metadata syscalls are the dominant warm cost on Windows.
    let metas: Vec<(String, Option<(u64, u64)>)> = files
        .par_iter()
        .map(|f| (f.clone(), fs_meta(f)))
        .collect();

    let mut results: Vec<Option<Result<Arc<FileOut>, String>>> = vec![None; n];
    let mut parse_jobs: Vec<(usize, String, u64, u64)> = Vec::new();

    for (i, (f, meta)) in metas.into_iter().enumerate() {
        match meta {
            None => results[i] = Some(Err("stat failed".to_string())),
            Some((mtime, size)) => {
                if let Some(e) = cache.get_mut(&f) {
                    if e.mtime_ms == mtime && e.size == size {
                        e.last_used = std::time::Instant::now();
                        results[i] = Some(Ok(e.out.clone()));
                        continue;
                    }
                }
                parse_jobs.push((i, f, mtime, size));
            }
        }
    }

    let misses = parse_jobs.len();
    let parsed: Vec<Result<Arc<FileOut>, String>> = parse_jobs
        .par_iter()
        .map(|(_, f, m, s)| compute(f, *m, *s).map(Arc::new))
        .collect();

    for (k, (i, f, mtime, size)) in parse_jobs.into_iter().enumerate() {
        let r = parsed[k].clone();
        if let Ok(out) = &r {
            cache.insert(f, Entry { mtime_ms: mtime, size, out: out.clone(), last_used: std::time::Instant::now() });
        }
        results[i] = Some(r);
    }

    trim_cache(cache, MAX_CACHED_FILES);
    let out = files
        .iter()
        .enumerate()
        .map(|(i, f)| (f.clone(), results[i].take().unwrap_or_else(|| Err("parse skipped".to_string()))))
        .collect();
    (out, misses)
}

/// Bound retained metadata across workspace switches, preserving recent hits.
fn trim_cache(cache: &mut HashMap<String, Entry>, cap: usize) {
    if cache.len() <= cap { return; }
    let mut oldest: Vec<_> = cache.iter().map(|(key, entry)| (key.clone(), entry.last_used)).collect();
    oldest.sort_unstable_by_key(|(_, used)| *used);
    for (key, _) in oldest.into_iter().take(cache.len() - cap) {
        cache.remove(&key);
    }
}

/// Serialized TraceFileOutcome, kept as JSON text: a warm hit is written
/// straight into the response without rebuilding or re-encoding the facts.
/// Entries are keyed by a content hash, not stat: Windows exposes no ctime
/// here, and a same-size edit with a restored mtime must not reuse old facts
/// (the WASM path hashes content for the same reason).
struct TraceEntry {
    hash: u64,
    json: Arc<str>,
    last_used: std::time::Instant,
}

fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn trace_outcome(abs: &str, bytes: &[u8]) -> Result<String, String> {
    let l = lang::detect_lang(abs).filter(|l| facts::supports_trace_facts(l)).ok_or("unsupported trace language")?;
    let (value, partial) = facts::trace_facts(&normalize(bytes), l).ok_or("native extraction declined")?;
    let outcome = serde_json::json!({ "value": value, "parseErrors": 0, "partialFiles": u8::from(partial) });
    serde_json::to_string(&outcome).map_err(|e| e.to_string())
}

/// Read and hash every file in parallel, reuse entries whose content is
/// unchanged, extract the rest. Errors are never cached.
fn trace_parallel(cache: &mut HashMap<String, TraceEntry>, files: &[String]) -> Vec<Result<Arc<str>, String>> {
    let shared: &HashMap<String, TraceEntry> = cache;
    let computed: Vec<Result<(u64, Arc<str>, bool), String>> = files.par_iter().map(|file| {
        let bytes = read_capped(file)?;
        let hash = content_hash(&bytes);
        if let Some(entry) = shared.get(file).filter(|e| e.hash == hash) { return Ok((hash, entry.json.clone(), false)); }
        trace_outcome(file, &bytes).map(|json| (hash, Arc::from(json), true))
    }).collect();
    let now = std::time::Instant::now();
    let results = files.iter().zip(computed).map(|(file, result)| result.map(|(hash, json, fresh)| {
        if fresh { cache.insert(file.clone(), TraceEntry { hash, json: json.clone(), last_used: now }); }
        else if let Some(entry) = cache.get_mut(file) { entry.last_used = now; }
        json
    })).collect();
    if cache.len() > MAX_CACHED_FILES {
        let mut oldest: Vec<_> = cache.iter().map(|(key, entry)| (key.clone(), entry.last_used)).collect();
        oldest.sort_unstable_by_key(|(_, used)| *used);
        for (key, _) in oldest.into_iter().take(cache.len() - MAX_CACHED_FILES) { cache.remove(&key); }
    }
    results
}

/// `{"id":..,"ok":true,"results":[...]}` assembled from cached JSON text.
fn write_trace_response(writer: &mut impl Write, id: &serde_json::Value, results: &[Result<Arc<str>, String>]) -> std::io::Result<()> {
    write!(writer, "{{\"id\":{id},\"ok\":true,\"results\":[")?;
    for (index, result) in results.iter().enumerate() {
        if index > 0 { writer.write_all(b",")?; }
        match result {
            Ok(json) => writer.write_all(json.as_bytes())?,
            Err(e) => serde_json::to_writer(&mut *writer, &serde_json::json!({ "error": e }))?,
        }
    }
    writer.write_all(b"]}\n")?;
    writer.flush()
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn eviction_keeps_recent_workspace_entries() {
        let now = std::time::Instant::now();
        let out = Arc::new(FileOut { lang: None, symbols: vec![], signatures: Default::default(), partial: false, mtime_ms: 0, size: 0 });
        let mut cache = HashMap::new();
        for (key, age) in [("old-workspace", 3), ("recent-workspace", 1), ("current-workspace", 0)] {
            cache.insert(key.to_string(), Entry { mtime_ms: 0, size: 0, out: out.clone(), last_used: now - std::time::Duration::from_secs(age) });
        }
        trim_cache(&mut cache, 2);
        assert_eq!(cache.len(), 2);
        assert!(!cache.contains_key("old-workspace"));
        assert!(cache.contains_key("current-workspace"));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RespItem {
    abs_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbols: Option<Vec<symbol::Symbol>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signatures: Option<std::collections::BTreeMap<u32, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    partial: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl RespItem {
    fn from_out(abs: String, out: &FileOut) -> Self {
        RespItem {
            abs_path: abs,
            lang: out.lang.clone(),
            symbols: Some(out.symbols.clone()),
            signatures: Some(out.signatures.clone()),
            partial: Some(out.partial),
            mtime_ms: Some(out.mtime_ms),
            size: Some(out.size),
            error: None,
        }
    }
    fn from_err(abs: String, e: String) -> Self {
        RespItem { abs_path: abs, lang: None, symbols: None, signatures: None, partial: None, mtime_ms: None, size: None, error: Some(e) }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FindItem {
    abs_path: String,
    qualified_name: String,
    kind: String,
    occurrence: u32,
    start_line: u32,
    end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    comment_start_line: Option<u32>,
    signature: String,
}

fn files_arg(req: &serde_json::Value) -> Vec<String> {
    req.get("files")
        .and_then(|f| f.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Per-file identity stamp the caller uses to decide whether cached facts are
/// still valid: (mtime ms, size, change time ms), matching `fs.statSync`.
///
/// The change time is the point of doing this here. On Windows Node reports
/// NTFS *change* time as `ctimeMs`, and no std API exposes it — a same-size
/// edit with a restored mtime leaves mtime and size identical, so without it a
/// stale entry would be reused. Reading it costs one extra handle query per
/// file, which is still far cheaper than the serial `statSync` loop it
/// replaces: the work is spread over the rayon pool.
mod stamp {
    #[cfg(windows)]
    mod imp {
        use std::ffi::c_void;
        use std::os::windows::ffi::OsStrExt;

        type Handle = *mut c_void;
        const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
        const FILE_READ_ATTRIBUTES: u32 = 0x0080;
        const SHARE_ALL: u32 = 0x0000_0007;
        const OPEN_EXISTING: u32 = 3;
        const FILE_BASIC_INFO: u32 = 0;
        const FILE_STANDARD_INFO: u32 = 1;
        /// 1601-01-01 -> 1970-01-01 in 100 ns ticks.
        const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;

        #[repr(C)]
        #[derive(Default)]
        struct BasicInfo { creation: i64, access: i64, write: i64, change: i64, attributes: u32 }

        #[repr(C)]
        #[derive(Default)]
        struct StandardInfo { allocation: i64, eof: i64, links: u32, delete_pending: u8, directory: u8 }

        #[link(name = "kernel32")]
        extern "system" {
            fn CreateFileW(name: *const u16, access: u32, share: u32, sa: *mut c_void, disposition: u32, flags: u32, template: Handle) -> Handle;
            fn GetFileInformationByHandleEx(handle: Handle, class: u32, info: *mut c_void, len: u32) -> i32;
            fn CloseHandle(handle: Handle) -> i32;
        }

        /// Same value Node reports as `mtimeMs`/`ctimeMs`: the millisecond
        /// fraction is computed as `sec * 1000 + nsec / 1e6` on the integer
        /// nanosecond split, not as `ticks / 10_000`. The two differ in the
        /// last bit for ~40% of files, which would make every cache entry look
        /// stale.
        fn ticks_to_ms(ticks: i64) -> f64 {
            let ns = (ticks as i128 - EPOCH_DIFF_100NS as i128) * 100;
            (ns / 1_000_000_000) as f64 * 1000.0 + (ns % 1_000_000_000) as f64 / 1e6
        }

        pub fn of(path: &str) -> Result<(f64, u64, f64), String> {
            // Node's `statSync` opens the extended-length form itself, so a
            // path over MAX_PATH still stats there. Without the `\\?\` prefix
            // CreateFileW fails and this stamp would silently fall back to the
            // slow per-file path for every deep file.
            let name: std::borrow::Cow<'_, str> = if path.len() > 240 && !path.starts_with(r"\\") {
                std::borrow::Cow::Owned(format!(r"\\?\{path}"))
            } else {
                std::borrow::Cow::Borrowed(path)
            };
            let mut wide: Vec<u16> = std::ffi::OsStr::new(name.as_ref()).encode_wide().collect();
            wide.push(0);
            unsafe {
                let handle = CreateFileW(wide.as_ptr(), FILE_READ_ATTRIBUTES, SHARE_ALL, std::ptr::null_mut(), OPEN_EXISTING, 0, std::ptr::null_mut());
                if handle == INVALID_HANDLE_VALUE {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let mut basic = BasicInfo::default();
                let mut standard = StandardInfo::default();
                let basic_ok = GetFileInformationByHandleEx(handle, FILE_BASIC_INFO, &mut basic as *mut _ as *mut c_void, std::mem::size_of::<BasicInfo>() as u32);
                let size_ok = GetFileInformationByHandleEx(handle, FILE_STANDARD_INFO, &mut standard as *mut _ as *mut c_void, std::mem::size_of::<StandardInfo>() as u32);
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                if basic_ok == 0 || size_ok == 0 {
                    return Err(error.to_string());
                }
                Ok((ticks_to_ms(basic.write), standard.eof.max(0) as u64, ticks_to_ms(basic.change)))
            }
        }
    }

    #[cfg(unix)]
    mod imp {
        use std::os::unix::fs::MetadataExt;

        pub fn of(path: &str) -> Result<(f64, u64, f64), String> {
            let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
            let mtime = meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6;
            let ctime = meta.ctime() as f64 * 1000.0 + meta.ctime_nsec() as f64 / 1e6;
            Ok((mtime, meta.len(), ctime))
        }
    }

    #[cfg(not(any(windows, unix)))]
    mod imp {
        pub fn of(path: &str) -> Result<(f64, u64, f64), String> {
            let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
            let millis = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            Ok((millis, meta.len(), millis))
        }
    }

    pub fn of(path: &str) -> Result<(f64, u64, f64), String> {
        imp::of(path)
    }
}

// ---------------------------------------------------------------------------
// Graph-cache validation (warm Trace path)
// ---------------------------------------------------------------------------

const P_FILE: u8 = 1;
const P_DIR: u8 = 2;
const P_SYMLINK: u8 = 3;
const P_OTHER: u8 = 4;

#[derive(Default)]
struct ProbeListing {
    entries: HashMap<String, u8>,
    folded: std::collections::HashSet<String>,
    /// `None` = never asked; `Some(None)` = the real path could not be read.
    real: Option<Option<String>>,
    /// The directory exists but could not be listed: take the exact check.
    unreadable: bool,
    /// Known to hold nothing (`ENOENT`), or known not to be a directory.
    empty: bool,
}

#[derive(Default)]
struct ProbeStats {
    probes: usize,
    reads: usize,
    reals: usize,
    exact: usize,
    mismatches: usize,
}

/// `\\?\D:\x` -> `D:\x`, `\\?\UNC\s\v` -> `\\s\v`: the form Node reports from
/// `fs.realpathSync.native`, so identity strings compare byte for byte.
fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

fn probe_parent(dir: &str) -> Option<&str> {
    let index = dir.rfind('\\')?;
    if index < 3 {
        return None;
    }
    Some(&dir[..index])
}

fn probe_split(path: &str) -> Option<(&str, &str)> {
    let index = path.rfind('\\')?;
    Some((&path[..index], &path[index + 1..]))
}

fn probe_join(root: &str, rel: &str) -> String {
    let mut out = String::with_capacity(root.len() + rel.len() + 1);
    out.push_str(root);
    for part in rel.split('/') {
        out.push('\\');
        out.push_str(part);
    }
    out
}

/// The exact per-probe check: a file (links followed) with this real path.
fn probe_matches(absolute: &str, expected_exists: bool, identity: &Option<String>) -> bool {
    match std::fs::metadata(absolute) {
        Ok(meta) => {
            let exists = meta.is_file();
            if exists != expected_exists {
                return false;
            }
            if !exists {
                return true;
            }
            match std::fs::canonicalize(absolute) {
                Ok(real) => Some(strip_verbatim(&real.to_string_lossy())) == *identity,
                Err(_) => false,
            }
        }
        Err(_) => !expected_exists,
    }
}

fn ensure_listing(cache: &mut HashMap<String, ProbeListing>, dir: &str, root_prefix: &str, reads: &mut usize) {
    if cache.contains_key(dir) {
        return;
    }
    let mut value = ProbeListing::default();
    let parent = if dir.starts_with(root_prefix) { probe_parent(dir) } else { None };
    if let Some(parent) = parent {
        ensure_listing(cache, parent, root_prefix, reads);
        let listed = &cache[parent];
        if !listed.unreadable {
            let base = dir.rsplit('\\').next().unwrap_or("");
            match listed.entries.get(base).copied() {
                // Not present at all, case-insensitively either: the directory
                // cannot exist, so its probes are answered without a readdir.
                None => {
                    if !listed.folded.contains(&base.to_lowercase()) {
                        value.empty = true;
                    }
                }
                // A plain file or a link that is not a directory cannot hold
                // entries; a link may still resolve to one.
                Some(kind) => {
                    if kind == P_FILE || kind == P_OTHER {
                        value.empty = true;
                    }
                }
            }
        }
    }
    if !value.empty {
        *reads += 1;
        match std::fs::read_dir(dir) {
            Ok(iter) => {
                for entry in iter.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let kind = match entry.file_type() {
                        Ok(file_type) if file_type.is_symlink() => P_SYMLINK,
                        Ok(file_type) if file_type.is_dir() => P_DIR,
                        Ok(file_type) if file_type.is_file() => P_FILE,
                        _ => P_OTHER,
                    };
                    value.folded.insert(name.to_lowercase());
                    value.entries.insert(name, kind);
                }
            }
            Err(error) => {
                // A missing directory holds no files; anything else (permission
                // denied, a device) has to be checked probe by probe.
                let not_a_dir = error.raw_os_error() == Some(267) || error.raw_os_error() == Some(20);
                if error.kind() == std::io::ErrorKind::NotFound || not_a_dir {
                    value.empty = true;
                } else {
                    value.unreadable = true;
                }
            }
        }
    }
    cache.insert(dir.to_string(), value);
}

/// Whether every resolution probe still sees the same file. Mirrors
/// `probesUnchanged` in src/tools-trace.ts, including its two-step strategy:
/// most probes are guessed `extension`/`index` candidates that do not exist, so
/// each parent directory is listed once and a directory the parent listing does
/// not contain is answered from the parent. Links, case-only matches and
/// unreadable directories fall back to the exact per-probe check.
fn probes_unchanged(root: &str, probes: &[(String, bool, Option<String>)]) -> (bool, ProbeStats) {
    let mut stats = ProbeStats { probes: probes.len(), ..ProbeStats::default() };
    let root_prefix = if root.ends_with('\\') { root.to_string() } else { format!("{root}\\") };
    let mut cache: HashMap<String, ProbeListing> = HashMap::new();
    for (rel, expected_exists, identity) in probes {
        let absolute = probe_join(root, rel);
        let Some((dir, name)) = probe_split(&absolute) else { return (false, stats) };
        ensure_listing(&mut cache, dir, &root_prefix, &mut stats.reads);
        let listed = cache.get_mut(dir).expect("listing inserted above");
        let kind = listed.entries.get(name).copied();
        let exact = if listed.unreadable {
            true
        } else {
            match kind {
                Some(kind) => kind != P_FILE && kind != P_DIR,
                // Absent, but the directory has this name in another case: on a
                // case-insensitive volume it may still be the same file.
                None => listed.folded.contains(&name.to_lowercase()),
            }
        };
        if exact {
            stats.exact += 1;
            if !probe_matches(&absolute, *expected_exists, identity) {
                return (false, stats);
            }
            continue;
        }
        let exists = kind == Some(P_FILE);
        if exists != *expected_exists {
            return (false, stats);
        }
        if !exists {
            continue;
        }
        if listed.real.is_none() {
            stats.reals += 1;
            listed.real = Some(std::fs::canonicalize(dir).ok().map(|p| strip_verbatim(&p.to_string_lossy())));
        }
        let Some(real) = listed.real.as_ref().and_then(|v| v.as_ref()) else {
            stats.exact += 1;
            if !probe_matches(&absolute, *expected_exists, identity) {
                return (false, stats);
            }
            continue;
        };
        // `path.join(dir, name)` never doubles a separator, and a drive root
        // canonicalizes to `D:\`.
        let joined = if real.ends_with('\\') { format!("{real}{name}") } else { format!("{real}\\{name}") };
        if Some(&joined) != identity.as_ref() {
            stats.mismatches += 1;
            return (false, stats);
        }
    }
    (true, stats)
}

/// Mirrors `IGNORE_DIRS` + gitignore handling in src/tools-symbol.ts: hidden
/// entries are NOT skipped (readdirSync includes them), only `.gitignore` files
/// (not `.ignore`/global/exclude/parent) are honoured, and the fixed ignore
/// directories never descend. The root itself is always walked.
const IGNORE_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "build", "out", "target", "vendor",
    "coverage", ".next", "__pycache__", ".venv", "venv", "tmp", ".cache",
];

fn walk_code_files(root: &str) -> Vec<String> {
    let mut out = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .ignore(false)
        .parents(false)
        .hidden(false)
        .filter_entry(|e| {
            if e.depth() == 0 { return true }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir { return true }
            let name = e.file_name().to_string_lossy();
            !IGNORE_DIRS.iter().any(|d| *d == name)
        })
        .build()
        .flatten()
    {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let s = entry.path().to_string_lossy();
            if lang::detect_lang(s.as_ref()).is_some() {
                out.push(s.into_owned());
            }
        }
    }
    out
}

fn kinds_arg(req: &serde_json::Value) -> Option<Vec<String>> {
    req.get("kinds")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
}

/// Returns the matched items plus the number of supported files that were
/// **scanned** (i.e. had a symbol tree available). This is the user-facing
/// "scanned N code files" count, so it is a property of the corpus, not of the
/// cache: a warm and a cold query report the same value.
fn collect_matches(
    loaded: Vec<(String, Result<Arc<FileOut>, String>)>,
    name: &str,
    kinds: &Option<Vec<String>>,
) -> (Vec<FindItem>, usize) {
    let mut items: Vec<FindItem> = Vec::new();
    let mut scanned = 0usize;
    for (f, res) in loaded {
        if let Ok(out) = res {
            if matches!(out.lang.as_deref(), Some(l) if lang::supported(l)) {
                scanned += 1;
                for m in find::match_file(&out.symbols, name, kinds.as_deref(), &out.signatures) {
                    items.push(FindItem {
                        abs_path: f.clone(),
                        qualified_name: m.qualified_name,
                        kind: m.kind,
                        occurrence: m.occurrence,
                        start_line: m.start_line,
                        end_line: m.end_line,
                        comment_start_line: m.comment_start_line,
                        signature: m.signature,
                    });
                }
            }
        }
    }
    (items, scanned)
}

fn main() {
    // The fact walk recurses per syntax level (bounded by facts::js MAX_DEPTH);
    // give pool threads room so a deep tree declines instead of overflowing.
    let _ = rayon::ThreadPoolBuilder::new().stack_size(64 * 1024 * 1024).build_global();
    let mut reader = std::io::stdin().lock();
    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    let mut cache: HashMap<String, Entry> = HashMap::new();
    let mut trace_cache: HashMap<String, TraceEntry> = HashMap::new();
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }
        let req: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = req.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");

        if method == "traceFacts" {
            let results = trace_parallel(&mut trace_cache, &files_arg(&req));
            let _ = write_trace_response(&mut writer, &id, &results);
            continue;
        }
        let response = match method {
            "textFacts" => {
                let text = req.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let lang = match req.get("syntax").and_then(|v| v.as_str()) { Some("typescript") => "typescript", Some("tsx") => "tsx", _ => "javascript" };
                match rayon::scope(|_| facts::text_facts(text, lang)) {
                    Some((facts, partial)) => serde_json::json!({ "id": id, "ok": true, "facts": facts, "partial": partial }),
                    None => serde_json::json!({ "id": id, "ok": false, "error": "native extraction declined" }),
                }
            }
            // Batched identity stamps for the caller's warm-path cache check.
            // Null marks a file this process could not stamp; `errors` carries
            // the reason per index so the caller keeps its `stat_failed`
            // diagnostic instead of a generic message.
            "statPaths" => {
                let files = files_arg(&req);
                let results: Vec<Result<(f64, u64, f64), String>> =
                    files.par_iter().map(|file| stamp::of(file)).collect();
                let mut errors = serde_json::Map::new();
                let stamps: Vec<serde_json::Value> = results
                    .into_iter()
                    .enumerate()
                    .map(|(index, result)| match result {
                        Ok((mtime, size, ctime)) => serde_json::json!([mtime, size, ctime]),
                        Err(error) => {
                            errors.insert(index.to_string(), serde_json::Value::String(error));
                            serde_json::Value::Null
                        }
                    })
                    .collect();
                serde_json::json!({ "id": id, "ok": true, "stamps": stamps, "errors": errors })
            }
            // Whether the cached graph is still valid: same protocol as
            // `probesUnchanged` in the caller, but the ~800 directory listings
            // it needs are answered here instead of in the JS thread.
            "probesUnchanged" => {
                let root = req.get("root").and_then(|v| v.as_str()).unwrap_or("");
                let probes: Vec<(String, bool, Option<String>)> = req
                    .get("probes")
                    .and_then(|v| v.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| {
                                let fields = item.as_array()?;
                                let rel = fields.first()?.as_str()?.to_string();
                                let exists = fields.get(1).and_then(|v| v.as_bool()).unwrap_or(false);
                                let identity = fields.get(2).and_then(|v| v.as_str()).map(String::from);
                                Some((rel, exists, identity))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let (unchanged, stats) = probes_unchanged(root, &probes);
                serde_json::json!({
                    "id": id, "ok": true, "unchanged": unchanged,
                    "probes": stats.probes, "reads": stats.reads,
                    "reals": stats.reals, "exact": stats.exact, "mismatches": stats.mismatches
                })
            }
            // The Trace scan's directory walk. Two phases: enumerate in
            // parallel (readdir is latency, not CPU), then replay depth first
            // so the truncation point matches the sequential walk exactly.
            "collectCandidates" => {
                let root = req.get("root").and_then(|v| v.as_str()).unwrap_or("");
                let walked = candidates::collect(root);
                serde_json::json!({
                    "id": id, "ok": true,
                    "files": walked.files, "projectFiles": walked.project,
                    "pythonFiles": walked.python, "cargoFiles": walked.cargo,
                    "goFiles": walked.go, "truncated": walked.truncated,
                    "walkErrors": walked.walk_errors
                })
            }
            "ping" => serde_json::json!({ "id": id, "ok": true }),
            "resetCache" => {
                cache.clear();
                trace_cache.clear();
                serde_json::json!({ "id": id, "ok": true })
            }
            "sexp" => {
                let path = req.get("file").and_then(|v| v.as_str()).unwrap_or("");
                let out = (|| -> Option<String> {
                    let l = lang::detect_lang(path)?;
                    let text = read_normalized(path).ok()?;
                    Collector::sexp(&text, l)
                })()
                .unwrap_or_else(|| "<none>".to_string());
                serde_json::json!({ "id": id, "ok": true, "sexp": out })
            }
            "parseBatch" => {
                let files = files_arg(&req);
                let (loaded, _misses) = load_parallel(&mut cache, &files);
                let results: Vec<RespItem> = loaded
                    .into_iter()
                    .map(|(f, r)| match r {
                        Ok(out) => RespItem::from_out(f, &out),
                        Err(e) => RespItem::from_err(f, e),
                    })
                    .collect();
                serde_json::json!({ "id": id, "ok": true, "results": results })
            }
            "findSymbols" => {
                let files = files_arg(&req);
                let name = req.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let kinds = kinds_arg(&req);
                let (loaded, misses) = load_parallel(&mut cache, &files);
                let (items, scanned) = collect_matches(loaded, &name, &kinds);
                serde_json::json!({ "id": id, "ok": true, "items": items, "parsed": scanned, "reparsed": misses })
            }
            "findSymbolsRoot" => {
                let root = req.get("root").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let name = req.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let kinds = kinds_arg(&req);
                let files = walk_code_files(&root);
                // Mixed-language trees are served natively now that all eleven
                // grammars ship; `allSupported` stays in the protocol so a future
                // ungrammared extension degrades instead of silently dropping
                // matches. The caller falls back to its hybrid WASM path when false.
                let all_supported = files.iter().all(|f| matches!(lang::detect_lang(f.as_str()), Some(l) if lang::supported(l)));
                if !all_supported {
                    serde_json::json!({ "id": id, "ok": true, "allSupported": false })
                } else {
                    let (loaded, misses) = load_parallel(&mut cache, &files);
                    let (items, scanned) = collect_matches(loaded, &name, &kinds);
                    serde_json::json!({ "id": id, "ok": true, "allSupported": true, "items": items, "parsed": scanned, "reparsed": misses })
                }
            }
            _ => serde_json::json!({ "id": id, "ok": false, "error": format!("unknown method {method}") }),
        };

        let _ = serde_json::to_writer(&mut writer, &response);
        let _ = writer.write_all(b"\n");
        let _ = writer.flush();
    }
}
