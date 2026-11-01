//! Parallel file-name and line search for the built-in `glob` and `grep` tools.

use globset::{GlobBuilder, GlobMatcher};
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::sync::Arc;
use std::time::SystemTime;

const VCS_DIRS: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
const OUTPUT_LIMIT: usize = 20_000_000;
/// The transport is all-or-nothing; presentation limits belong to the host.
fn reserve_output(bytes: &AtomicUsize, count: usize) -> bool {
    let mut current = bytes.load(Ordering::Relaxed);
    loop {
        let Some(next) = current.checked_add(count).filter(|total| *total <= OUTPUT_LIMIT) else { return false };
        match bytes.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

fn path_order(a: &str, b: &str) -> std::cmp::Ordering {
    if cfg!(windows) { Path::new(&a.to_lowercase()).cmp(Path::new(&b.to_lowercase())).then_with(|| Path::new(a).cmp(Path::new(b))) }
    else { Path::new(a).cmp(Path::new(b)) }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    path: String,
    line_number: u64,
    line: String,
}

fn walk(root: &Path, respect_ignores: bool) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(respect_ignores)
        .ignore(respect_ignores)
        .git_ignore(respect_ignores)
        .git_global(respect_ignores)
        .git_exclude(respect_ignores)
        .parents(respect_ignores)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| {
            // Directories only. A file can never be named like a VCS directory,
            // and this closure runs for every entry in the tree — on a 25k-entry
            // checkout that is 25k name conversions for a check that can only
            // ever fire on the ~5k directories.
            if !entry.file_type().is_some_and(|kind| kind.is_dir()) {
                return true;
            }
            !entry.file_name().to_str().is_some_and(|name| VCS_DIRS.contains(&name))
        });
    builder
}

fn path_text(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd)
        .map(|relative| relative.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

/// The deepest directory a pattern can *only* match under.
///
/// `src/**/*.ts` -> `src`, `a/b*.rs` -> `a`, `**/*.ts` -> none. Only leading
/// segments that are pure literals are taken; every ambiguous shape (empty or
/// `..` segments, brace alternation, backslashes) declines the shortcut so the
/// walk keeps starting at the root and the answer stays identical.
///
/// A pattern without a separator is matched against the *basename at any
/// depth*, so its first segment says nothing about where the files live.
fn literal_base(root: &Path, pattern: &str) -> Option<PathBuf> {
    if pattern.is_empty() || pattern.starts_with('!') || pattern.contains('\\') || !pattern.contains('/') {
        return None;
    }
    let mut base = root.to_path_buf();
    let mut taken = 0usize;
    for segment in pattern.split('/') {
        if segment.is_empty() || segment == ".." {
            return None;
        }
        if segment == "." {
            continue;
        }
        // The first segment carrying glob syntax is the part that has to be
        // matched, so the literal prefix ends just before it.
        if segment.contains(['*', '?', '[', ']', '{', '}']) {
            break;
        }
        base.push(segment);
        taken += 1;
    }
    (taken > 0).then_some(base)
}

/// Where a walk should start. Falls back to the root whenever the literal
/// prefix is absent on disk, so a narrowed walk can only ever make an existing
/// answer cheaper — never change it.
fn walk_start(root: &Path, pattern: &str) -> PathBuf {
    match literal_base(root, pattern) {
        Some(base) if base.is_dir() => base,
        _ => root.to_path_buf(),
    }
}

fn glob_matcher(pattern: &str) -> Result<(GlobMatcher, bool, bool), String> {
    let exclude = pattern.starts_with('!');
    let pattern = if exclude { &pattern[1..] } else { pattern };
    let basename = !pattern.contains('/');
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map(|glob| (glob.compile_matcher(), exclude, basename))
        .map_err(|error| error.to_string())
}

/// `basename` patterns only ever read the last component, so they are answered
/// without spelling the path relative to `root` — that strip runs for every
/// file in the tree and its result is then thrown away.
fn matches_glob(matcher: &GlobMatcher, basename: bool, root: &Path, file: &Path) -> bool {
    if basename {
        return file.file_name().is_some_and(|name| matcher.is_match(name));
    }
    matcher.is_match(file.strip_prefix(root).unwrap_or(file))
}

struct GlobBatch {
    shared: Arc<Mutex<Vec<(SystemTime, String)>>>,
    local: Vec<(SystemTime, String)>,
}

impl Drop for GlobBatch {
    fn drop(&mut self) { self.shared.lock().unwrap().append(&mut self.local); }
}

struct GrepBatch {
    shared: Arc<Mutex<Vec<GrepMatch>>>,
    local: Vec<GrepMatch>,
}

fn match_order(a: &GrepMatch, b: &GrepMatch) -> std::cmp::Ordering {
    a.path.cmp(&b.path).then_with(|| a.line_number.cmp(&b.line_number))
}

impl Drop for GrepBatch {
    fn drop(&mut self) { self.shared.lock().unwrap().append(&mut self.local); }
}

pub fn glob(root: &str, cwd: &str, pattern: &str) -> Result<Vec<String>, String> {
    let root = PathBuf::from(root);
    let cwd = PathBuf::from(cwd);
    let (matcher, exclude, basename) = glob_matcher(pattern)?;
    let failed = AtomicBool::new(false);
    let paths = Arc::new(Mutex::new(Vec::<(SystemTime, String)>::new()));
    let bytes = AtomicUsize::new(2);

    // A pattern whose leading segments are literal (`src/**/*.ts`) can only
    // match under them, so the walk starts there instead of reading the whole
    // tree. `root` stays the strip anchor, so emitted paths are unchanged.
    let start = walk_start(&root, pattern);
    walk(&start, false).build_parallel().run(|| {
        let paths = &paths;
        let failed = &failed;
        let matcher = &matcher;
        let root = &root;
        let cwd = &cwd;
        let bytes = &bytes;
        let mut batch = GlobBatch { shared: paths.clone(), local: Vec::new() };
        Box::new(move |entry| {
            if failed.load(Ordering::Relaxed) { return WalkState::Quit; }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    failed.store(true, Ordering::Relaxed);
                    return WalkState::Continue;
                }
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            let file = entry.path();
            let matches = matches_glob(matcher, basename, root, file);
            if matches == exclude {
                return WalkState::Continue;
            }
            match entry.metadata().and_then(|meta| meta.modified().map_err(ignore::Error::from)) {
                Ok(modified) => {
                    let text = path_text(file, cwd);
                    if !reserve_output(bytes, serde_json::to_vec(&text).unwrap().len() + 1) {
                        failed.store(true, Ordering::Relaxed);
                        return WalkState::Quit;
                    }
                    batch.local.push((modified, text));
                }
                Err(_) => failed.store(true, Ordering::Relaxed),
            }
            WalkState::Continue
        })
    });

    if failed.load(Ordering::Relaxed) {
        return Err("file walk failed".into());
    }
    let mut paths = Arc::try_unwrap(paths).ok().unwrap().into_inner().unwrap();
    paths.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| path_order(&a.1, &b.1)));
    Ok(paths.into_iter().map(|(_, path)| path).collect())
}

fn include_matcher(include: &str) -> Result<(GlobMatcher, bool), String> {
    let basename = !include.contains('/');
    GlobBuilder::new(include)
        .literal_separator(true)
        .build()
        .map(|glob| (glob.compile_matcher(), basename))
        .map_err(|error| error.to_string())
}

struct MatchSink<'a> {
    file: &'a Path,
    cwd: &'a Path,
    /// Resolved on the first hit. Most files the walk reaches carry no matching
    /// line, and turning their path into a display string is the one per-file
    /// cost this search does not have to pay.
    path: Option<String>,
    matches: Vec<GrepMatch>,
    bytes: &'a AtomicUsize,
    too_large: bool,
}

impl Sink for MatchSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, matched: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        let line = String::from_utf8_lossy(matched.bytes());
        if line.len() > OUTPUT_LIMIT {
            self.too_large = true;
            return Ok(false);
        }
        let line = line.strip_suffix('\n').unwrap_or(&line);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if self.path.is_none() {
            self.path = Some(path_text(self.file, self.cwd));
        }
        let path = self.path.as_ref().unwrap();
        let item = GrepMatch {
            path: path.clone(),
            line_number: matched.line_number().unwrap_or(0),
            line: line.to_owned(),
        };
        if !reserve_output(self.bytes, serde_json::to_vec(&item).unwrap().len() + 1) {
            self.too_large = true;
            return Ok(false);
        }
        self.matches.push(item);
        Ok(true)
    }

    fn binary_data(&mut self, _searcher: &Searcher, _offset: u64) -> Result<bool, Self::Error> {
        self.matches.clear();
        Ok(false)
    }
}

pub fn grep(root: &str, cwd: &str, pattern: &str, include: Option<&str>) -> Result<Vec<GrepMatch>, String> {
    let root = PathBuf::from(root);
    let cwd = PathBuf::from(cwd);
    let regex = RegexMatcher::new_line_matcher(pattern).map_err(|error| error.to_string())?;
    let include_text = include;
    let include = include_text.map(include_matcher).transpose()?;
    let failed = AtomicBool::new(false);
    let matches = Arc::new(Mutex::new(Vec::new()));
    let bytes = AtomicUsize::new(2);

    // An include pattern that starts with literal directories (`src/**/*.rs`)
    // can only select files under them, so the walk starts there too.
    let start = match include_text {
        Some(text) => walk_start(&root, text),
        None => root.clone(),
    };
    walk(&start, true).build_parallel().run(|| {
        let matches = &matches;
        let failed = &failed;
        let regex = &regex;
        let include = &include;
        let root = &root;
        let cwd = &cwd;
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(0))
            .bom_sniffing(true)
            .build();
        let bytes = &bytes;
        let mut batch = GrepBatch { shared: matches.clone(), local: Vec::new() };
        Box::new(move |entry| {
            if failed.load(Ordering::Relaxed) { return WalkState::Quit; }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    failed.store(true, Ordering::Relaxed);
                    return WalkState::Continue;
                }
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            let file = entry.path();
            if include
                .as_ref()
                .is_some_and(|(matcher, basename)| !matches_glob(matcher, *basename, root, file))
            {
                return WalkState::Continue;
            }
            let mut sink = MatchSink { file, cwd, path: None, matches: Vec::new(), bytes, too_large: false };
            if searcher.search_path(regex, file, &mut sink).is_err() || sink.too_large {
                failed.store(true, Ordering::Relaxed);
                return WalkState::Continue;
            }
            if !sink.matches.is_empty() {
                batch.local.extend(sink.matches);
            }
            WalkState::Continue
        })
    });

    if failed.load(Ordering::Relaxed) {
        return Err("file search failed".into());
    }
    let mut matches = Arc::try_unwrap(matches).ok().unwrap().into_inner().unwrap();
    matches.sort_unstable_by(match_order);
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_ROOT: AtomicUsize = AtomicUsize::new(0);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "dsh-forge-search-{}-{}",
                std::process::id(),
                NEXT_ROOT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn write(&self, name: &str, contents: impl AsRef<[u8]>) {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn glob_includes_hidden_and_ignored_files_but_skips_vcs() {
        let root = TestRoot::new();
        root.write(".gitignore", "ignored/\n");
        root.write(".hidden/a.txt", "x");
        root.write("ignored/b.txt", "x");
        root.write(".git/secret.txt", "x");
        root.write("src/c.rs", "x");

        let paths = glob(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "*.txt").unwrap();
        let names: Vec<_> = paths.iter().map(|path| path.replace('\\', "/")).collect();
        assert_eq!(names, [".hidden/a.txt", "ignored/b.txt"]);
    }

    #[test]
    fn grep_matches_lines_filters_by_include_and_skips_binary_files() {
        let root = TestRoot::new();
        root.write(".gitignore", "ignored/\n");
        root.write("src/a.rs", "first\r\nneedle one\r\nneedle two\r\n");
        root.write(".hidden.rs", "needle hidden\n");
        root.write("ignored/c.rs", "needle ignored\n");
        root.write("docs/a.txt", "needle outside\n");
        root.write("src/b.rs", b"needle\0binary\n");

        let matches = grep(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "needle", Some("*.rs")).unwrap();
        assert_eq!(
            matches.iter().map(|item| (item.path.replace('\\', "/"), item.line.clone())).collect::<Vec<_>>(),
            [("src/a.rs".into(), "needle one".into()), ("src/a.rs".into(), "needle two".into())],
        );
    }

    #[test]
    fn grep_preserves_complete_values_beyond_the_builtin_display_limit() {
        let root = TestRoot::new();
        root.write("many.txt", (0..400).map(|i| format!("needle {i}\n")).collect::<String>());

        let matches = grep(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "needle", None).unwrap();
        assert_eq!(matches.len(), 400);
        assert_eq!(matches.first().unwrap().line_number, 1);
        assert_eq!(matches.last().unwrap().line_number, 400);
    }

    #[test]
    fn glob_preserves_complete_values_and_host_equal_mtime_order() {
        let root = TestRoot::new();
        let time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        for i in 0..140 {
            let name = format!("file-{i:03}.txt");
            root.write(&name, "x");
            fs::File::options().write(true).open(root.0.join(name)).unwrap().set_modified(time).unwrap();
        }
        for name in ["Zebra.txt", "apple.txt"] {
            root.write(name, "x");
            fs::File::options().write(true).open(root.0.join(name)).unwrap().set_modified(time).unwrap();
        }
        let paths = glob(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "*.txt").unwrap();
        assert_eq!(paths.len(), 142);
        if cfg!(windows) {
            assert_eq!(paths.first().unwrap(), "apple.txt");
            assert_eq!(paths.last().unwrap(), "Zebra.txt");
        }
    }

    #[test]
    fn grep_over_budget_is_failure_not_a_partial_value() {
        let root = TestRoot::new();
        root.write("large.txt", format!("needle {}\n", "x".repeat(OUTPUT_LIMIT)));
        assert!(grep(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "needle", None).is_err());
    }


    fn sorted(paths: &[String]) -> Vec<String> {
        let mut names: Vec<_> = paths.iter().map(|path| path.replace('\\', "/")).collect();
        names.sort();
        names
    }

    #[test]
    fn glob_literal_prefix_walks_only_that_subtree() {
        let root = TestRoot::new();
        root.write("src/a.rs", "x");
        root.write("src/deep/b.rs", "x");
        root.write("lib/c.rs", "x");

        let flat = glob(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "src/*.rs").unwrap();
        assert_eq!(sorted(&flat), ["src/a.rs"]);

        let deep = glob(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "src/**/*.rs").unwrap();
        assert_eq!(sorted(&deep), ["src/a.rs", "src/deep/b.rs"]);
    }

    #[test]
    fn glob_missing_literal_prefix_is_empty_not_an_error() {
        let root = TestRoot::new();
        root.write("src/a.rs", "x");

        let paths = glob(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "nodir/**/*.rs").unwrap();
        assert!(paths.is_empty());
    }

    /// `{src,lib}` is alternation, not a literal segment: the walk must still
    /// reach both subtrees.
    #[test]
    fn glob_alternation_prefix_still_reaches_every_branch() {
        let root = TestRoot::new();
        root.write("src/a.rs", "x");
        root.write("lib/b.rs", "x");

        let paths = glob(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "{src,lib}/*.rs").unwrap();
        assert_eq!(sorted(&paths), ["lib/b.rs", "src/a.rs"]);
    }

    /// A basename pattern matches at any depth, so a directory that happens to
    /// share the name must not narrow the walk.
    #[test]
    fn glob_basename_pattern_still_reaches_every_depth() {
        let root = TestRoot::new();
        root.write("src/main.rs", "x");
        root.write("deep/nest/src", "x");

        let paths = glob(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "src").unwrap();
        assert_eq!(sorted(&paths), ["deep/nest/src"]);
    }

    #[test]
    fn grep_basename_include_still_reaches_every_depth() {
        let root = TestRoot::new();
        root.write("a.rs", "needle\n");
        root.write("deep/a.rs", "needle\n");

        let matches = grep(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "needle", Some("a.rs")).unwrap();
        let mut names: Vec<_> = matches.iter().map(|item| item.path.replace('\\', "/")).collect();
        names.sort();
        assert_eq!(names, ["a.rs", "deep/a.rs"]);
    }

    /// Narrowing the walk must not escape the root's ignore files: the walk
    /// now starts at `src`, so `.gitignore` in the root has to still apply.
    #[test]
    fn grep_include_prefix_still_obeys_the_root_gitignore() {
        let root = TestRoot::new();
        root.write(".gitignore", "src/gen/\n");
        root.write("src/gen/x.rs", "needle\n");
        root.write("src/a.rs", "needle\n");

        let matches = grep(root.0.to_str().unwrap(), root.0.to_str().unwrap(), "needle", Some("src/**/*.rs")).unwrap();
        assert_eq!(matches.iter().map(|item| item.path.replace('\\', "/")).collect::<Vec<_>>(), ["src/a.rs"]);
    }
}
