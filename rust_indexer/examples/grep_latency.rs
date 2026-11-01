//! Latency attribution for the grep path: regex compilation, the directory
//! walk, and the per-file search, measured separately.
//!
//! Run: `cargo run --release --example grep_latency -- <root> <pattern> [include]`
//! This is a diagnostic, not part of the build.

use globset::{GlobBuilder, GlobMatcher};
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::{WalkBuilder, WalkState};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const VCS_DIRS: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
const MATCH_LIMIT: usize = 250;

fn walk(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| {
            !entry.file_name().to_str().is_some_and(|name| VCS_DIRS.contains(&name))
        });
    builder
}

struct NullSink;
impl Sink for NullSink {
    type Error = io::Error;
    fn matched(&mut self, _s: &Searcher, _m: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        Ok(false)
    }
}

/// Walk only: count files that would be searched.
fn walk_only(root: &Path) -> (f64, usize) {
    let files = AtomicUsize::new(0);
    let start = Instant::now();
    walk(root).build_parallel().run(|| {
        let files = &files;
        Box::new(move |entry| {
            let Ok(entry) = entry else { return WalkState::Continue };
            if entry.file_type().is_some_and(|kind| kind.is_file()) {
                files.fetch_add(1, Ordering::Relaxed);
            }
            WalkState::Continue
        })
    });
    (start.elapsed().as_secs_f64() * 1000.0, files.load(Ordering::Relaxed))
}

/// Walk + search each file, discarding matches.
fn walk_and_search(root: &Path, regex: &RegexMatcher, include: Option<&(GlobMatcher, bool)>) -> f64 {
    let searched = AtomicUsize::new(0);
    let start = Instant::now();
    walk(root).build_parallel().run(|| {
        let searched = &searched;
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(0))
            .bom_sniffing(true)
            .build();
        Box::new(move |entry| {
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            let path = entry.path();
            if let Some((matcher, basename)) = include {
                let relative = path.strip_prefix(root).unwrap_or(path);
                let ok = if *basename {
                    relative.file_name().is_some_and(|name| matcher.is_match(name))
                } else {
                    matcher.is_match(relative)
                };
                if !ok {
                    return WalkState::Continue;
                }
            }
            searched.fetch_add(1, Ordering::Relaxed);
            let mut sink = NullSink;
            let _ = searcher.search_path(regex, path, &mut sink);
            WalkState::Continue
        })
    });
    let _ = searched.load(Ordering::Relaxed);
    start.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| ".".into()));
    let pattern = std::env::args().nth(2).unwrap_or_else(|| "fn ".into());
    let include_text = std::env::args().nth(3).filter(|value| !value.is_empty());

    let med = |mut xs: Vec<f64>| {
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        xs[xs.len() / 2]
    };

    let mut compile = Vec::new();
    for _ in 0..7 {
        let start = Instant::now();
        let matcher = RegexMatcher::new_line_matcher(&pattern).expect("bad regex");
        compile.push(start.elapsed().as_secs_f64() * 1000.0);
        drop(matcher);
    }
    let regex = RegexMatcher::new_line_matcher(&pattern).expect("bad regex");
    let include = include_text.as_deref().map(|text| {
        let basename = !text.contains('/');
        let matcher = GlobBuilder::new(text).literal_separator(true).build().expect("bad glob").compile_matcher();
        (matcher, basename)
    });

    let (_, files) = walk_only(&root);
    let mut walk_ms = Vec::new();
    let mut search_ms = Vec::new();
    for _ in 0..5 {
        walk_ms.push(walk_only(&root).0);
        search_ms.push(walk_and_search(&root, &regex, include.as_ref()));
    }
    let walk_median = med(walk_ms);
    let search_median = med(search_ms);
    println!(
        "root={} pattern={:?} include={:?} files={} limit={}",
        root.display(),
        pattern,
        include_text,
        files,
        MATCH_LIMIT
    );
    println!("regex compile        {:8.3} ms", med(compile));
    println!("walk only            {:8.1} ms", walk_median);
    println!("walk + search        {:8.1} ms", search_median);
    println!("=> per-file search   {:8.1} ms", search_median - walk_median);
}
