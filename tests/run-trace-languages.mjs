/** File-level truth for Rust/Python/C/C++, plus scope preservation in batched JS calls. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, createTraceTool, resetTraceFactsCache } from '../lib/tools-trace.js'
import { AstWorkerPool } from '../lib/ast-pool.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-languages-'))
const previousWorkers = process.env.DSH_FORGE_AST_WORKERS
const pool = new AstWorkerPool()
let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)
const put = (rel, source = '') => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '\uFEFF' + source.replaceAll('\n', '\r\n'))
}
const encodeEdges = (graph, file) => (graph.deps.get(file) ?? []).map(edge => [edge.to, edge.line, edge.kind])
const exec = { agent: { session: { header: { cwd: root } } } }
try {
  process.env.DSH_FORGE_AST_WORKERS = '0'
  put('outer/pkg/__init__.py', 'from .service import Service\n')
  put('outer/pkg/service.py', [
    'import os', 'import util as u', 'from . import helper as h', 'from ..shared import api',
    'from external_pkg import thing', 'from .missing import nope', '# import ghost',
    'text = "from ..fake import x"', 'def local():', '    from .helper import value',
    'from ...outside import nope',
  ].join('\n') + '\n')
  put('outer/pkg/helper.py', 'value = 1\n')
  put('outer/shared/__init__.py')
  put('outer/shared/api.py', 'value = 3\n')
  put('pkg/top.py', 'from ..shared import api\nfrom ...util import value\n')
  put('top_level.py', 'from .util import value\n')
  put('util.py', 'value = 2\n')
  put('shared/__init__.py')
  put('shared/api.py', 'value = 3\n')
  put('stubs.pyi', 'def run() -> int: ...\n')
  put('stub_user.py', 'import stubs\n')
  put('native/main.cpp', [
    '#include "local.h"', '#include "../shared/shared.h"', '#include <system.h>', '#include HEADER',
    '// #include "fake.h"', 'const char *s = "#include fake";', '#if FEATURE',
    '#include "conditional.h"', '#endif', '#include "later.inc"', '#include "root_only.h"',
  ].join('\n') + '\n')
  put('native/local.h', '#include "conditional.h"\n')
  put('native/conditional.h')
  put('native/plain.c', '#include "local.h"\n')
  put('shared/shared.h')
  put('system.h')
  put('root_only.h')
  put('src/lib.rs', [
    'mod feature;', 'mod other;', 'mod inline { pub mod child; }', '#[path = "alt/renamed.rs"]',
    'mod named;', 'include!("generated.rs");', 'include_str!("data.txt");',
    'include!(concat!(env!("OUT_DIR"), "/other.rs"));', 'mod both;', 'mod missing;',
    '// mod fake;', 'const TEXT: &str = "mod pretend;";', 'include_bytes!(r#"raw.txt"#);',
    'include_str!("data\\x2Etxt");', 'std::include_bytes!("raw\\u{2e}txt");',
    '::core::include_str!(r"raw.txt");', 'other::include_str!("raw.txt");',
  ].join('\n') + '\n')
  put('src/feature.rs', [
    'pub mod nested;', '#[path = "custom.rs"]', 'pub mod custom;', 'mod inner { pub mod nested; }',
    'include!("fragment.rs");', '#[path = "elsewhere"] mod attributed { mod hidden; }',
    '#[cfg_attr(feature = "alt", path = "custom.rs")]', 'mod conditional;',
  ].join('\n') + '\n')
  for (const rel of ['src/feature/nested.rs', 'src/custom.rs', 'src/feature/inner/nested.rs',
    'src/fragment.rs', 'src/feature/attributed/hidden.rs', 'src/feature/conditional.rs',
    'src/other/mod.rs', 'src/inline/child.rs', 'src/alt/renamed.rs', 'src/generated.rs',
    'src/both.rs', 'src/both/mod.rs', 'src/data.txt', 'src/raw.txt']) put(rel)
  const crateEntries = [
    ['src/bin/cli/main.rs', 'src/bin/cli/helper.rs'],
    ['examples/demo/main.rs', 'examples/demo/helper.rs'],
    ['tests/integration/main.rs', 'tests/integration/helper.rs'],
    ['benches/speed/main.rs', 'benches/speed/helper.rs'],
    ['src/bin/tool.rs', 'src/bin/helper.rs'], ['examples/run.rs', 'examples/helper.rs'],
    ['tests/check.rs', 'tests/helper.rs'], ['benches/probe.rs', 'benches/helper.rs'],
  ]
  for (const [entry, helper] of crateEntries) { put(entry, 'mod helper;\n'); put(helper) }
  put('build.rs', 'mod child;\n')
  put('child.rs')
  put('workspace/member/Cargo.toml', '[package]\nname = "member"\nversion = "0.1.0"\n')
  put('workspace/member/build.rs', 'mod child;\n')
  put('workspace/member/child.rs')
  put('workspace/member/build/child.rs')
  put('src/build.rs', 'mod child;\n')
  put('src/build/child.rs')
  put('src/child.rs') // plausible but incorrect target for a normal build module
  put('wrappers.js', [
    'function dual(ch) { ipcRenderer.send(ch); ipcMain.handle(ch, () => {}); }',
    'const named = (ch) => { function nested(other) { ipcMain.handle(other, () => {}); } nested("nested"); ipcMain.on(ch, () => {}); };',
    'dual("dual"); named("named");',
    'function owner(ch) { [1].map(function() { ipcRenderer.invoke(ch); }); } owner("inherited");',
    'function destructured({ch}) { ipcRenderer.invoke(ch); } destructured("destructured");',
  ].join('\n') + '\n')
  put('push-only.js', 'function broadcast(ch) { target.webContents.send(ch); } broadcast("broadcast");\n')
  put('forwarder.js', [
    'const { dual } = require("./wrappers.js");', 'dual("forwarded");',
    'const entries = { withoutIpcToken: dual("named-forwarded") };',
  ].join('\n') + '\n')
  put('.gitignore', 'ignored/\n')
  put('ignored/miss.py', 'from . import ghost\n')
  put('unsupported.cs', 'class Unsupported {}\n')
  put('loader.js', 'require("./native/main.cpp");\n')
  put('page.html', '<script src="loader.js"></script>')

  const first = await assembleTraceGraph(root)
  const graph = first.graph
  assert.equal(first.parseErrors, 0)
  assert.equal(first.partialFiles, 0)
  assert.equal(first.truncated, false)
  const sourceTruth = new Map()
  const expectEdges = (file, expected) => {
    sourceTruth.set(file, expected)
    assert.deepEqual(encodeEdges(graph, file), expected, file)
  }
  expectEdges('outer/pkg/service.py', [
    ['util.py', 2, 'python_import'], ['outer/pkg/__init__.py', 3, 'python_from'],
    ['outer/pkg/helper.py', 3, 'python_from (submodule candidate)'], ['outer/shared/__init__.py', 4, 'python_from'],
    ['outer/shared/api.py', 4, 'python_from (submodule candidate)'], ['outer/pkg/helper.py', 10, 'python_from'],
  ])
  expectEdges('outer/pkg/__init__.py', [['outer/pkg/service.py', 1, 'python_from']])
  expectEdges('stub_user.py', [['stubs.pyi', 1, 'python_import']])
  expectEdges('pkg/top.py', [])
  expectEdges('top_level.py', [])
  assert.deepEqual(graph.unresolvedModules.filter(ref => ref.path === 'pkg/top.py').map(ref => ref.spec), ['..shared', '...util'])
  assert.deepEqual(graph.unresolvedModules.filter(ref => ref.path === 'top_level.py').map(ref => ref.spec), ['.util'])
  assert.deepEqual(graph.unresolvedModules.filter(ref => ref.path === 'outer/pkg/service.py').map(ref => ref.spec),
    ['os', 'external_pkg', '.missing', '...outside'])
  assert.ok(!graph.files.has('ignored/miss.py') && !graph.files.has('unsupported.cs'))
  ok('Python aliases, package/from/relative/nested imports and stubs have exact edges and normalized lines')

  expectEdges('native/main.cpp', [
    ['native/local.h', 1, 'c_include'], ['shared/shared.h', 2, 'c_include'], ['native/conditional.h', 8, 'c_include'],
  ])
  expectEdges('native/plain.c', [['native/local.h', 1, 'c_include']])
  expectEdges('native/local.h', [['native/conditional.h', 1, 'c_include']])
  assert.deepEqual(graph.unresolvedModules.filter(ref => ref.path === 'native/main.cpp').map(ref => ref.spec),
    ['system.h', 'HEADER', 'later.inc', 'root_only.h'])
  assert.ok(![...graph.deps.values()].flat().some(edge => edge.to.includes('fake') || edge.to.startsWith('../')))
  assert.ok(graph.membership.has('native/main.cpp'))
  assert.ok(!graph.membership.has('native/local.h'), 'compile dependencies must not become page executions')
  const page = await createTraceTool(pool).execute({ target: 'page:page.html' }, exec)
  assert.match(page.text, /依赖闭包 1 个文件/)
  assert.match(page.text, /页面共加载 2 个本地文件/)
  ok('C/C++ quoted includes resolve relative files; comments, strings, system paths and macro includes never create false edges')

  expectEdges('src/lib.rs', [
    ['src/feature.rs', 1, 'rust_mod'], ['src/other/mod.rs', 2, 'rust_mod'], ['src/inline/child.rs', 3, 'rust_mod'],
    ['src/alt/renamed.rs', 5, 'rust_mod'], ['src/generated.rs', 6, 'rust_include'],
    ['src/data.txt', 7, 'rust_include'], ['src/raw.txt', 13, 'rust_include'],
    ['src/data.txt', 14, 'rust_include'], ['src/raw.txt', 15, 'rust_include'], ['src/raw.txt', 16, 'rust_include'],
  ])
  expectEdges('src/feature.rs', [
    ['src/feature/nested.rs', 1, 'rust_mod'], ['src/custom.rs', 3, 'rust_mod'],
    ['src/feature/inner/nested.rs', 4, 'rust_mod'], ['src/fragment.rs', 5, 'rust_include'],
  ])
  assert.deepEqual(graph.unresolvedModules.filter(ref => ref.path === 'src/lib.rs').map(ref => ref.spec),
    ['(concat!(env!("OUT_DIR"), "/other.rs"))', 'both', 'missing'])
  assert.deepEqual(graph.unresolvedModules.filter(ref => ref.path === 'src/feature.rs').map(ref => ref.spec), ['hidden', 'conditional'])
  for (const [entry, helper] of crateEntries) expectEdges(entry, [[helper, 1, 'rust_mod']])
  expectEdges('build.rs', [['child.rs', 1, 'rust_mod']])
  expectEdges('workspace/member/build.rs', [['workspace/member/child.rs', 1, 'rust_mod']])
  expectEdges('src/build.rs', [['src/build/child.rs', 1, 'rust_mod']])
  ok('Rust module layouts, nested scopes, path attributes and literal/raw includes resolve; ambiguous or conditional paths stay unresolved')

  const truth = [...sourceTruth].flatMap(([from, edges]) => edges.map(edge => JSON.stringify([from, ...edge]))).sort()
  const actual = [...graph.deps].filter(([from]) => graph.files.get(from)?.kind === 'source')
    .flatMap(([from, edges]) => edges.map(edge => JSON.stringify([from, edge.to, edge.line, edge.kind]))).sort()
  assert.equal(truth.length, 38)
  assert.deepEqual(actual, truth, 'all source edges, including files with no dependencies, must match handwritten truth')
  ok(`handwritten source oracle: ${truth.length} TP / 0 FN / 0 FP across Python, Rust and C/C++`)

  assert.equal(graph.directCalls.get('dual')[0].method, 'send')
  assert.equal(graph.registers.get('named')[0].method, 'on')
  assert.equal(graph.registers.get('nested')[0].method, 'handle')
  for (const name of ['inherited', 'destructured']) assert.equal(graph.directCalls.get(name)[0].method, 'invoke')
  assert.equal(graph.pushes.get('broadcast')[0].via, 'wrapper')
  for (const name of ['forwarded', 'named-forwarded']) assert.equal(graph.directCalls.get(name)[0].via, 'wrapper')
  assert.equal(graph.namedEntries.get('withoutIpcToken')[0].channel, 'named-forwarded')
  ok('batched wrapper discovery preserves first forwarding call, named/nested/anonymous scope and destructured parameters')

  const warm = await assembleTraceGraph(root)
  assert.equal(warm.graph, graph)
  put('native/later.inc', '// materialized non-source include\n')
  const added = await assembleTraceGraph(root)
  assert.notEqual(added.graph, graph)
  assert.ok(added.graph.deps.get('native/main.cpp').some(edge => edge.to === 'native/later.inc'))
  for (const asset of ['src/data.txt', 'src/raw.txt', 'native/later.inc']) {
    const result = await createTraceTool(pool).execute({ target: `file:${asset}` }, exec)
    assert.equal(result.found, true, asset)
    assert.match(result.text, /被源码引用，内容未解析/)
    assert.match(result.text, /←/)
    assert.doesNotMatch(result.text, /IPC 注册/)
  }
  put('unreferenced.txt')
  assert.equal((await createTraceTool(pool).execute({ target: 'file:unreferenced.txt' }, exec)).found, false)
  fs.unlinkSync(path.join(root, 'native/later.inc'))
  const removed = await assembleTraceGraph(root)
  assert.ok(!removed.graph.deps.get('native/main.cpp').some(edge => edge.to === 'native/later.inc'))
  assert.ok(removed.graph.rdeps.get('outer/pkg/helper.py').some(ref => ref.path === 'outer/pkg/service.py' && ref.line === 3))
  fs.unlinkSync(path.join(root, 'workspace/member/Cargo.toml'))
  const noManifest = await assembleTraceGraph(root)
  assert.notEqual(noManifest.graph, removed.graph)
  assert.deepEqual(encodeEdges(noManifest.graph, 'workspace/member/build.rs'), [['workspace/member/build/child.rs', 1, 'rust_mod']])
  put('workspace/member/Cargo.toml', '[package]\nname = "member"\nversion = "0.1.0"\n')
  const restoredManifest = await assembleTraceGraph(root)
  assert.deepEqual(encodeEdges(restoredManifest.graph, 'workspace/member/build.rs'), [['workspace/member/child.rs', 1, 'rust_mod']])
  ok('source reverse edges and cached asset/Cargo manifest existence probes follow additions and removals')

  resetTraceFactsCache()
  process.env.DSH_FORGE_AST_WORKERS = '2'
  assert.deepEqual(await assembleTraceGraph(root, { workers: pool }), removed)
  const result = await createTraceTool(pool).execute({ target: 'file:src/lib.rs' }, exec)
  assert.equal(result.found, true)
  assert.equal(result.incomplete, false)
  assert.match(result.text, /rust 静态文件依赖/)
  assert.match(result.text, /src\/feature\.rs/)
  assert.match(result.text, /未解析的导入/)
  assert.doesNotMatch(result.text, /IPC 注册/)
  ok('sequential and worker results match completely, and source-file Trace exposes useful dependencies with explicit limits')

  put('broken.py', 'from pkg import helper\ndef broken(:\n')
  const partial = await createTraceTool(pool).execute({ target: 'file:broken.py' }, exec)
  assert.equal(partial.found, true)
  assert.ok(partial.partialFiles >= 1)
  assert.equal(partial.incomplete, true)
  ok('partial parsing in a newly supported language is visible in tool coverage')
} finally {
  await pool.dispose()
  if (previousWorkers === undefined) delete process.env.DSH_FORGE_AST_WORKERS
  else process.env.DSH_FORGE_AST_WORKERS = previousWorkers
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('forge-trace-languages-'))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
console.log(`${passed} Trace language groups passed`)
