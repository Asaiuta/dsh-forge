/** Handwritten file relationships across packages, plus ambiguity and freshness. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, createTraceTool, resetTraceFactsCache } from '../lib/tools-trace.js'
import { AstWorkerPool } from '../lib/ast-pool.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-packages-'))
const previousWorkers = process.env.DSH_FORGE_AST_WORKERS, pool = new AstWorkerPool()
const put = (file, text = '') => { const full = path.join(root, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, '\uFEFF' + text.replaceAll('\n', '\r\n')) }
const edges = (graph, file) => (graph.deps.get(file) ?? []).map(({ to, line, kind }) => [to, line, kind])
let passed = 0
const ok = message => console.log(`ok ${++passed} - ${message}`)
const exec = { agent: { session: { header: { cwd: root } } } }
try {
  process.env.DSH_FORGE_AST_WORKERS = '0'
  put('src/lib.rs', 'mod worker;\nuse crate::worker::{self, Item as Local, nested::Thing};\nmod inside { use super::worker::Item; }\nuse std::collections::HashMap;\nuse std;\nuse crate::missing::Thing;\n')
  put('src/worker.rs', 'pub mod nested;\npub struct Item;\n')
  put('src/worker/nested.rs', 'pub struct Thing;\n')
  put('util.py', 'value = 1\n')
  put('pkg/__init__.py')
  put('pkg/helper.py')
  put('load.py', 'import importlib as il\nfrom importlib import import_module as load\na = __import__("util")\nb = il.import_module("pkg.helper")\nc = load(".helper", "pkg")\nd = il.import_module(name)\ne = obj.import_module("util")\n')
  put('shadow.py', 'import importlib\ndef run(importlib):\n    return importlib.import_module("util")\n__import__ = other\n__import__("util")\n')
  put('shadow-context.py', 'import importlib\nfrom importlib import import_module as load\nwith ctx() as importlib:\n    importlib.import_module("util")\ntry:\n    pass\nexcept Exception as load:\n    load("util")\n')
  put('shadow-comprehension.py', 'import importlib\n[importlib.import_module("util") for importlib in things]\nf = lambda importlib: importlib.import_module("util")\n')
  put('types/virtual.d.ts', 'declare module "virtual-probe" { export function run(): void; }\n')
  put('consumer.ts', 'import { run } from "virtual-probe";\n')
  put('go.mod', 'module example.local/demo\n\ngo 1.23\n')
  put('go/main.go', 'package main\nimport "example.local/demo/go/helper"\nimport "fmt"\n')
  put('go/helper/a.go', 'package helper\nfunc A() {}\n')
  put('go/helper/b.go', '//go:build windows\n\npackage helper\nfunc B() {}\n')
  put('go/helper/a_test.go', 'package helper\n')
  put('java/p/Main.java', 'package p;\nimport p.Helper;\nimport static p.Util.run;\n')
  put('java/p/Helper.java', 'package p;\npublic class Helper {}\n')
  put('java/p/Util.java', 'package p;\npublic class Util { public static void run() {} }\n')
  put('lua/main.lua', 'local h = require("lib.helper")\nlocal p = require "lib.other"\nlocal x = require(name)\n-- require("ghost")\n')
  put('lib/helper.lua', 'return {}\n')
  put('lib/other/init.lua', 'return {}\n')
  put('lua/shadow.lua', 'local require = custom\nlocal a = require("lib.helper")\n')
  put('lua/global-shadow.lua', '_G.require = function(n) return {} end\nrequire("lib.helper")\n')
  put('lua/raw-shadow.lua', 'rawset(_G, "require", custom)\nrequire("lib.helper")\n')
  const first = await assembleTraceGraph(root), graph = first.graph
  assert.equal(first.parseErrors, 0)
  assert.equal(first.partialFiles, 0)
  assert.deepEqual(edges(graph, 'src/lib.rs'), [
    ['src/worker.rs', 1, 'rust_mod'], ['src/worker.rs', 2, 'rust_use (module candidate)'],
    ['src/worker/nested.rs', 2, 'rust_use (module candidate)'], ['src/worker.rs', 3, 'rust_use (module candidate)'],
  ])
  assert.deepEqual(graph.unresolvedModules.filter(ref => ref.path === 'src/lib.rs').map(ref => ref.spec), ['std::collections::HashMap', 'std', 'crate::missing::Thing'])
  ok('Rust grouped/aliased use paths follow real module ownership; extern crates and missing modules stay unresolved')
  assert.deepEqual(edges(graph, 'load.py'), [['util.py', 3, 'python_dynamic'], ['pkg/helper.py', 4, 'python_dynamic'], ['pkg/helper.py', 5, 'python_dynamic']])
  assert.deepEqual(edges(graph, 'shadow.py'), [])
  assert.deepEqual(edges(graph, 'shadow-context.py'), [])
  assert.deepEqual(edges(graph, 'shadow-comprehension.py'), [])
  assert.ok(graph.unresolvedModules.some(ref => ref.path === 'load.py' && ref.spec === 'name'))
  ok('Python literal dynamic imports use confirmed importlib aliases and package arguments; shadows and arbitrary methods do not link')
  assert.deepEqual(edges(graph, 'consumer.ts'), [['types/virtual.d.ts', 1, 'import']])
  ok('TypeScript ambient module declaration resolves a bare module name')
  assert.deepEqual(edges(graph, 'go/main.go'), [['go/helper/a.go', 2, 'go_import (module candidate)'], ['go/helper/b.go', 2, 'go_import (module candidate)']])
  assert.ok(!edges(graph, 'go/main.go').some(([to]) => to.endsWith('_test.go')))
  ok('Go module imports include all non-test package members with build-candidate labels')
  assert.deepEqual(edges(graph, 'java/p/Main.java'), [['java/p/Helper.java', 2, 'java_import'], ['java/p/Util.java', 3, 'java_import']])
  ok('Java explicit and static imports resolve by package and declared class')
  assert.deepEqual(edges(graph, 'lua/main.lua'), [['lib/helper.lua', 1, 'lua_require (module candidate)'], ['lib/other/init.lua', 2, 'lua_require (module candidate)']])
  assert.deepEqual(edges(graph, 'lua/shadow.lua'), [])
  assert.deepEqual(edges(graph, 'lua/global-shadow.lua'), [])
  assert.deepEqual(edges(graph, 'lua/raw-shadow.lua'), [])
  ok('Lua literal and shorthand require follow conventional root paths; rebound loaders and dynamic names never link')
  assert.equal((await assembleTraceGraph(root)).graph, graph)
  put('go.mod', 'module renamed.local/demo\n')
  const renamed = await assembleTraceGraph(root)
  assert.notEqual(renamed.graph, graph)
  assert.deepEqual(edges(renamed.graph, 'go/main.go'), [])
  put('go.mod', 'module example.local/demo\n')
  put('other/duplicate.d.ts', 'declare module "virtual-probe" {}\n')
  put('other/Helper.java', 'package p; class Helper {}\n')
  const ambiguous = await assembleTraceGraph(root)
  assert.ok(!ambiguous.graph.rdeps.get('types/virtual.d.ts'))
  assert.deepEqual(edges(ambiguous.graph, 'java/p/Main.java'), [['java/p/Util.java', 3, 'java_import']])
  ok('Manifest edits invalidate the graph and duplicate Java/ambient identities never select an arbitrary file')
  fs.unlinkSync(path.join(root, 'other/duplicate.d.ts')); fs.unlinkSync(path.join(root, 'other/Helper.java'))
  const stable = await assembleTraceGraph(root)
  resetTraceFactsCache(); process.env.DSH_FORGE_AST_WORKERS = '2'
  assert.deepEqual(await assembleTraceGraph(root, { workers: pool }), stable)
  const result = await createTraceTool(pool).execute({ target: 'path:consumer.ts -> types/virtual.d.ts' }, exec)
  assert.equal(result.found, true); assert.equal(result.analysis.distance, 1)
  ok('Sequential and worker package graphs match, including path-query evidence')
  put('go/helper/go.mod', '// invalid manifest remains a nested module boundary\n')
  assert.deepEqual(edges((await assembleTraceGraph(root)).graph, 'go/main.go'), [])
  ok('An invalid nested Go manifest never leaks files into the parent module')
  const nested = Array(65).fill('m').join('/')
  put('limited/src/lib.rs', 'mod target;\n' + 'mod m { '.repeat(65) + 'mod leaf;' + ' }'.repeat(65))
  put(`limited/src/${nested}/leaf.rs`, 'use crate::target::Item;\n')
  put('limited/src/target.rs', 'pub struct Item;\n')
  const limited = await createTraceTool(pool).execute({ target: `path:limited/src/${nested}/leaf.rs -> limited/src/target.rs` }, exec)
  assert.equal(limited.found, false); assert.equal(limited.incomplete, true); assert.equal(limited.resolutionLimited, true)
  assert.equal(limited.parseErrors, 0); assert.equal(limited.partialFiles, 1) // invalid nested go.mod above
  ok('Rust ownership depth limits are reported and never claim complete negative dependency evidence')
} finally {
  await pool.dispose()
  if (previousWorkers === undefined) delete process.env.DSH_FORGE_AST_WORKERS; else process.env.DSH_FORGE_AST_WORKERS = previousWorkers
  assert.ok(path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forge-trace-packages-'))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
console.log(`${passed} Trace package groups passed`)
