//! Why does `ignore::WalkBuilder` take ~85 ms for a 25k-entry tree while the
//! Trace candidate walk takes ~6 ms for the same tree?
//!
//! Compares three traversals over one root, counting entries so the comparison
//! is fair:
//!   A. `ignore::WalkBuilder` (what glob/grep use today)
//!   B. plain `read_dir` breadth-first, rayon-parallel (what candidates.rs does)
//!   C. B + a `stat` per file (glob's ordering key)
//!
//! Run: `cargo run --release --example walk_compare -- <root>`
//! This is a diagnostic, not part of the build.

use ignore::{WalkBuilder, WalkState};
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const VCS_DIRS: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

fn ignore_walk(root: &Path) -> (f64, usize) {
    let files = AtomicUsize::new(0);
    let start = Instant::now();
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
        .filter_entry(|entry| {
            !entry.file_name().to_str().is_some_and(|name| VCS_DIRS.contains(&name))
        });
    builder.build_parallel().run(|| {
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

/// One breadth-first level, enumerated in parallel: readdir is latency, not
/// CPU, so issuing every directory's listing at once is the whole trick.
fn level(dirs: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let per_dir: Vec<(Vec<PathBuf>, Vec<PathBuf>)> = dirs
        .par_iter()
        .map(|dir| {
            let mut subdirs = Vec::new();
            let mut files = Vec::new();
            let Ok(entries) = std::fs::read_dir(dir) else { return (subdirs, files) };
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if VCS_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                match entry.file_type() {
                    Ok(kind) if kind.is_dir() => subdirs.push(entry.path()),
                    Ok(kind) if kind.is_file() => files.push(entry.path()),
                    _ => {}
                }
            }
            (subdirs, files)
        })
        .collect();
    let mut subdirs = Vec::new();
    let mut files = Vec::new();
    for (d, f) in per_dir {
        subdirs.extend(d);
        files.extend(f);
    }
    (subdirs, files)
}

fn bfs_walk(root: &Path, stat: bool) -> (f64, usize, usize) {
    let start = Instant::now();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut frontier = vec![root.to_path_buf()];
    while !frontier.is_empty() {
        let (subdirs, found) = level(&frontier);
        files.extend(found);
        frontier = subdirs;
    }
    let total = files.len();
    let mut stamped = 0usize;
    if stat {
        // Same ordering key glob needs. Measured after the walk so the two
        // numbers stay separable.
        stamped = files
            .par_iter()
            .filter(|path| std::fs::metadata(path).and_then(|m| m.modified()).is_ok())
            .count();
    }
    let _ = stamped;
    (start.elapsed().as_secs_f64() * 1000.0, total, stamped)
}

fn med(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs[xs.len() / 2]
}

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| ".".into()));
    let _ = ignore_walk(&root);

    let mut a = Vec::new();
    let mut b = Vec::new();
    let mut c = Vec::new();
    let mut files = 0;
    let mut stamped = 0;
    for _ in 0..5 {
        let (ms, _) = ignore_walk(&root);
        a.push(ms);
        let (ms, n, _) = bfs_walk(&root, false);
        b.push(ms);
        files = n;
        let (ms, _, s2) = bfs_walk(&root, true);
        c.push(ms);
        stamped = s2;
    }
    println!("root={} files={} stamped={}", root.display(), files, stamped);
    println!("A ignore::WalkBuilder       {:8.1} ms", med(a));
    println!("B read_dir BFS (rayon)      {:8.1} ms", med(b));
    println!("C read_dir BFS + stat/file  {:8.1} ms", med(c));
}
