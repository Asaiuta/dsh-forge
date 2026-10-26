//! Candidate discovery for the Trace scan: the same walk `collectCandidates`
//! performs in src/tools-trace.ts, minus the per-entry JS objects.
//!
//! The rules are copied rather than "improved":
//!
//! - Only the ROOT `.gitignore` is honoured. A nested one is not read.
//! - A directory-only pattern (`dist/`) does not prune the directory itself:
//!   the JS matcher is asked about a path with no trailing separator, so its
//!   children are rejected one at a time. Matching with `is_dir = true` would
//!   prune it and change the visit count, which the truncation caps observe.
//! - Links are neither followed nor reported.
//! - `visited` counts every entry looked at, before the ignore test, and the
//!   caps are checked both on entering a directory and per entry.
//!
//! The walk is split in two because `readdir` is the whole cost (~65 us per
//! call on this machine, 900 calls for a mid-size repo) and it is pure latency,
//! not CPU: enumerating one level of directories in parallel is worth ~4x.
//! Phase 1 enumerates breadth first, in parallel, recording each directory's
//! entries in `readdir` order. Phase 2 replays that tree depth first in the
//! exact order the sequential walk would have used, so the truncation point and
//! the resulting list are identical. When phase 1 runs past the visit cap it
//! gives up and falls back to the sequential walk, which truncates the same way
//! it always did.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const FILE_CAP: usize = 20_000;
const WALK_VISIT_CAP: usize = 200_000;
/// Phase 1 stops enumerating past this many directories or entries and lets the
/// sequential walk decide what the caps keep.
const DIR_BUDGET: usize = 40_000;

/// Extensions `SCAN_EXTS` in src/tools-trace.ts accepts, without the dot.
const SCAN_EXTS: &[&str] = &[
    "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "html", "vue", "svelte", "py", "pyi",
    "rs", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "cppm", "ixx", "go", "java", "lua",
];

/// `BINARY_EXTENSIONS` from src/binary-facts.ts, without the dot.
const BINARY_EXTS: &[&str] = &["exe", "dll", "node", "so", "elf", "wasm"];

#[derive(Default)]
pub struct Candidates {
    pub files: Vec<String>,
    pub project: Vec<String>,
    pub python: Vec<String>,
    pub cargo: Vec<String>,
    pub go: Vec<String>,
    pub truncated: bool,
    pub walk_errors: usize,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    File,
    Dir,
    Link,
    Other,
}

struct Entry {
    /// `rel` is `prefix + name`, kept whole so phase 2 never re-joins strings.
    rel: String,
    name_len: usize,
    kind: Kind,
    ignored: bool,
    /// A directory that may be entered: not ignored, not blacklisted, no `_dsh`
    /// marker. Files and unreachable directories never carry a snapshot.
    descend: bool,
}

struct Snapshot {
    entries: Vec<Entry>,
    error: bool,
}

impl Entry {
    fn name(&self) -> &str {
        &self.rel[self.rel.len() - self.name_len..]
    }
}

/// `path.extname(name).toLowerCase()`: only the extension is lowered, a hidden
/// file has none, and neither has a name without a dot.
fn extension(name: &str) -> Option<String> {
    let index = name.rfind('.')?;
    if index == 0 {
        return None;
    }
    Some(name[index..].to_ascii_lowercase())
}

fn is_scan_candidate(name: &str) -> bool {
    if name == "go.mod" {
        return true;
    }
    let Some(ext) = extension(name) else { return false };
    let bare = &ext[1..];
    SCAN_EXTS.contains(&bare) || BINARY_EXTS.contains(&bare)
}

/// `projectMetadata` in src/js-project.ts also accepts the ts/js config family:
/// `/^(?:ts|js)config(?:\.[^/]+)?\.json$/`.
fn is_ts_js_config(name: &str) -> bool {
    let rest = match name.strip_prefix("tsconfig").or_else(|| name.strip_prefix("jsconfig")) {
        Some(rest) => rest,
        None => return false,
    };
    match rest.strip_suffix(".json") {
        Some(middle) => {
            middle.is_empty()
                || (middle.starts_with('.') && !middle[1..].is_empty() && !middle.contains('/'))
        }
        None => false,
    }
}

fn blacklisted(name: &str, absolute: &Path) -> bool {
    if name == "node_modules" || name == ".git" || name == ".dsh" {
        return true;
    }
    // Host-owned artifact containers (any dot-directory carrying the _dsh
    // marker) are runtime dumps, not workspace source.
    name.starts_with('.') && absolute.join("_dsh").exists()
}

/// The root matcher. A `.gitignore` that cannot be read counts as a walk error
/// and contributes no rules, which is what the JS side does.
fn matcher(root: &Path, out: &mut Candidates) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    let path = root.join(".gitignore");
    if path.exists() {
        // Bytes, not `read_to_string`: a `.gitignore` that is not valid UTF-8
        // (a GBK file on a Chinese Windows install, say) has to degrade the
        // same way Node's `readFileSync(..., 'utf8')` does — replacement
        // characters that match nothing — instead of becoming a walk error and
        // reporting "the rules could not be read" while the JS side reports
        // none.
        match std::fs::read(&path) {
            // One line per call: `add_line` does not split a multi-line string,
            // it folds everything after the first newline into one pattern and
            // silently drops the rest of the file.
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.lines() {
                    // The JS package has a `^\uFEFF` replacer, so an editor that
                    // wrote a BOM leaves the first rule `\uFEFFignored/` here and
                    // that rule would silently stop matching. Strip it to keep
                    // the two matchers reading the same file.
                    let line = line.strip_prefix('\u{feff}').unwrap_or(line);
                    if builder.add_line(None, line).is_err() {
                        out.walk_errors += 1;
                    }
                }
            }
            Err(_) => out.walk_errors += 1,
        }
    }
    // `ignore().add(text)` in JS is case-insensitive on every platform.
    let _ = builder.case_insensitive(true);
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// One directory, read but not yet classified for descent.
fn read_entries(
    base: &Path,
    dir: &Path,
    prefix: &str,
    matcher: &Gitignore,
) -> Result<Vec<Entry>, std::io::Error> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = match entry.file_type() {
            Ok(file_type) if file_type.is_symlink() => Kind::Link,
            Ok(file_type) if file_type.is_dir() => Kind::Dir,
            Ok(file_type) if file_type.is_file() => Kind::File,
            _ => Kind::Other,
        };
        let rel = format!("{prefix}{name}");
        let absolute = dir.join(&name);
        // No trailing separator, and never `is_dir` for the path itself: see
        // the module comment. Parents are checked as directories, which is how
        // a `dist/` rule reaches `dist/a.js` without pruning `dist` the way the
        // JS matcher refuses to.
        //
        // The path handed to the matcher is relative: `matched_path_or_any_parents`
        // asserts on a rooted path, and a root spelled with a different case
        // than the one on disk would leave the strip to fail.
        let relative: &Path = absolute.strip_prefix(base).unwrap_or_else(|_| Path::new(&rel));
        let ignored = matcher.matched_path_or_any_parents(relative, false).is_ignore();
        let descend = kind == Kind::Dir && !ignored && !blacklisted(&name, &absolute);
        out.push(Entry { rel, name_len: name.len(), kind, ignored, descend });
    }
    Ok(out)
}

fn classify(entry: &Entry, out: &mut Candidates) {
    let name = entry.name();
    if name == "package.json" || name == "pnpm-workspace.yaml" || is_ts_js_config(name) {
        out.project.push(entry.rel.clone());
    }
    if name == "pyproject.toml" || name == "setup.cfg" {
        out.python.push(entry.rel.clone());
    }
    if name == "Cargo.toml" {
        out.cargo.push(entry.rel.clone());
    }
    if name == "go.mod" || name == "go.work" {
        out.go.push(entry.rel.clone());
    }
    if is_scan_candidate(name) {
        out.files.push(entry.rel.clone());
    }
}

/// Phase 2: the sequential walk, replayed over in-memory listings.
fn replay(
    snapshots: &HashMap<PathBuf, Snapshot>,
    dir: &Path,
    out: &mut Candidates,
    visited: &mut usize,
) {
    if out.files.len() >= FILE_CAP || *visited > WALK_VISIT_CAP {
        out.truncated = true;
        return;
    }
    let Some(snapshot) = snapshots.get(dir) else { return };
    if snapshot.error {
        out.walk_errors += 1;
        return;
    }
    for entry in &snapshot.entries {
        if out.files.len() >= FILE_CAP || *visited > WALK_VISIT_CAP {
            out.truncated = true;
            return;
        }
        *visited += 1;
        if entry.ignored {
            continue;
        }
        match entry.kind {
            Kind::Dir => {
                if entry.descend {
                    replay(snapshots, &dir.join(entry.name()), out, visited);
                }
            }
            Kind::File => classify(entry, out),
            Kind::Link | Kind::Other => {}
        }
    }
}

/// The original walk, one directory at a time. Kept for the over-budget case,
/// where the visit cap has to be spent in DFS order to truncate predictably.
fn sequential(
    base: &Path,
    dir: &Path,
    prefix: &str,
    matcher: &Gitignore,
    out: &mut Candidates,
    visited: &mut usize,
) {
    if out.files.len() >= FILE_CAP || *visited > WALK_VISIT_CAP {
        out.truncated = true;
        return;
    }
    let entries = match read_entries(base, dir, prefix, matcher) {
        Ok(entries) => entries,
        Err(_) => {
            out.walk_errors += 1;
            return;
        }
    };
    for entry in &entries {
        if out.files.len() >= FILE_CAP || *visited > WALK_VISIT_CAP {
            out.truncated = true;
            return;
        }
        *visited += 1;
        if entry.ignored {
            continue;
        }
        match entry.kind {
            Kind::Dir => {
                if entry.descend {
                    sequential(base, &dir.join(entry.name()), &format!("{}/", entry.rel), matcher, out, visited);
                }
            }
            Kind::File => classify(entry, out),
            Kind::Link | Kind::Other => {}
        }
    }
}

/// Candidate discovery for one root. The caller sorts: `localeCompare` has no
/// byte-order equivalent in Rust, and the order is part of the scan signature.
pub fn collect(root: &str) -> Candidates {
    let mut out = Candidates::default();
    let base = Path::new(root);
    let rules = matcher(base, &mut out);
    let mut snapshots: HashMap<PathBuf, Snapshot> = HashMap::new();
    let mut frontier: Vec<(PathBuf, String)> = vec![(base.to_path_buf(), String::new())];
    let mut enumerated = 0usize;
    let mut overflow = false;

    while !frontier.is_empty() {
        let results: Vec<(PathBuf, String, Result<Vec<Entry>, std::io::Error>)> = frontier
            .into_par_iter()
            .map(|(dir, prefix)| {
                let read = read_entries(base, &dir, &prefix, &rules);
                (dir, prefix, read)
            })
            .collect();
        let mut next: Vec<(PathBuf, String)> = Vec::new();
        for (dir, _prefix, read) in results {
            match read {
                Ok(entries) => {
                    enumerated += entries.len();
                    for entry in &entries {
                        if entry.descend {
                            next.push((dir.join(entry.name()), format!("{}/", entry.rel)));
                        }
                    }
                    snapshots.insert(dir, Snapshot { entries, error: false });
                }
                Err(_) => {
                    snapshots.insert(dir, Snapshot { entries: Vec::new(), error: true });
                }
            }
        }
        if enumerated > WALK_VISIT_CAP || snapshots.len() > DIR_BUDGET {
            overflow = true;
            break;
        }
        frontier = next;
    }

    if overflow {
        // Too big to enumerate up front: spend the cap in DFS order instead.
        let mut visited = 0;
        sequential(base, base, "", &rules, &mut out, &mut visited);
        return out;
    }

    let mut visited = 0;
    replay(&snapshots, base, &mut out, &mut visited);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch tree under `target/`, never the system temp directory.
    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = Path::new("target").join("candidates-test").join(name);
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Fixture { root }
        }

        fn file(&self, rel: &str, body: &str) {
            let path = self.root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }

        fn dir(&self, rel: &str) {
            std::fs::create_dir_all(self.root.join(rel)).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn populated(name: &str) -> Fixture {
        let fixture = Fixture::new(name);
        fixture.file(
            ".gitignore",
            "dist/\n/src/gen/**\n**/cache\n[ab].js\n\\#hash.js\nsub/only.js\n",
        );
        fixture.file("main.js", "");
        fixture.file("keep.js", "");
        fixture.file("dist/bundle.js", "");
        fixture.file("dist/deep/nested.js", "");
        fixture.file("src/gen/x.js", "");
        fixture.file("src/live.js", "");
        fixture.file("cache/c.js", "");
        fixture.file("pkg/cache/c.js", "");
        fixture.file("a.js", "");
        fixture.file("b.js", "");
        fixture.file("c.js", "");
        fixture.file("#hash.js", "");
        fixture.file("sub/only.js", "");
        fixture.file("other/sub/only.js", "");
        fixture.file("package.json", "{}");
        fixture.file("sub/tsconfig.app.json", "{}");
        fixture.file("sub/tsconfigX.json", "{}");
        fixture.file("pyproject.toml", "");
        fixture.file("Cargo.toml", "");
        fixture.file("go.mod", "");
        fixture.file("go.work", "");
        fixture.file("lib/x.dll", "");
        fixture.file("noext", "");
        fixture.dir("empty");
        fixture.file("node_modules/ignored.js", "");
        fixture.file(".git/config.js", "");
        fixture.file(".artifact/_dsh/asar-out/y.js", "");
        fixture.file(".artifact/z.js", "");
        fixture.file(".plain/y.js", "");
        fixture.dir("deep/a/b/c");
        fixture.file("deep/a/b/c/d.ts", "");
        fixture
    }

    fn same(label: &str, left: &Candidates, right: &Candidates) {
        assert_eq!(left.files, right.files, "{label}: files");
        assert_eq!(left.project, right.project, "{label}: projectFiles");
        assert_eq!(left.python, right.python, "{label}: pythonFiles");
        assert_eq!(left.cargo, right.cargo, "{label}: cargoFiles");
        assert_eq!(left.go, right.go, "{label}: goFiles");
        assert_eq!(left.truncated, right.truncated, "{label}: truncated");
        assert_eq!(left.walk_errors, right.walk_errors, "{label}: walkErrors");
    }

    /// The parallel replay and the sequential fallback have to agree entry for
    /// entry, order included: the visit cap is spent in DFS order, so a
    /// different order would truncate at a different file.
    #[test]
    fn parallel_replay_matches_sequential_walk() {
        let fixture = populated("parallel-vs-sequential");
        let root = fixture.root.to_string_lossy().into_owned();

        let walked = collect(&root);
        let mut sequential_result = Candidates::default();
        let rules = matcher(&fixture.root, &mut sequential_result);
        let mut visited = 0;
        sequential(&fixture.root, &fixture.root, "", &rules, &mut sequential_result, &mut visited);

        same("walk", &walked, &sequential_result);
        assert!(walked.files.contains(&"main.js".to_string()));
        assert!(walked.files.contains(&"keep.js".to_string()));
        assert!(walked.files.contains(&"src/live.js".to_string()));
        assert!(walked.files.contains(&"other/sub/only.js".to_string()));
        assert!(!walked.files.iter().any(|file| file.starts_with("dist/")), "dist/ children stay out");
        assert!(!walked.files.contains(&"a.js".to_string()), "[ab].js excludes a");
        assert!(!walked.files.contains(&"b.js".to_string()), "[ab].js excludes b");
        assert!(walked.files.contains(&"c.js".to_string()), "the class is [ab], not [a-c]");
        assert!(!walked.files.contains(&"#hash.js".to_string()));
        assert!(!walked.files.contains(&"sub/only.js".to_string()));
        assert!(!walked.files.contains(&"cache/c.js".to_string()));
        assert!(!walked.files.contains(&"pkg/cache/c.js".to_string()));
        assert!(!walked.files.contains(&"src/gen/x.js".to_string()));
        assert!(!walked.files.iter().any(|file| file.starts_with("node_modules/")));
        assert!(!walked.files.iter().any(|file| file.starts_with(".git/")));
        assert!(!walked.files.iter().any(|file| file.starts_with(".artifact/_dsh/")));
        assert!(!walked.files.contains(&".artifact/z.js".to_string()), "a _dsh marker skips the whole dot-directory");
        assert!(walked.files.contains(&".plain/y.js".to_string()), "a dot-directory without the marker is walked");
        assert_eq!(walked.project, vec!["package.json", "sub/tsconfig.app.json"]);
        assert!(!walked.project.iter().any(|file| file.contains("tsconfigX")));
    }

    #[test]
    fn an_empty_root_is_empty_not_an_error() {
        let fixture = Fixture::new("empty-root");
        let walked = collect(&fixture.root.to_string_lossy());
        assert!(walked.files.is_empty());
        assert_eq!(walked.walk_errors, 0);
        assert!(!walked.truncated);
    }

    #[test]
    fn a_missing_root_reports_one_walk_error() {
        let walked = collect("target/candidates-test/does-not-exist");
        assert!(walked.files.is_empty());
        assert_eq!(walked.walk_errors, 1);
    }
}
