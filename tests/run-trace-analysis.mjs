/** New Trace queries and compilation metadata: hand-written graph and search-order truth. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, createTraceTool, resetTraceFactsCache } from '../lib/tools-trace.js'
import { traceImpact, tracePath } from '../lib/linkgraph.js'
import { AstWorkerPool } from '../lib/ast-pool.js'
import { apply } from '../lib/index.js'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-analysis-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-outside-'))
const previousWorkers = process.env.DSH_FORGE_AST_WORKERS
const pool = new AstWorkerPool()
let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)
const put = (rel, text = '') => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '\uFEFF' + text.replaceAll('\n', '\r\n'))
}
const edges = (assembled, from = 'native/main.cpp') => (assembled.graph.deps.get(from) ?? []).map(edge => [edge.to, edge.line, edge.kind])
const exec = { agent: { session: { header: { cwd: root } } } }
const run = (target, options = {}) => createTraceTool(pool).execute({ target, ...options }, exec)
const databasePath = path.join(root, 'compile_commands.json')
const writeDatabase = entries => fs.writeFileSync(databasePath, JSON.stringify(entries))
const entry = (args, file = 'native/main.cpp') => ({ directory: root, file, arguments: args })

try {
  process.env.DSH_FORGE_AST_WORKERS = '0'
  put('app/index.html', '<!doctype html>\n<script src="../ui.js"></script>\n')
  put('ui.js', 'require("./lib/a.js");\nrequire("./direct.js");\nimport(core);\n')
  put('direct.js', '// direct route\n\nrequire("./lib/core.js");\n')
  put('lib/a.js', 'require("./mid.js");\nrequire("../asset.txt");\n')
  put('lib/mid.js', 'require("./core.js");\n')
  put('lib/core.js', 'require("./cycle.js");\n')
  put('lib/cycle.js', 'require("./core.js");\n')
  put('holder.js', 'require("./core");\n')
  put('core', 'resource, deliberately named like an unresolved expression')
  put('orphan.js')
  put('asset.txt', 'data')
  put('src/lib.rs', 'mod feature;\n')
  put('src/feature.rs', 'include_str!("../asset.txt");\n')

  const base = await assembleTraceGraph(root)
  const impact = await run('impact:lib/core.js')
  assert.equal(impact.found, true)
  assert.equal(impact.analysis.complete, true)
  assert.deepEqual(impact.analysis.files.map(hit => [hit.path, hit.depth]).sort(), [
    ['direct.js', 1], ['lib/cycle.js', 1], ['lib/mid.js', 1], ['lib/a.js', 2], ['ui.js', 2], ['app/index.html', 3],
  ].sort())
  assert.deepEqual(impact.analysis.pages, ['app/index.html'])
  assert.equal(impact.analysis.edges.length, 6)
  assert.equal(impact.analysis.totalFiles, 6)
  assert.match(impact.text, /direct\.js:3/)
  assert.equal((await run('impact:orphan.js')).analysis.totalFiles, 0)
  assert.equal((await run('impact:missing.txt')).found, false)
  ok('impact finds all transitive importers, shortest distances and HTML pages without revisiting cycles')

  const route = await run('path:app/index.html -> lib/core.js')
  assert.equal(route.found, true)
  assert.equal(route.analysis.distance, 3)
  assert.deepEqual(route.analysis.edges, [
    { from: 'app/index.html', to: 'ui.js', line: 2, kind: 'html_script', evidence: { confidence: 'certain', basis: 'html_script' } },
    { from: 'ui.js', to: 'direct.js', line: 2, kind: 'require', evidence: { confidence: 'certain', basis: 'relative' } },
    { from: 'direct.js', to: 'lib/core.js', line: 3, kind: 'require', evidence: { confidence: 'certain', basis: 'relative' } },
  ])
  assert.equal((await run('path:lib/core.js -> app/index.html')).found, false, 'dependency direction matters')
  assert.equal((await run('path:lib/core.js -> lib/core.js')).analysis.distance, 0)
  assert.equal((await run('path:ui.js -> orphan.js')).found, false)
  assert.ok((await run('path:ui.js->lib/core.js')).error)
  assert.ok((await run('path:../outside.js -> ui.js')).error)
  assert.ok((await run('impact:../outside.js')).error)
  const absolute = await run(`path:${path.join(root, 'app/index.html')} -> ${path.join(root, 'asset.txt')}`)
  assert.equal(absolute.found, true)
  assert.equal(absolute.target, 'path:app/index.html -> asset.txt')
  ok('path returns a shortest directed route with normalized BOM/CRLF line evidence, and validates endpoints')

  assert.ok(base.graph.deps.get('ui.js').some(edge => edge.to === 'core'))
  assert.ok(base.graph.rdeps.has('core'), 'another file legitimately references this resource')
  assert.equal((await run('path:ui.js -> core')).found, false, 'an unresolved expression must not become a dependency')
  const assetImpact = await run('impact:asset.txt')
  assert.deepEqual(assetImpact.analysis.files.map(hit => hit.path).sort(), ['app/index.html', 'lib/a.js', 'ui.js', 'src/lib.rs', 'src/feature.rs'].sort())
  assert.deepEqual((await run('path:src/lib.rs -> asset.txt')).analysis.edges.map(edge => edge.kind), ['rust_mod', 'rust_include'])
  ok('queries exclude phantom dynamic edges and follow resource references across supported languages')

  put('expression.js', 'import(/regex/.source);\nrequire(/regex/.source);\nimport("./literal.js");\n')
  put('expression-page.html', '<script src="./expression.js"></script>\n')
  put('expression-holder.js', 'require("./regex/.source");\n')
  put('regex/.source', 'a real resource with the same spelling as expression source text')
  put('literal.js')
  const expression = await assembleTraceGraph(root)
  assert.equal((await run('path:expression.js -> regex/.source')).found, false)
  assert.equal((await run('impact:regex/.source')).analysis.files.some(file => file.path === 'expression.js'), false)
  assert.equal(expression.graph.rdeps.get('regex/.source').some(ref => ref.path === 'expression.js'), false)
  assert.equal(expression.graph.membership.has('regex/.source'), false)
  assert.deepEqual(expression.graph.unresolvedModules.filter(ref => ref.path === 'expression.js').map(ref => ref.line), [1, 2])
  assert.equal((await run('path:expression.js -> literal.js')).analysis.distance, 1, 'literal dynamic imports remain resolvable')
  ok('dynamic expression syntax cannot impersonate a resource in dependencies, paths, impact or page membership')

  put('inline/dependency.js', 'import "./leaf.js";\n')
  put('inline/leaf.js')
  put('inline/module.html', '<!doctype html>\n<script type="module">\nimport "./dependency.js";\n</script>\n<script>\nrequire("./leaf.js");\n</script>\n')
  const inline = await run('path:inline/module.html -> inline/dependency.js')
  assert.equal(inline.found, true)
  assert.deepEqual(inline.analysis.edges, [{ from: 'inline/module.html', to: 'inline/dependency.js', line: 3, kind: 'import', evidence: { confidence: 'certain', basis: 'relative' } }])
  const inlineRequire = await run('path:inline/module.html -> inline/leaf.js')
  assert.deepEqual(inlineRequire.analysis.edges, [{ from: 'inline/module.html', to: 'inline/leaf.js', line: 6, kind: 'require', evidence: { confidence: 'certain', basis: 'relative' } }])
  assert.deepEqual((await run('impact:inline/dependency.js')).analysis.pages, ['inline/module.html'])
  assert.ok((await assembleTraceGraph(root)).graph.membership.get('inline/dependency.js').has('inline/module.html'))
  if (process.platform === 'win32') {
    assert.equal((await run('path:INLINE/MODULE.HTML -> INLINE/DEPENDENCY.JS')).found, true)
    assert.equal((await run('impact:INLINE/DEPENDENCY.JS')).analysis.source, 'inline/dependency.js')
  }
  ok('HTML inline module imports and classic requires join the file graph with original line evidence')

  for (const file of ['classic.js', 'module.js', 'late.js']) put(`inline/${file}`)
  put('inline/order.html', '<script></script><script>require("./classic.js");</script><script type="module">import "./module.js";</script>\n<script\n data-note="x"\n type="module"\n>\nimport "./late.js";\n</script>\n')
  const ordered = await assembleTraceGraph(root)
  for (const [file, index] of [['classic.js', 2], ['module.js', 3], ['late.js', 4]]) {
    assert.deepEqual(ordered.graph.membership.get(`inline/${file}`).get('inline/order.html'), { index, direct: false })
  }
  assert.deepEqual(edges(ordered, 'inline/order.html'), [
    ['inline/classic.js', 1, 'require'], ['inline/module.js', 1, 'import'], ['inline/late.js', 6, 'import'],
  ])
  ok('inline dependencies retain the owning script across empty tags, shared lines and multiline opening tags')

  const large = { ...base.graph, files: new Map(), deps: new Map(), rdeps: new Map(), pages: new Map() }
  for (let n = 0; n < 20_010; n++) {
    const name = `cap_${n}.js`
    large.files.set(name, base.graph.files.get('orphan.js'))
    if (n) large.rdeps.set(name, [{ path: `cap_${n - 1}.js`, line: 1, kind: 'require', evidence: { confidence: 'certain', basis: 'relative' } }])
  }
  const limited = tracePath(large, 'cap_0.js -> cap_20009.js')
  assert.equal(limited.found, false)
  assert.equal(limited.analysis.complete, false)
  assert.match(limited.text, /不能判定不可达/)
  const longImpact = traceImpact(large, 'cap_20009.js')
  assert.equal(longImpact.analysis.visitedFiles, 20_000)
  assert.equal(longImpact.analysis.complete, false)
  assert.equal(longImpact.analysis.files.length, 100)
  const longRoute = tracePath(large, 'cap_0.js -> cap_150.js')
  assert.equal(longRoute.analysis.distance, 150)
  assert.equal(longRoute.analysis.complete, true)
  assert.equal(longRoute.analysis.truncated, true)
  assert.equal(longRoute.analysis.edges.length, 100)
  ok('traversal and output budgets are explicit; a capped negative answer never claims unreachability')

  put('native/main.cpp', '#include "pick.h"\n#include <shared.h>\n#include "quote.h"\n#include <quote.h>\n#include HEADER\n#include "late.inc"\n#include "local.h"\n')
  for (const file of ['quote/pick.h', 'quote/quote.h', 'include/one/pick.h', 'include/one/shared.h', 'include/two/shared.h', 'include/system/shared.h', 'native/local.h']) put(file)
  const args = ['clang++', '-iquote', 'quote', '-Iinclude/one', '-I', 'include/two', '-isystem', 'include/system', '-c', 'native/main.cpp']
  const noConfig = await assembleTraceGraph(root)
  assert.deepEqual(edges(noConfig), [['native/local.h', 7, 'c_include']])
  assert.equal(noConfig.compilation, undefined)
  writeDatabase([entry(args)])
  const configured = await assembleTraceGraph(root)
  assert.deepEqual(edges(configured), [
    ['quote/pick.h', 1, 'c_include'], ['include/one/shared.h', 2, 'c_include'], ['quote/quote.h', 3, 'c_include'], ['native/local.h', 7, 'c_include'],
  ])
  assert.deepEqual(configured.graph.unresolvedModules.filter(ref => ref.path === 'native/main.cpp').map(ref => ref.line), [4, 5, 6])
  assert.equal(configured.compilation.status, 'ok')
  assert.equal((await assembleTraceGraph(root)).graph, configured.graph)
  const configuredPath = await run('path:native/main.cpp -> include/one/shared.h')
  assert.equal(configuredPath.found, true)
  assert.equal(configuredPath.incomplete, false)
  writeDatabase([entry(['clang++', '-Iinclude/system', '-Iinclude/one', '-isystem', 'include/system', '-c', 'native/main.cpp'])])
  assert.ok(edges(await assembleTraceGraph(root)).some(([to, line]) => line === 2 && to === 'include/one/shared.h'), 'a duplicate -I/isystem directory retains its system position')
  writeDatabase([entry(args)])
  ok('compile_commands honors local/iquote/I/isystem ordering, quoted versus angular includes, and graph reuse')

  const systemAlias = path.join(root, 'system-alias')
  fs.symlinkSync(path.join(root, 'include/system'), systemAlias, process.platform === 'win32' ? 'junction' : 'dir')
  writeDatabase([entry(['clang++', '-Isystem-alias', '-Iinclude/one', '-isystem', 'include/system', '-c', 'native/main.cpp'])])
  const duplicateSystem = await assembleTraceGraph(root)
  assert.ok(edges(duplicateSystem).some(([to, line]) => line === 2 && to === 'include/one/shared.h'), 'a physical -I alias of -isystem must keep its system position')
  assert.ok(fs.lstatSync(systemAlias).isSymbolicLink() && path.dirname(path.resolve(systemAlias)) === root)
  fs.rmSync(systemAlias, { recursive: true, force: true })
  fs.symlinkSync(path.join(root, 'include/two'), systemAlias, process.platform === 'win32' ? 'junction' : 'dir')
  const changedSystemAlias = await assembleTraceGraph(root)
  assert.notEqual(changedSystemAlias.graph, duplicateSystem.graph)
  assert.ok(edges(changedSystemAlias).some(([to, line]) => line === 2 && to === 'system-alias/shared.h'), 'a retargeted alias must regain its normal include position')
  writeDatabase([entry(args)])
  ok('physical include aliases keep system search order and alias retargets invalidate cached precedence')

  for (const variable of ['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH', 'INCLUDE', 'SDKROOT']) {
    writeDatabase([entry(['env', `${variable}=include/two`, 'clang++', '-Iinclude/one', '-c', 'native/main.cpp'])])
    const environment = await run('file:native/main.cpp')
    assert.equal(environment.compilation.unsupported, 1, variable)
    assert.equal(environment.incomplete, true, variable)
    assert.deepEqual(edges(await assembleTraceGraph(root)), [], 'explicit include environment must not be silently ignored')
  }
  writeDatabase([{ directory: root, file: 'native/main.cpp', command: 'CPATH=include/two clang++ -Iinclude/one -c native/main.cpp' }])
  assert.equal((await run('file:native/main.cpp')).compilation.unsupported, 1)
  writeDatabase([entry(args)])
  ok('explicit path environment and env launchers remain unsupported instead of inventing include precedence')

  for (const forwarder of ['-Xassembler', '-Xlinker', '-Xclang', '-Xpreprocessor', '-mllvm', '-Xoffload-linker']) {
    writeDatabase([entry(['clang++', forwarder, '-Iinclude/two', '-Iinclude/one', '-c', 'native/main.cpp'])])
    const forwarded = await run('file:native/main.cpp')
    assert.equal(forwarded.compilation.unsupported, 1, forwarder)
    assert.equal(forwarded.incomplete, true, forwarder)
    assert.deepEqual(edges(await assembleTraceGraph(root)), [], `${forwarder} operand must not become an include flag`)
  }
  if (process.platform === 'win32') {
    writeDatabase([entry(['clang++', '-IINCLUDE/ONE', '-c', 'NATIVE/MAIN.CPP'], 'NATIVE/MAIN.CPP')])
    const caseGraph = await assembleTraceGraph(root)
    assert.ok(edges(caseGraph).some(([to, line]) => line === 2 && to === 'include/one/shared.h'))
    assert.equal(caseGraph.graph.rdeps.has('INCLUDE/ONE/shared.h'), false)
    assert.equal((await run('path:NATIVE/MAIN.CPP -> include/one/shared.h')).found, true)
    assert.equal((await run('path:native/main.cpp -> INCLUDE/ONE/SHARED.H')).found, true)
  }
  writeDatabase([entry(args)])
  ok('forwarded compiler operands stay unsupported and Windows database, include and query casing shares a file identity')

  const before = fs.statSync(databasePath)
  writeDatabase([entry(args.map(arg => arg === '-Iinclude/one' ? '-Iinclude/two' : arg))])
  assert.equal(fs.statSync(databasePath).size, before.size)
  fs.utimesSync(databasePath, before.atime, before.mtime)
  const replaced = await assembleTraceGraph(root)
  assert.notEqual(replaced.graph, configured.graph)
  assert.ok(edges(replaced).some(([to, line]) => line === 2 && to === 'include/two/shared.h'))
  writeDatabase([entry(args)])
  const restored = await assembleTraceGraph(root)
  put('include/one/late.inc')
  const added = await assembleTraceGraph(root)
  assert.notEqual(added.graph, restored.graph)
  assert.ok(edges(added).some(([to, line]) => line === 6 && to === 'include/one/late.inc'))
  fs.unlinkSync(path.join(root, 'include/one/late.inc'))
  assert.ok(!edges(await assembleTraceGraph(root)).some(([, line]) => line === 6))
  fs.unlinkSync(databasePath)
  assert.deepEqual(edges(await assembleTraceGraph(root)), [['native/local.h', 7, 'c_include']])
  ok('metadata content hashes and dependency probes invalidate restored-mtime edits, assets, database additions and removals')

  writeDatabase([entry(args), entry(args.map(arg => arg === '-Iinclude/one' ? '-Iinclude/two' : arg))])
  const variants = await assembleTraceGraph(root)
  assert.ok(!edges(variants).some(([, line]) => line === 2), 'conflicting configurations must not choose a winner')
  assert.ok(edges(variants).some(([, line]) => line === 7), 'configurations can agree on a local header')
  fs.writeFileSync(path.join(outside, 'shared.h'), '// outside root')
  writeDatabase([entry(['clang++', '-I', outside, '-Iinclude/one', '-c', 'native/main.cpp'])])
  const external = await assembleTraceGraph(root)
  assert.deepEqual(edges(external), [['native/local.h', 7, 'c_include']])
  assert.ok(![...external.graph.rdeps.keys()].some(file => file.startsWith('../')))
  ok('conflicting build variants and earlier external search directories stay unresolved instead of guessing a later local header')

  const alias = path.join(root, 'alias')
  fs.symlinkSync(path.join(root, 'include/one'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  writeDatabase([entry(['clang++', '-Ialias', '-c', 'native/main.cpp'])])
  const linked = await assembleTraceGraph(root)
  assert.ok(edges(linked).some(([to]) => to === 'alias/shared.h'))
  assert.ok(fs.lstatSync(alias).isSymbolicLink() && path.dirname(path.resolve(alias)) === root)
  fs.rmSync(alias, { recursive: true, force: true })
  fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const retargeted = await assembleTraceGraph(root)
  assert.notEqual(retargeted.graph, linked.graph)
  assert.ok(!edges(retargeted).some(([to]) => to === 'alias/shared.h'))
  ok('include directory identity is revalidated when an in-root junction retargets outside the workspace')

  put('link-a/index.js')
  put('link-b/index.js')
  put('link-user.js', 'require("./script-link/index.js");\n')
  const scriptLink = path.join(root, 'script-link')
  fs.symlinkSync(path.join(root, 'link-a'), scriptLink, process.platform === 'win32' ? 'junction' : 'dir')
  const firstScriptLink = await assembleTraceGraph(root)
  assert.ok(fs.lstatSync(scriptLink).isSymbolicLink() && path.dirname(path.resolve(scriptLink)) === root)
  fs.rmSync(scriptLink, { recursive: true, force: true })
  fs.symlinkSync(path.join(root, 'link-b'), scriptLink, process.platform === 'win32' ? 'junction' : 'dir')
  const secondScriptLink = await assembleTraceGraph(root)
  assert.notEqual(secondScriptLink.graph, firstScriptLink.graph, 'an existing resource must retain its real path identity')
  const sameMetadata = JSON.stringify([entry(['clang++', '-Iinclude/one', '-c', 'native/main.cpp'])])
  put('metadata-a/commands.json', sameMetadata)
  put('metadata-b/commands.json', sameMetadata)
  const metadataLink = path.join(root, 'metadata-link')
  fs.symlinkSync(path.join(root, 'metadata-a'), metadataLink, process.platform === 'win32' ? 'junction' : 'dir')
  const firstMetadataLink = await assembleTraceGraph(root, { compileCommands: 'metadata-link/commands.json' })
  assert.ok(fs.lstatSync(metadataLink).isSymbolicLink() && path.dirname(path.resolve(metadataLink)) === root)
  fs.rmSync(metadataLink, { recursive: true, force: true })
  fs.symlinkSync(path.join(root, 'metadata-b'), metadataLink, process.platform === 'win32' ? 'junction' : 'dir')
  const secondMetadataLink = await assembleTraceGraph(root, { compileCommands: 'metadata-link/commands.json' })
  assert.notEqual(secondMetadataLink.graph, firstMetadataLink.graph, 'byte-identical metadata at a different real path must invalidate the graph')
  ok('ordinary JS resource links and byte-identical compilation metadata links invalidate graph identity when retargeted')

  writeDatabase([entry(['clang++', '@flags.rsp', '-Iinclude/one', '-c', 'native/main.cpp'])])
  put('flags.rsp', '-Iinclude/two')
  const response = await run('file:native/main.cpp')
  assert.equal(response.compilation.unsupported, 1)
  assert.equal(response.incomplete, true)
  assert.deepEqual(edges(await assembleTraceGraph(root)), [])
  fs.writeFileSync(databasePath, '{ broken JSON')
  const broken = await run('file:native/main.cpp')
  assert.equal(broken.compilation.status, 'failed')
  assert.equal(broken.incomplete, true)
  fs.writeFileSync(databasePath, ' '.repeat(8 * 1024 * 1024 + 1))
  assert.equal((await run('file:native/main.cpp')).compilation.status, 'failed')
  const sentinel = path.join(root, 'MUST_NOT_EXIST')
  writeDatabase([{ directory: root, file: 'native/main.cpp', command: `clang++ -Iinclude/one; echo executed > "${sentinel}"` }])
  assert.equal((await run('file:native/main.cpp')).compilation.unsupported, 1)
  assert.equal(fs.existsSync(sentinel), false)
  ok('unsupported response/shell syntax and malformed/oversized databases are visible without executing workspace commands')

  fs.unlinkSync(databasePath)
  const custom = path.join(root, 'build/custom.json')
  fs.mkdirSync(path.dirname(custom), { recursive: true })
  const quotedDir = 'include/with spaces'
  put(`${quotedDir}/shared.h`)
  fs.writeFileSync(custom, JSON.stringify([{ directory: root, file: 'native/main.cpp', command: `clang++ -I"${quotedDir}" -c native/main.cpp` }]))
  const authorized = []
  const explicit = await createTraceTool(pool).execute({ target: 'file:native/main.cpp', compileCommands: 'build/custom.json' }, { ...exec, authorizeNativePaths: async paths => { authorized.push(...paths) } })
  assert.deepEqual(authorized, [custom])
  assert.equal(explicit.compilation.status, 'ok')
  assert.equal((await assembleTraceGraph(root)).compilation, undefined, 'explicit database must not contaminate the default cache')
  const explicitGraph = await assembleTraceGraph(root, { compileCommands: 'build/custom.json' })
  assert.ok(edges(explicitGraph).some(([to, line]) => line === 2 && to === `${quotedDir}/shared.h`))
  resetTraceFactsCache()
  process.env.DSH_FORGE_AST_WORKERS = '2'
  assert.deepEqual(await assembleTraceGraph(root, { compileCommands: 'build/custom.json', workers: pool }), explicitGraph)
  ok('explicit database authorization, native command quoting and worker/sequential behavior preserve separate cache ownership')

  const definitions = [], disposers = []
  for (const dispose of apply({
    fs: { resolve: async file => ({ targetKey: file, displayPath: file }), processPath: target => target.targetKey, processPathFromHostPath: file => file },
    tools: { register: definition => { definitions.push(definition) } }, commands: { register() {} },
  }, { prewarm: false })) if (typeof dispose === 'function') disposers.push(dispose)
  const definition = definitions.find(tool => tool.name === 'fftrace')
  const runtime = Object.create(ToolRuntime.prototype)
  runtime.canonicalResults = new WeakMap()
  runtime.concludingExecutions = new WeakSet()
  try {
    for (const target of ['impact:lib/core.js', 'path:app/index.html -> lib/core.js', 'path:orphan.js -> lib/core.js']) {
      const args = { target, compileCommands: 'build/custom.json' }
      const context = { ...exec, arguments: args, token: {} }
      const value = await definition.execute(args, context)
      const rendered = runtime.createSuccessResult(context, definition, value)
      assert.ok(value.analysis && value.compilation)
      assert.ok(rendered.content.some(block => block.type === 'text' && block.text.includes('Trace')))
    }
  } finally { for (const dispose of disposers.reverse()) await dispose() }
  ok('installed SDK validates and renders nested analysis and compilation results for found and missing routes')
} finally {
  await pool.dispose()
  if (previousWorkers === undefined) delete process.env.DSH_FORGE_AST_WORKERS
  else process.env.DSH_FORGE_AST_WORKERS = previousWorkers
  for (const folder of [root, outside]) {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep) && /^forge-trace-(?:analysis|outside)-/.test(path.basename(folder)))
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
console.log(`${passed} Trace analysis and compilation database groups passed`)
