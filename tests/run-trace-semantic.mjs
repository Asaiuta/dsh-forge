/** Handwritten static relationships, with decoys and independently expected edges. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, createTraceTool, resetTraceFactsCache } from '../lib/tools-trace.js'
import { AstWorkerPool } from '../lib/ast-pool.js'
import { sameGraphExceptSnapshot } from './lib/snapshot-compare.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-semantic-'))
const previous = process.env.DSH_FORGE_AST_WORKERS, pool = new AstWorkerPool()
const put = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const edges = (graph, file) => (graph.deps.get(file) ?? []).map(ref => [ref.to, ref.line, ref.kind])
const types = (graph, file) => edges(graph, file).filter(ref => ref[2].startsWith('java_type'))
const candidate = kind => kind + ' (module candidate)'
const exec = { agent: { session: { header: { cwd: root } } } }
let passed = 0
const ok = message => console.log(`ok ${++passed} - ${message}`)
try {
  process.env.DSH_FORGE_AST_WORKERS = '0'
  for (const name of ['Base', 'Face', 'Helper', 'Failure']) put(`java/p/${name}.java`, `package p; ${name === 'Face' ? 'interface' : 'class'} ${name} {}\n`)
  put('java/q/Ext.java', 'package q; public class Ext {}\n')
  put('java/q/Outer.java', 'package q; public class Outer { public static class Inner {} }\n')
  put('java/p/Main.java', [
    'package p;',
    'import q.Ext;',
    'import q.Outer.Inner;',
    'class Main<T extends Helper> extends Base implements Face {',
    '  Helper field;',
    '  <U extends Helper> Helper method(Ext external, U generic, Inner nested) throws Failure {',
    '    T variable = null;',
    '    return new Helper();',
    '  }',
    '}',
  ].join('\n'))
  put('java/p/Entry.java', 'package p; record Entry(Helper value) implements Face {}\n')
  put('java/p/Shadow.java', 'package p; import q.Ext; class Shadow<Helper> { Helper field; <Ext> Ext run(Ext value) { return value; } }\n')
  put('java/p/Holder.java', 'package p; class Holder { class Helper {} Helper field; }\n')
  put('java/p/Local.java', 'package p; class Local { void run() { class Helper {} Helper value; } }\n')
  put('java/q/Inheritance.java', 'package q; public class Inheritance { public static class Helper {} }\n')
  put('java/p/Derived.java', 'package p; class Derived extends q.Inheritance { Helper field; }\n')
  put('java/p/Imported.java', 'package p; import static q.Inheritance.Helper; class Imported { Helper field; }\n')
  put('java/p/Unknown.java', 'package p; class Unknown extends external.Unavailable { Helper field; }\n')
  put('java/p/Anonymous.java', 'package p; class Anonymous { Object field = new Object() { class Helper {} Helper member; }; }\n')
  put('java/q/PrivateBase.java', 'package q; public class PrivateBase { private static class Helper {} }\n')
  put('java/p/PrivateDerived.java', 'package p; class PrivateDerived extends q.PrivateBase { Helper field; }\n')
  put('java/p/AnonymousInherited.java', 'package p; class AnonymousInherited { Object field = new q.Inheritance() { Helper member; }; }\n')
  for (const pkg of ['x', 'y']) put(`java/${pkg}/Shared.java`, `package ${pkg}; public class Shared {}\n`)
  put('java/w/Wild.java', 'package w; import x.*; import y.*; class Wild { Shared field; }\n')
  put('java/w/Explicit.java', 'package w; import x.Shared; import y.*; class Explicit { Shared field; }\n')
  put('modules/core/module-info.java', 'module app.core { exports service; }\n')
  put('modules/core/service/Api.java', 'package service; public interface Api {}\n')
  put('modules/app/module-info.java', [
    'open module app.main {',
    ' requires transitive app.core;',
    ' exports app.impl to client.app;',
    ' opens app.secret;',
    ' uses service.Api;',
    ' provides service.Api with app.impl.Service;',
    '}',
  ].join('\n'))
  put('modules/app/impl/Service.java', 'package app.impl; public class Service implements service.Api {}\n')
  put('modules/app/secret/Private.java', 'package app.secret; class Private {}\n')
  put('modules/app/nested/module-info.java', 'module app.nested {}\n')
  put('modules/app/nested/Other.java', 'package app.impl; class Other {}\n')
  put('cpp/core.cppm', ['module;', 'export module engine.core;', 'export import :part;', 'import platform;', 'import "config.hpp";', 'import <system.hpp>;', 'module :private;'].join('\n'))
  put('cpp/part.cppm', 'export module engine.core:part;\n')
  put('cpp/platform.ixx', 'export module platform;\n')
  put('cpp/impl.cpp', 'module engine.core;\nimport :part;\n')
  put('cpp/internal.cppm', 'module engine.core:internal;\nint internal();\n')
  put('cpp/entry.cpp', 'import engine.core;\n')
  put('cpp/config.hpp', '// config\n')
  put('sdk/system.hpp', '// SDK header\n')
  put('cpp/orphan.cpp', 'import :part;\n')
  put('cpp/foreign.cpp', 'module consumer;\nimport engine.core:part;\n')
  put('cpp/decoys.cpp', [
    '#define REGISTER export module fake;',
    'const char *raw = R"tag(',
    'export module fake;',
    'import platform;',
    ')tag";',
    'const int n = 1\'000;',
    'void run() { import platform; }',
    '// comment continues \\',
    'import platform;',
    '/* import platform; */',
    'export module actual;',
  ].join('\n'))
  put('cpp/broken.cppm', 'export module bad name;\n')
  put('cpp/needs-bad.cpp', 'import badname;\n')
  put('cpp/spliced.cppm', '/\\\n/ comment; export module ghost;\nexport mo\\\ndule spliced;\n')
  put('cpp/needs-spliced.cpp', 'import ghost;\nimport spliced;\n')
  put('cpp/spanning.cppm', 'int x; /* spanning\n*/ #define HIDDEN 0; export module spanningghost;\n')
  put('cpp/needs-spanning.cpp', 'import spanningghost;\n')
  put('cpp/spliced-only.cppm', 'export mo\\\ndule splicedonly;\n')
  put('cpp/needs-spliced-only.cpp', 'import splicedonly;\n')
  put('cpp/raw-spliced.cppm', 'const char* raw = R"tag(raw )ta\\\ng"; export module rawghost; )tag";\n')
  put('cpp/needs-raw.cpp', 'import rawghost;\n')
  put('cpp/digraph.cppm', '%:define HIDDEN 0; export module digraphghost;\nstruct import {}; void run() <% int x; import platform; %>\n')
  put('cpp/needs-digraph.cpp', 'import digraphghost;\n')
  put('cpp/contextual.cpp', 'struct import {}; import platform;\nstruct module {}; module engine.core;\n')
  put('cpp/MACRO.cppm', 'export module MACRO;\n')
  put('cpp/known-macro.cpp', '#define MACRO actual\nimport MACRO;\n')
  put('cpp/macro-provider.cppm', '#define PROVIDER platform\nexport module PROVIDER;\n')
  put('cpp/needs-provider.cpp', 'import PROVIDER;\n')
  put('cpp/keyword-macro.cpp', '#define import custom_type\nimport platform;\n')
  put('go/local.h', '// cgo local header\n')
  put('go/main.go', [
    'package main',
    '// #cgo CFLAGS: -I${SRCDIR}/../sdk',
    '// #include "local.h"',
    '// #include <system.hpp>',
    '// /*',
    '// #include "decoy.h"',
    '// */',
    'import "C"',
    'func main() {}',
  ].join('\n'))
  put('go/decoy.h', '// exists but only mentioned inside a C comment\n')
  put('go/separated.go', 'package main\n// #include "decoy.h"\n\nimport "C"\n')
  put('go/grouped.go', 'package main\n// #include "decoy.h"\nimport ("C")\n')
  put('go/block.go', 'package main\n/*\n#include "local.h"\n*/\nimport "C"\n')
  put('go/ordinary.go', 'package main\n// #include "decoy.h"\nimport "fmt"\n')
  put('go/trailing-package.go', 'package main // #include "decoy.h"\nimport "C"\n')
  put('go/trailing-import.go', 'package main\nimport "fmt" // #include "decoy.h"\nimport "C"\n')
  put('cpp/addon.cpp', [
    'NODE_MODULE(legacy, Init);',
    'NODE_MODULE_CONTEXT_AWARE(contextual, Initialize);',
    'NODE_MODULE_LINKED(linked, Init);',
    'NAPI_MODULE_X(extended, Init, 0, 0);',
    '#define REGISTER(name) NODE_MODULE(decoy, Init)',
    'void run() { obj.NODE_MODULE(method_decoy, Init); }',
  ].join('\n'))
  put('compile_commands.json', JSON.stringify([{ directory: root, file: 'cpp/core.cppm', arguments: ['c++', '-std=c++20', '-I', 'sdk', '-c', 'cpp/core.cppm'] }]))
  const scan = await assembleTraceGraph(root), graph = scan.graph
  assert.equal(scan.parseErrors, 0)
  assert.deepEqual(types(graph, 'java/p/Main.java'), [
    ['java/p/Helper.java', 4, candidate('java_type:bound')],
    ['java/p/Base.java', 4, candidate('java_type:extends')],
    ['java/p/Face.java', 4, candidate('java_type:implements')],
    ['java/p/Helper.java', 5, candidate('java_type:field')],
    ['java/p/Helper.java', 6, candidate('java_type:bound')],
    ['java/p/Helper.java', 6, candidate('java_type:return')],
    ['java/q/Ext.java', 6, candidate('java_type:parameter')],
    ['java/q/Outer.java', 6, candidate('java_type:parameter')],
    ['java/p/Failure.java', 6, candidate('java_type:throws')],
    ['java/p/Helper.java', 8, candidate('java_type:construction')],
  ])
  assert.deepEqual(types(graph, 'java/p/Entry.java'), [['java/p/Helper.java', 1, candidate('java_type:parameter')], ['java/p/Face.java', 1, candidate('java_type:implements')]])
  ok('Java generic bounds, inheritance, interfaces, fields, parameters, returns, throws, construction and record components carry source lines and roles')
  for (const file of ['Shadow', 'Holder', 'Local']) assert.deepEqual(types(graph, `java/p/${file}.java`), [], file)
  assert.ok(!graph.unresolvedModules.some(ref => ref.path === 'java/p/Holder.java' && ref.spec === 'Helper'))
  ok('Type parameters, nested member types and local classes never acquire a same-name external file edge')
  assert.deepEqual(types(graph, 'java/w/Wild.java'), [])
  assert.deepEqual(types(graph, 'java/w/Explicit.java'), [['java/x/Shared.java', 1, candidate('java_type:field')]])
  assert.deepEqual(graph.files.get('java/q/Outer.java').moduleInfo.javaTypes, ['Outer', 'Outer.Inner'])
  ok('Explicit imports resolve nested types; conflicting wildcard type candidates do not choose the first match')
  assert.deepEqual(types(graph, 'java/p/Derived.java'), [['java/q/Inheritance.java', 1, candidate('java_type:extends')]])
  assert.deepEqual(types(graph, 'java/p/Imported.java'), [['java/q/Inheritance.java', 1, candidate('java_type:field')]])
  assert.deepEqual(types(graph, 'java/p/Unknown.java'), [])
  assert.deepEqual(types(graph, 'java/p/PrivateDerived.java'), [['java/q/PrivateBase.java', 1, candidate('java_type:extends')]])
  assert.deepEqual(types(graph, 'java/p/Anonymous.java'), [])
  assert.deepEqual(types(graph, 'java/p/AnonymousInherited.java'), [['java/q/Inheritance.java', 1, candidate('java_type:construction')]])
  ok('Static type imports precede same-package types; inherited member names, private members, unknown parents and anonymous types block unsafe fallback')
  assert.deepEqual(edges(graph, 'modules/app/module-info.java'), [
    ['modules/core/module-info.java', 2, candidate('java_requires')],
    ['modules/app/impl/Service.java', 3, candidate('java_package:exports')],
    ['modules/app/secret/Private.java', 4, candidate('java_package:opens')],
    ['modules/core/service/Api.java', 5, candidate('java_type:uses')],
    ['modules/core/service/Api.java', 6, candidate('java_type:provides')],
    ['modules/app/impl/Service.java', 6, candidate('java_type:provides')],
  ])
  ok('Java module-info relates unique requires descriptors, owned exported/open packages and service types without pretending to link modules')
  assert.deepEqual(edges(graph, 'cpp/core.cppm'), [
    ['cpp/part.cppm', 3, candidate('cpp_import')],
    ['cpp/platform.ixx', 4, candidate('cpp_import')],
    ['cpp/config.hpp', 5, candidate('cpp_header')],
    ['sdk/system.hpp', 6, candidate('cpp_header')],
  ])
  assert.deepEqual(edges(graph, 'cpp/impl.cpp'), [['cpp/core.cppm', 1, candidate('cpp_implementation')], ['cpp/part.cppm', 2, candidate('cpp_import')]])
  assert.deepEqual(edges(graph, 'cpp/internal.cppm'), [])
  assert.deepEqual(edges(graph, 'cpp/orphan.cpp'), []); assert.deepEqual(edges(graph, 'cpp/foreign.cpp'), [])
  ok('C++ named interfaces, implementation units, same-module partitions and compile-command header units form labeled candidates')
  assert.deepEqual(graph.files.get('cpp/decoys.cpp').moduleInfo.cppModules, [{ name: 'actual', interface: true, line: 11 }])
  assert.deepEqual(edges(graph, 'cpp/decoys.cpp'), []); assert.deepEqual(edges(graph, 'cpp/needs-bad.cpp'), [])
  assert.deepEqual(graph.files.get('cpp/spliced.cppm').moduleInfo.cppModules, [{ name: 'spliced', interface: true, line: 3 }])
  assert.deepEqual(edges(graph, 'cpp/needs-spliced.cpp'), [['cpp/spliced.cppm', 2, candidate('cpp_import')]])
  assert.deepEqual(edges(graph, 'cpp/needs-spanning.cpp'), [])
  assert.deepEqual(edges(graph, 'cpp/needs-spliced-only.cpp'), [['cpp/spliced-only.cppm', 1, candidate('cpp_import')]])
  assert.deepEqual(edges(graph, 'cpp/needs-raw.cpp'), [])
  assert.deepEqual(edges(graph, 'cpp/needs-digraph.cpp'), []); assert.deepEqual(edges(graph, 'cpp/digraph.cppm'), [])
  assert.deepEqual(edges(graph, 'cpp/contextual.cpp'), [])
  for (const file of ['known-macro.cpp', 'needs-provider.cpp', 'keyword-macro.cpp']) assert.deepEqual(edges(graph, `cpp/${file}`), [])
  assert.ok(scan.partialFiles > 0, 'old C++ grammar errors must remain visible')
  ok('C++ module scanning ignores macros, raw strings, functions, continued comments and malformed adjacent names while retaining grammar partial flags')
  assert.deepEqual(edges(graph, 'go/main.go'), [['go/local.h', 3, candidate('cgo_include')]])
  assert.deepEqual(edges(graph, 'go/block.go'), [['go/local.h', 3, candidate('cgo_include')]])
  for (const file of ['separated', 'grouped', 'ordinary', 'trailing-package', 'trailing-import']) assert.deepEqual(edges(graph, `go/${file}.go`), [])
  assert.ok(graph.unresolvedModules.some(ref => ref.path === 'go/main.go' && ref.spec === 'system.hpp'))
  ok('Only attached standalone cgo preambles add local literal include candidates; C comments, separated groups and CFLAGS search guesses do not link')
  for (const name of ['legacy', 'contextual', 'linked']) assert.ok(graph.ffi.get(name).some(ref => ref.abi === 'Node' && ref.kind === 'module-registration'))
  assert.ok(graph.ffi.get('extended').some(ref => ref.abi === 'N-API'))
  assert.ok(!graph.ffi.has('decoy') && !graph.ffi.has('method_decoy'))
  ok('Node legacy/context-aware/linked and extended N-API registration macros remain syntax evidence and exclude macro definitions/member calls')
  const tool = createTraceTool()
  const route = await tool.execute({ target: 'path:cpp/impl.cpp -> cpp/config.hpp' }, exec)
  assert.equal(route.found, true); assert.equal(route.analysis.distance, 2); assert.equal(route.incomplete, true)
  const impact = await tool.execute({ target: 'impact:java/p/Base.java' }, exec)
  assert.equal(impact.found, true); assert.ok(impact.analysis.files.some(file => file.path === 'java/p/Main.java'))
  const ffi = await tool.execute({ target: 'ffi:contextual' }, exec); assert.equal(ffi.found, true)
  ok('Existing path/impact/ffi entry points consume new facts without a new tool or invented cross-language ABI edge')
  assert.equal((await assembleTraceGraph(root)).graph, graph)
  put('java/duplicate/Helper.java', 'package p; class Helper {}\n')
  put('cpp/duplicate.cppm', 'export module engine.core;\n')
  put('modules/duplicate/module-info.java', 'module app.core {}\n')
  const ambiguous = await assembleTraceGraph(root)
  assert.notEqual(ambiguous.graph, graph)
  assert.ok(!types(ambiguous.graph, 'java/p/Main.java').some(ref => ref[0].endsWith('/Helper.java')))
  assert.deepEqual(edges(ambiguous.graph, 'cpp/entry.cpp'), [])
  assert.ok(!edges(ambiguous.graph, 'modules/app/module-info.java').some(ref => ref[2].startsWith('java_requires')))
  ok('Adding duplicate Java types, module descriptors or C++ interfaces invalidates warm graphs and refuses arbitrary provider selection')
  for (const file of ['java/duplicate/Helper.java', 'cpp/duplicate.cppm', 'modules/duplicate/module-info.java']) fs.unlinkSync(path.join(root, file))
  const restored = await assembleTraceGraph(root)
  resetTraceFactsCache(); process.env.DSH_FORGE_AST_WORKERS = '2'
  sameGraphExceptSnapshot(await assembleTraceGraph(root, { workers: pool }), restored, 'worker vs sequential java/cpp facts')
  ok('Worker extraction and sequential extraction agree on all new facts and complete graph data after refresh')
  for (let i = 0; i <= 65; i++) put(`java/limited/P${i}.java`, `package limited; class P${i}${i < 65 ? ' extends P' + (i + 1) : ''} {}\n`)
  put('java/limited/Helper.java', 'package limited; class Helper {}\n')
  put('java/limited/Main.java', 'package limited; class Main extends P0 { Helper field; }\n')
  const limited = await createTraceTool(pool).execute({ target: 'path:java/limited/Main.java -> java/limited/Helper.java' }, exec)
  assert.equal(limited.found, false); assert.equal(limited.incomplete, true); assert.equal(limited.resolutionLimited, true)
  assert.match(limited.text, /Java/)
  ok('Deep Java inheritance reaches an explicit budget and cannot turn an incomplete member lookup into a same-package dependency')
} finally {
  await pool.dispose()
  if (previous === undefined) delete process.env.DSH_FORGE_AST_WORKERS; else process.env.DSH_FORGE_AST_WORKERS = previous
  assert.ok(path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forge-trace-semantic-'))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
console.log(`${passed} Trace semantic groups passed`)
