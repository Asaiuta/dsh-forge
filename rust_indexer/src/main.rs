//! stdio JSON-lines sidecar. One request per line, one response per line.
//!
//! Methods:
//!   {"id":N,"method":"ping"}
//!   {"id":N,"method":"resetCache"}
//!   {"id":N,"method":"parseBatch","files":["/abs/path.js", ...]}
//!     -> results: [{absPath,lang,symbols,signatures,partial,mtimeMs,size} | {absPath,error}]
//!   {"id":N,"method":"findSymbols","files":[...],"name":"x","kinds":["function"]|null}
//!     -> {items:[{absPath,qualifiedName,kind,occurrence,startLine,endLine,commentStartLine?,signature}],parsed:N}
//!
//! A per-process (mtime,size) cache lives in this long-running process so a
//! warm findSymbols pays only a stat per file, no re-parse and no full-tree
//! serialization.

mod collect;
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

fn read_normalized(path: &str) -> Result<String, String> {
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
    let raw = String::from_utf8_lossy(&bytes);
    let no_bom = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    Ok(no_bom.replace("\r\n", "\n").replace('\r', "\n"))
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
    let mut reader = std::io::stdin().lock();
    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    let mut cache: HashMap<String, Entry> = HashMap::new();
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

        let response = match method {
            "ping" => serde_json::json!({ "id": id, "ok": true }),
            "resetCache" => {
                cache.clear();
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
