//! Latency attribution for the glob walk.
//!
//! Answers three questions the end-to-end number cannot:
//!   1. how much of the wall time is readdir vs glob matching vs the per-match
//!      `stat` that (mtime, path) ordering needs;
//!   2. whether `build_parallel` is actually running in parallel on this host;
//!   3. how much the per-entry `filter_entry` closure costs.
//!
//! Run: `cargo run --release --example search_latency -- <root> <pattern> <threads>`
//! This is a diagnostic, not part of the build.

use globset::{GlobBuilder, GlobMatcher};
use ignore::{WalkBuilder, WalkState};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const VCS_DIRS: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

fn build(root: &Path, threads: usize, filter: bool) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .threads(threads.max(1));
    if filter {
        builder.filter_entry(|entry| {
            // The production closure only needs to look at directories: a file
            // can never be named like a VCS directory and pruned. Keeping that
            // check here is what lets the third number in the output show the
            // cost of calling it for every entry instead.
            if !entry.file_type().is_some_and(|kind| kind.is_dir()) {
                return true;
            }
            !entry.file_name().to_str().is_some_and(|name| VCS_DIRS.contains(&name))
        });
    }
    builder
}

fn run(root: &Path, matcher: &GlobMatcher, basename: bool, threads: usize, filter: bool, stat: bool) -> (f64, usize, usize) {
    let files = AtomicUsize::new(0);
    let matched = AtomicUsize::new(0);
    let start = Instant::now();
    build(root, threads, filter).build_parallel().run(|| {
        let files = &files;
        let matched = &matched;
        Box::new(move |entry| {
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            files.fetch_add(1, Ordering::Relaxed);
            let path = entry.path();
            let hit = if basename {
                path.file_name().is_some_and(|name| matcher.is_match(name))
            } else {
                matcher.is_match(path)
            };
            if !hit {
                return WalkState::Continue;
            }
            matched.fetch_add(1, Ordering::Relaxed);
            if stat {
                // The ordering key. `metadata()` is the only way to read mtime:
                // neither readdir nor ignore's DirEntry caches it.
                let _ = entry.metadata().ok().and_then(|meta| meta.modified().ok());
            }
            WalkState::Continue
        })
    });
    (start.elapsed().as_secs_f64() * 1000.0, files.load(Ordering::Relaxed), matched.load(Ordering::Relaxed))
}

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| ".".into()));
    let pattern = std::env::args().nth(2).unwrap_or_else(|| "*.ts".into());
    let threads: usize = std::env::args().nth(3).and_then(|value| value.parse().ok()).unwrap_or_else(|| {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8)
    });
    let basename = !pattern.contains('/');
    let matcher = GlobBuilder::new(&pattern)
        .literal_separator(true)
        .build()
        .expect("bad glob")
        .compile_matcher();

    let med = |mut xs: Vec<f64>| {
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        xs[xs.len() / 2]
    };
    let sample = |threads: usize, filter: bool, stat: bool| {
        let mut xs = Vec::new();
        for _ in 0..5 {
            xs.push(run(&root, &matcher, basename, threads, filter, stat).0);
        }
        med(xs)
    };

    // Warm the OS directory cache so the numbers measure the code, not the disk.
    run(&root, &matcher, basename, threads, true, false);
    let (_, files, matched) = run(&root, &matcher, basename, threads, true, false);

    println!("root={} pattern={} threads={} files={} matched={}", root.display(), pattern, threads, files, matched);
    println!("vcs-filter closure   {:8.1} ms", sample(threads, true, false));
    println!("  no filter_entry    {:8.1} ms", sample(threads, false, false));
    println!("  + stat (ordering)  {:8.1} ms", sample(threads, true, true));
    let mut scaling = Vec::new();
    for n in [1usize, 2, 4, 8, 16] {
        scaling.push(format!("t{n}={:.1}ms", sample(n, true, false)));
    }
    println!("thread sweep         {}", scaling.join("  "));
}
