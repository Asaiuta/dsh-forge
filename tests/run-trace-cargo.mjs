// Rust Cargo workspaces: cross-crate `use` through path dependencies, declared target roots.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, resetTraceFactsCache } from '../lib/tools-trace.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-cargo-'))
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const edgesAt = (graph, file, line) => (graph.deps.get(file) ?? []).filter(edge => edge.line === line).map(edge => [edge.to, edge.evidence.confidence])
const unresolved = (graph, file, spec) => graph.unresolvedModules.find(ref => ref.path === file && ref.spec === spec)

try {
  write('Cargo.toml', [
    '[workspace]', 'members = ["crates/*"]', '',
    '[workspace.dependencies]', 'wscore = { path = "crates/wscore" }', 'serde = "1"', '',
  ].join('\n'))
  write('crates/core/Cargo.toml', '[package]\nname = "my-core"\nversion = "0.1.0"\n')
  write('crates/core/src/lib.rs', 'pub mod util;\n')
  write('crates/core/src/util.rs', 'pub fn helper() {}\n')
  write('crates/core/tests/it.rs', 'use my_core::util::helper;\n')
  write('crates/wscore/Cargo.toml', '[package]\nname = "wscore"\nversion = "0.1.0"\n')
  write('crates/wscore/src/lib.rs', 'pub struct Thing;\n')
  write('crates/custom/Cargo.toml', '[package]\nname = "custom"\nversion = "0.1.0"\n\n[lib]\nname = "custom_lib"\npath = "lib/entry.rs"\n')
  write('crates/custom/lib/entry.rs', 'pub mod inner;\n')
  write('crates/custom/lib/inner.rs', 'pub struct X;\n')
  write('crates/app/Cargo.toml', [
    '[package]', 'name = "app"', 'version = "0.1.0"', '',
    '[dependencies]', 'my-core = { path = "../core" }', 'wscore = { workspace = true }', 'serde = { workspace = true }',
    'custom = { path = "../custom" }', 'renamed = { path = "../core", package = "my-core" }', '',
    '[target.\'cfg(unix)\'.dependencies]', 'unixdep = { path = "../wscore", package = "wscore" }', '',
  ].join('\n'))
  write('crates/app/src/main.rs', [
    'use my_core::util::helper;', // 1: dependency module item
    'use my_core;', // 2: dependency crate root
    'use wscore::Thing;', // 3: workspace = true path dependency
    'use serde::Serialize;', // 4: registry dependency stays external
    'use custom_lib::inner::X;', // 5: lib.name decides the in-code name
    'use renamed::util;', // 6: package rename keeps the table key
    'use unixdep::Thing as T;', // 7: target-specific dependency
    'use my_core::nope::Missing;', // 8: path missing in the dependency
    'use custom::inner::X as Y;', // 9: the package name is not the lib name
    'use ::wscore::Thing as Z;', // 10: absolute path to a path dependency
  ].join('\n') + '\n')

  resetTraceFactsCache()
  const { graph, diagnostics } = await assembleTraceGraph(root)
  assert.deepEqual(diagnostics.filter(issue => /Cargo\.toml$/.test(issue.path)), [])
  const main = 'crates/app/src/main.rs'
  assert.deepEqual(edgesAt(graph, main, 1), [['crates/core/src/util.rs', 'candidate']])
  assert.deepEqual(edgesAt(graph, main, 2), [['crates/core/src/lib.rs', 'candidate']])
  assert.deepEqual(edgesAt(graph, main, 3), [['crates/wscore/src/lib.rs', 'candidate']])
  assert.equal(unresolved(graph, main, 'serde::Serialize').reason, 'external_package')
  ok('path dependencies (direct and workspace = true) resolve into the dependency mod tree; registry crates stay external')

  assert.deepEqual(edgesAt(graph, 'crates/custom/lib/entry.rs', 1), [['crates/custom/lib/inner.rs', 'certain']])
  assert.deepEqual(edgesAt(graph, main, 5), [['crates/custom/lib/inner.rs', 'candidate']])
  assert.equal(unresolved(graph, main, 'custom::inner::X').reason, 'external_package')
  ok('[lib] path is a crate root and [lib] name, not the package name, is the in-code name')

  assert.deepEqual(edgesAt(graph, main, 6), [['crates/core/src/util.rs', 'candidate']])
  assert.deepEqual(edgesAt(graph, main, 7), [['crates/wscore/src/lib.rs', 'candidate']])
  assert.deepEqual(edgesAt(graph, main, 10), [['crates/wscore/src/lib.rs', 'candidate']])
  ok('package renames, target-specific tables and absolute paths use the right dependency name')

  assert.equal(unresolved(graph, main, 'my_core::nope::Missing').reason, 'missing_target')
  assert.deepEqual(edgesAt(graph, 'crates/core/tests/it.rs', 1), [['crates/core/src/util.rs', 'candidate']])
  ok('missing paths in a dependency are missing_target; integration tests see their own lib implicitly')

  write('crates/app/Cargo.toml', '[package]\nname = "app"\nversion = "0.1.0"\n')
  const after = await assembleTraceGraph(root)
  assert.notEqual(after.graph, graph)
  assert.deepEqual(edgesAt(after.graph, main, 1), [])
  assert.equal(unresolved(after.graph, main, 'my_core::util::helper').reason, 'external_package')
  ok('editing Cargo.toml invalidates the cached graph')
} finally {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
}

console.log(`\n${passed} Trace Cargo workspace groups passed`)
