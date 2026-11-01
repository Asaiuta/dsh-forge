//! Isolates the *post-walk* cost of `glob` — the part that changed.
//!
//! The end-to-end number is dominated by the directory walk (25k entries, at the
//! OS readdir floor), and ±10% run-to-run variance swallows anything smaller.
//! This harness walks once, keeps the matched file list, then replays both the
//! previous post-processing shape and the current one over that same list.
//!
//! Run: `cargo run --release --example glob_post -- <root> <pattern>`

use globset::{GlobBuilder, GlobMatcher};
use ignore::{WalkBuilder, WalkState};
use std::collections::BinaryHeap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Instant, SystemTime};

const VCS_DIRS: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
const GLOB_LIMIT: usize = 100;
const SEARCH_BATCH: usize = 500;

fn path_text(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd)
        .map(|relative| relative.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

/// The shape that was replaced: every match materialized, re-sorted per batch.
fn old_post(rows: &[(SystemTime, PathBuf)], cwd: &Path) -> Vec<String> {
    let shared = Arc::new(Mutex::new(Vec::<(SystemTime, String)>::new()));
    let mut local = Vec::with_capacity(SEARCH_BATCH);
    for (when, path) in rows {
        local.push((*when, path_text(path, cwd)));
        if local.len() >= SEARCH_BATCH {
            let mut merged = shared.lock().unwrap();
            merged.extend(local.drain(..));
            merged.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
            merged.truncate(GLOB_LIMIT);
        }
    }
    let mut merged = shared.lock().unwrap();
    merged.extend(local);
    let order = |a: &(SystemTime, String), b: &(SystemTime, String)| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1));
    merged.sort_unstable_by(order);
    merged.truncate(GLOB_LIMIT);
    merged.iter().map(|(_, path)| path.clone()).collect()
}

fn offer(heap: &mut BinaryHeap<(SystemTime, PathBuf)>, modified: SystemTime, path: &Path) {
    if heap.len() < GLOB_LIMIT {
        heap.push((modified, path.to_path_buf()));
        return;
    }
    let replaces = match heap.peek() {
        Some(top) => modified < top.0 || (modified == top.0 && path < top.1.as_path()),
        None => false,
    };
    if replaces {
        heap.pop();
        heap.push((modified, path.to_path_buf()));
    }
}

/// The current shape: a max-heap that only ever holds `GLOB_LIMIT` rows.
fn new_post(rows: &[(SystemTime, PathBuf)], cwd: &Path) -> Vec<String> {
    let mut heap: BinaryHeap<(SystemTime, PathBuf)> = BinaryHeap::new();
    for (when, path) in rows {
        offer(&mut heap, *when, path);
    }
    let order = |a: &(SystemTime, String), b: &(SystemTime, String)| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1));
    let mut paths: Vec<(SystemTime, String)> =
        heap.into_vec().into_iter().map(|(when, path)| (when, path_text(&path, cwd))).collect();
    paths.sort_unstable_by(order);
    paths.truncate(GLOB_LIMIT);
    paths.into_iter().map(|(_, path)| path).collect()
}

fn med(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs[xs.len() / 2]
}

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| ".".into()));
    let pattern = std::env::args().nth(2).unwrap_or_else(|| "*.ts".into());
    let cwd = root.clone();
    let basename = !pattern.contains('/');
    let matcher: GlobMatcher = GlobBuilder::new(&pattern)
        .literal_separator(true)
        .build()
        .expect("bad glob")
        .compile_matcher();

    // One walk, then both shapes replay the same input.
    let rows: Arc<Mutex<Vec<(SystemTime, PathBuf)>>> = Arc::new(Mutex::new(Vec::new()));
    let _walked = WalkBuilder::new(&root)
        .hidden(false)
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .require_git(false)
        .filter_entry(|entry| {
            if !entry.file_type().is_some_and(|kind| kind.is_dir()) {
                return true;
            }
            !entry.file_name().to_str().is_some_and(|name| VCS_DIRS.contains(&name))
        })
        .build_parallel()
        .run(|| {
            let rows = &rows;
            let matcher = &matcher;
            let anchor = &root;
            Box::new(move |entry| {
                let Ok(entry) = entry else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    return WalkState::Continue;
                }
                let file = entry.path();
                let hit = if basename {
                    file.file_name().is_some_and(|name| matcher.is_match(name))
                } else {
                    matcher.is_match(file.strip_prefix(anchor).unwrap_or(file))
                };
                if !hit {
                    return WalkState::Continue;
                }
                let Ok(modified) = entry.metadata().and_then(|meta| meta.modified().map_err(ignore::Error::from))
                else {
                    return WalkState::Continue;
                };
                rows.lock().unwrap().push((modified, file.to_path_buf()));
                WalkState::Continue
            })
        });
    let rows = Arc::try_unwrap(rows).ok().unwrap().into_inner().unwrap();

    let mut old_ms = Vec::new();
    let mut new_ms = Vec::new();
    let mut old_out = Vec::new();
    let mut new_out = Vec::new();
    for _ in 0..30 {
        let start = Instant::now();
        old_out = old_post(&rows, &cwd);
        old_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        let start = Instant::now();
        new_out = new_post(&rows, &cwd);
        new_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    println!("root={} pattern={} matched={}", root.display(), pattern, rows.len());
    println!("old (materialize all + batch sort) {:7.3} ms", med(old_ms));
    println!("new (heap cap {GLOB_LIMIT})               {:7.3} ms", med(new_ms));
    println!("identical answer: {}", old_out == new_out);
}
