/** Project resolution: handwritten targets, TypeScript oracle, boundaries and cache mutation. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { createRequire } from 'node:module'
import { assembleTraceGraph, createTraceTool, resetTraceFactsCache } from '../lib/tools-trace.js'
import { AstWorkerPool } from '../lib/ast-pool.js'
import { apply } from '../lib/index.js'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { sameGraphExceptSnapshot } from './lib/snapshot-compare.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-projects-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-projects-outside-'))
const previousWorkers = process.env.DSH_FORGE_AST_WORKERS, pool = new AstWorkerPool()
let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)
const put = (file, value = '') => {
  const absolute = path.join(root, file); fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, typeof value === 'string' ? '\uFEFF' + value.replaceAll('\n', '\r\n') : JSON.stringify(value))
}
const exec = { agent: { session: { header: { cwd: root } } } }
const run = (target, args = {}) => createTraceTool(pool).execute({ target, ...args }, exec)
const outgoing = (graph, file) => (graph.deps.get(file) ?? []).filter(edge => edge.evidence.basis !== 'unresolved')
const to = (graph, file) => outgoing(graph, file).map(edge => edge.to)
const issue = (graph, file, spec) => graph.unresolvedModules.find(ref => ref.path === file && ref.spec === spec)
const oracle = (config, from, spec) => {
  const file = path.join(root, config), raw = ts.readConfigFile(file, ts.sys.readFile)
  assert.equal(raw.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(file), undefined, file)
  const resolved = ts.resolveModuleName(spec, path.join(root, from), parsed.options, ts.sys).resolvedModule
  return resolved && path.relative(root, resolved.resolvedFileName).replaceAll('\\', '/')
}

try {
  process.env.DSH_FORGE_AST_WORKERS = '0'
  put('tsconfig.json', { files: [], references: [{ path: './app/tsconfig.app.json' }] })
  put('configs/base.json', `{
    // Comment markers inside a string must survive.
    "compilerOptions": {"paths": {"@/*": ["lib/*"], "@/deep/*": ["specific/*"], "exact": ["exact.ts"], "fallback/*": ["missing/*", "lib/*"],},},
  }`)
  put('app/tsconfig.app.json', { extends: '../configs/base', include: ['src/**/*'], exclude: ['src/excluded/**'] })
  for (const file of ['configs/lib/core.ts', 'configs/lib/core.js', 'configs/specific/item.ts', 'configs/exact.ts']) put(file, 'export const value = 1;\n')
  put('app/src/main.ts', 'import "@/core";\nimport "@/deep/item";\nimport "exact";\nimport "fallback/core";\nimport "@/core.js";\n')
  let assembled = await assembleTraceGraph(root)
  const expected = ['configs/lib/core.ts', 'configs/specific/item.ts', 'configs/exact.ts', 'configs/lib/core.ts', 'configs/lib/core.ts']
  assert.deepEqual(to(assembled.graph, 'app/src/main.ts'), expected)
  for (const [index, spec] of ['@/core', '@/deep/item', 'exact', 'fallback/core', '@/core.js'].entries()) assert.equal(oracle('app/tsconfig.app.json', 'app/src/main.ts', spec), expected[index])
  assert.ok(outgoing(assembled.graph, 'app/src/main.ts').every(edge => edge.evidence.basis === 'tsconfig_paths' && edge.evidence.config === 'configs/base.json'))
  ok('JSONC, relative extends, explicit project references and path precedence match the installed TypeScript resolver')

  put('app/src/relative.ts', 'import "./twin.js";\nimport "./twin";\n'); put('app/src/twin.js'); put('app/src/twin.ts')
  assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'app/src/relative.ts'), ['./twin.js', './twin'].map(spec => oracle('app/tsconfig.app.json', 'app/src/relative.ts', spec)))
  ok('TypeScript relative imports prefer source extension substitution when both emitted JS and TS source exist')

  put('exact/tsconfig.json', { compilerOptions: { paths: { alias: ['lib/twin.js'] } } }); put('exact/main.ts', 'import "alias";\n')
  put('exact/lib/twin.js'); put('exact/lib/twin.ts')
  assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'exact/main.ts'), [oracle('exact/tsconfig.json', 'exact/main.ts', 'alias')])
  assert.equal(oracle('exact/tsconfig.json', 'exact/main.ts', 'alias'), 'exact/lib/twin.js')
  ok('paths explicit target extensions accept an existing exact file before TypeScript extension substitution')

  put('app/src/excluded/consumer.ts', 'import "@/core";\n')
  assert.equal(issue((await assembleTraceGraph(root)).graph, 'app/src/excluded/consumer.ts', '@/core').reason, 'unsupported_config')
  put('app/tsconfig.app.json', { extends: '../configs/base', compilerOptions: { baseUrl: '../alternate' }, include: ['src/**/*'], exclude: ['src/excluded/**'] })
  for (const file of ['alternate/lib/core.ts', 'alternate/specific/item.ts', 'alternate/exact.ts', 'alternate/plain.ts']) put(file)
  put('app/src/base.ts', 'import "plain";\n')
  assembled = await assembleTraceGraph(root)
  assert.equal(to(assembled.graph, 'app/src/main.ts')[0], 'alternate/lib/core.ts')
  assert.equal(oracle('app/tsconfig.app.json', 'app/src/main.ts', '@/core'), 'alternate/lib/core.ts')
  assert.deepEqual(to(assembled.graph, 'app/src/base.ts'), ['alternate/plain.ts'])
  assert.equal(outgoing(assembled.graph, 'app/src/base.ts')[0].evidence.basis, 'tsconfig_baseUrl')
  ok('include/exclude ownership and child baseUrl overrides retain TypeScript paths inheritance semantics')

  put('multi/paths.json', { compilerOptions: { paths: { '@lib/*': ['lib/*'] } } })
  put('multi/strict.json', { compilerOptions: { strict: true } })
  put('multi/tsconfig.json', { extends: ['./paths.json', './strict.json'] })
  put('multi/main.ts', 'import "@lib/x";\n'); put('multi/lib/x.ts')
  assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'multi/main.ts'), ['multi/lib/x.ts'])
  assert.equal(oracle('multi/tsconfig.json', 'multi/main.ts', '@lib/x'), 'multi/lib/x.ts')
  put('multi/strict.json', { compilerOptions: { paths: { '@lib/*': ['other/*'] } } }); put('multi/other/x.ts')
  assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'multi/main.ts'), ['multi/other/x.ts'])
  assert.equal(oracle('multi/tsconfig.json', 'multi/main.ts', '@lib/x'), 'multi/other/x.ts')
  ok('multiple extends merge only declared compiler settings and preserve explicit later paths overrides')

  put('tie/tsconfig.json', { compilerOptions: { paths: { 'same*': ['first/*'], 'same*/tail': ['second/*'] } } })
  put('tie/main.ts', 'import "samepiece/tail";\n'); put('tie/first/piece/tail.ts'); put('tie/second/piece.ts')
  assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'tie/main.ts'), [oracle('tie/tsconfig.json', 'tie/main.ts', 'samepiece/tail')])
  ok('TypeScript wildcard prefix ties retain declaration order rather than package-map suffix rules')

  put('dotroot/tsconfig.json', { compilerOptions: { paths: { alias: ['lib/x.ts'] } }, include: ['.'] })
  put('dotroot/src/main.ts', 'import "alias";\n'); put('dotroot/lib/x.ts')
  put('dotroot/.hidden/main.ts', 'import "alias";\n')
  assert.deepEqual(to((await assembleTraceGraph(path.join(root, 'dotroot'))).graph, 'src/main.ts'), ['lib/x.ts'])
  assert.deepEqual(to((await assembleTraceGraph(path.join(root, 'dotroot'))).graph, '.hidden/main.ts'), [])
  put('dotroot/tsconfig.json', { compilerOptions: { paths: { alias: ['lib/x.ts'] } }, exclude: ['.'] })
  assert.deepEqual(to((await assembleTraceGraph(path.join(root, 'dotroot'))).graph, 'src/main.ts'), [])
  put('membership/app/tsconfig.json', { compilerOptions: { paths: { sibling: ['../lib/x.ts'] } }, files: ['../shared/main.ts'] })
  put('membership/shared/main.ts', 'import "sibling";\n'); put('membership/lib/x.ts')
  assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'membership/shared/main.ts'), ['membership/lib/x.ts'])
  assert.equal(oracle('membership/app/tsconfig.json', 'membership/shared/main.ts', 'sibling'), 'membership/lib/x.ts')
  if (process.platform === 'win32') {
    put('membership/app/tsconfig.json', { compilerOptions: { paths: { sibling: ['../lib/x.ts'] } }, files: ['../shared/MAIN.ts'] })
    assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'membership/shared/main.ts'), ['membership/lib/x.ts'])
  }
  ok('root dot directory patterns, explicit sibling files and Windows file-list casing preserve project membership')

  put('solution/tsconfig.json', { compilerOptions: { paths: { solution: ['lib.ts'] } }, files: [], references: [{ path: './child' }] })
  put('solution/lib.ts'); put('solution/child/tsconfig.json', { extends: '../tsconfig.json', files: ['main.ts'] }); put('solution/child/main.ts', 'import "solution";\n')
  const solution = await assembleTraceGraph(root)
  assert.deepEqual(to(solution.graph, 'solution/child/main.ts'), ['solution/lib.ts'])
  assert.equal(oracle('solution/child/tsconfig.json', 'solution/child/main.ts', 'solution'), 'solution/lib.ts')
  assert.ok(!solution.diagnostics.some(ref => ref.path.startsWith('solution/') && ref.message.includes('循环')))
  ok('a referenced child may extend its solution config without being mistaken for an inheritance cycle')

  put('closure/tsconfig.json', { compilerOptions: { paths: { shared: ['lib/shared.ts'] } }, include: ['src'], exclude: ['src/excluded'] })
  put('closure/src/main.ts', 'import "./excluded/consumer";\n'); put('closure/src/excluded/consumer.ts', 'import "shared";\n')
  put('closure/src/excluded/orphan.ts', 'import "shared";\n'); put('closure/lib/shared.ts')
  put('closure/package.json', { workspaces: ['packages/*'] })
  put('closure/packages/shared/package.json', { name: 'shared', exports: './wrong.ts' }); put('closure/packages/shared/wrong.ts')
  const closure = (await assembleTraceGraph(path.join(root, 'closure'))).graph
  assert.deepEqual(to(closure, 'src/excluded/consumer.ts'), ['lib/shared.ts'])
  assert.equal(oracle('closure/tsconfig.json', 'closure/src/excluded/consumer.ts', 'shared'), 'closure/lib/shared.ts')
  assert.ok(outgoing(closure, 'src/excluded/consumer.ts').every(edge => edge.evidence.basis === 'tsconfig_paths' && edge.evidence.config === 'tsconfig.json'))
  assert.deepEqual(to(closure, 'src/excluded/orphan.ts'), [])
  assert.equal(issue(closure, 'src/excluded/orphan.ts', 'shared').reason, 'unsupported_config')
  ok('excluded files imported by program members join the closure and resolve through it; unimported orphans still stop bare-package fallback')

  put('rules/tsconfig.json', { compilerOptions: { paths: { shared: ['lib/shared.ts'] } }, include: ['src'], exclude: ['src/excluded'] })
  put('rules/lib/shared.ts')
  put('rules/src/excluded/consumer.ts', 'import "shared";\n')
  const rules = async (main) => { put('rules/src/main.ts', main); return (await assembleTraceGraph(path.join(root, 'rules'))).graph }
  assert.deepEqual(to(await rules('import "./excluded/consumer";\n'), 'src/excluded/consumer.ts'), ['lib/shared.ts'])
  const cases = [
    ['const c = require("./excluded/consumer");\nexport { c };\n', false],
    ['import c = require("./excluded/consumer");\nexport { c };\n', true],
    ['import("./excluded/consumer");\n', true],
    ['const s = "./excluded/consumer";\nexport const p = () => import(s);\n', false],
  ]
  for (const [source, expands] of cases) {
    const graph = await rules(source)
    assert.deepEqual(to(graph, 'src/excluded/consumer.ts'), expands ? ['lib/shared.ts'] : [], source.slice(0, 40))
    if (!expands) assert.equal(issue(graph, 'src/excluded/consumer.ts', 'shared').reason, 'unsupported_config')
  }
  ok('closure expansion matches TypeScript 5.9: plain TS require never expands; import-equals and literal dynamic imports do')

  put('allowjs/tsconfig.json', { compilerOptions: { paths: { shared: ['lib/shared.ts'] } }, include: ['src'], exclude: ['src/excluded'] })
  put('allowjs/lib/shared.ts'); put('allowjs/src/main.ts', 'import "./helper.js";\n')
  put('allowjs/src/helper.js', 'const c = require("./excluded/consumer");\nmodule.exports = c;\n')
  put('allowjs/src/excluded/consumer.ts', 'import "shared";\n')
  assert.deepEqual(to((await assembleTraceGraph(path.join(root, 'allowjs'))).graph, 'src/excluded/consumer.ts'), [])
  put('allowjs/tsconfig.json', { compilerOptions: { allowJs: true, paths: { shared: ['lib/shared.ts'] } }, include: ['src'], exclude: ['src/excluded'] })
  assert.deepEqual(to((await assembleTraceGraph(path.join(root, 'allowjs'))).graph, 'src/excluded/consumer.ts'), ['lib/shared.ts'])
  ok('allowJs decides whether reached JS files join the program and keep expanding through CommonJS require')

  put('amb/a/tsconfig.json', { compilerOptions: { paths: { shared: ['../x.ts'] } }, include: ['../src'], exclude: ['../src/excluded'] })
  put('amb/b/tsconfig.json', { compilerOptions: { paths: { shared: ['../y.ts'] } }, include: ['../src'], exclude: ['../src/excluded'] })
  put('amb/x.ts'); put('amb/y.ts')
  put('amb/src/main.ts', 'import "./excluded/consumer";\n')
  put('amb/src/excluded/consumer.ts', 'import "shared";\n')
  assert.equal(issue((await assembleTraceGraph(path.join(root, 'amb'))).graph, 'src/excluded/consumer.ts', 'shared').reason, 'ambiguous_target')
  ok('a file shared by two programs reports ambiguity instead of inventing one mapping')

  put('web/jsconfig.json', { compilerOptions: { baseUrl: '.', paths: { alias: ['lib/one.js'] } } })
  put('web/main.js', 'require("alias");\n'); put('web/lib/one.js'); put('web/lib/two.js')
  const one = await assembleTraceGraph(root), stamp = fs.statSync(path.join(root, 'web/jsconfig.json'))
  const sameSize = fs.readFileSync(path.join(root, 'web/jsconfig.json'), 'utf8').replace('one.js', 'two.js')
  fs.writeFileSync(path.join(root, 'web/jsconfig.json'), sameSize); fs.utimesSync(path.join(root, 'web/jsconfig.json'), stamp.atime, stamp.mtime)
  const two = await assembleTraceGraph(root)
  assert.notEqual(two.graph, one.graph); assert.deepEqual(to(two.graph, 'web/main.js'), ['web/lib/two.js'])
  assert.equal((await assembleTraceGraph(root)).graph, two.graph)
  fs.unlinkSync(path.join(root, 'web/jsconfig.json'))
  assert.equal(issue((await assembleTraceGraph(root)).graph, 'web/main.js', 'alias').reason, 'external_package')
  put('web/jsconfig.json', { compilerOptions: { paths: { alias: ['lib/one.js'] } } })
  assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'web/main.js'), ['web/lib/one.js'])
  ok('metadata same-size edits with restored mtime, removal, creation and unchanged reuse invalidate exactly the graph input')

  put('package.json', { name: 'root-app', workspaces: ['packages/*', '!packages/skip'], imports: { '#root': './root.ts' }, exports: './root.ts' })
  put('root.ts')
  put('packages/tool/package.json', { name: '@demo/tool', exports: { '.': './index.ts', './feature/*': './src/*.ts', './blocked': null, './choice': { types: './types.d.ts', import: './esm.js', require: './cjs.cjs' }, './array': ['./index.ts'] } })
  for (const file of ['packages/tool/index.ts', 'packages/tool/src/a.ts', 'packages/tool/types.d.ts', 'packages/tool/esm.js', 'packages/tool/cjs.cjs']) put(file)
  put('packages/app/package.json', { name: 'app', imports: { '#local': './local.ts', '#forward': '@demo/tool/feature/a', '#cycle': '#cycle' } })
  put('packages/app/tsconfig.json', { compilerOptions: { module: 'System' } })
  put('packages/tool/tsconfig.json', { compilerOptions: { module: 'System' } })
  put('packages/app/local.ts')
  put('packages/app/main.ts', 'import "@demo/tool";\nimport "@demo/tool/feature/a";\nimport "#local";\nimport "#forward";\nimport "@demo/tool/blocked";\nimport "@demo/tool/private.ts";\nimport "@demo/tool/array";\nimport "#cycle";\n')
  put('packages/app/choice.ts', 'import "@demo/tool/choice";\n')
  put('packages/app/choice.cjs', 'require("@demo/tool/choice");\n')
  put('packages/tool/self.ts', 'import "@demo/tool";\n')
  put('packages/skip/package.json', { name: 'skipped', main: './index.js' }); put('packages/skip/index.js')
  put('stray/package.json', { name: 'stray', main: './index.js' }); put('stray/index.js')
  put('packages/app/missing.ts', 'import "skipped";\nimport "stray";\nimport "#root";\n')
  assembled = await assembleTraceGraph(root)
  assert.deepEqual(to(assembled.graph, 'packages/app/main.ts'), ['packages/tool/index.ts', 'packages/tool/src/a.ts', 'packages/app/local.ts', 'packages/tool/src/a.ts'])
  assert.deepEqual(to(assembled.graph, 'packages/tool/self.ts'), ['packages/tool/index.ts'])
  assert.deepEqual(to(assembled.graph, 'packages/app/missing.ts'), [])
  assert.equal(issue(assembled.graph, 'packages/app/main.ts', '@demo/tool/array').reason, 'unsupported_config')
  assert.equal(issue(assembled.graph, 'packages/app/main.ts', '#cycle').reason, 'unsupported_config')
  assert.equal(issue(assembled.graph, 'packages/app/main.ts', '@demo/tool/blocked').reason, 'missing_target')
  ok('npm workspace membership, export subpaths, self references, imports forwarding and nearest package boundaries are explicit')

  assert.deepEqual(to(assembled.graph, 'packages/app/choice.ts'), ['packages/tool/types.d.ts', 'packages/tool/esm.js', 'packages/tool/cjs.cjs'])
  assert.deepEqual(to(assembled.graph, 'packages/app/choice.cjs'), ['packages/tool/cjs.cjs'])
  assert.ok(outgoing(assembled.graph, 'packages/app/choice.ts').every(edge => edge.evidence.confidence === 'candidate'))
  const all = await run('path:packages/app/choice.ts -> packages/tool/esm.js')
  const certain = await run('path:packages/app/choice.ts -> packages/tool/esm.js', { edgeMode: 'certain' })
  assert.equal(all.found, true); assert.equal(certain.found, false); assert.equal(certain.analysis.complete, true)
  assert.equal(certain.analysis.edgeMode, 'certain'); assert.equal(all.analysis.edges[0].evidence.basis, 'package_exports')
  assert.equal((await run('path:packages/app/choice.ts -> packages/tool/esm.js')).found, true)
  assert.equal((await run('path:packages/app/main.ts -> packages/tool/index.ts', { edgeMode: 'certain' })).found, true)
  assert.equal((await run('impact:packages/tool/esm.js')).analysis.totalFiles, 1)
  assert.equal((await run('impact:packages/tool/esm.js', { edgeMode: 'certain' })).analysis.totalFiles, 0)
  // Certain mode drops the conditional-export edge, so the file has no deps.
  // An all-zero set of sections collapses into the "无：" line, so assert it is
  // reported as absent rather than as a heading with a zero count.
  const noneCertain = await run('file:packages/app/choice.ts', { edgeMode: 'certain' })
  assert.match(noneCertain.text, /^- 无：.*依赖/m)
  assert.doesNotMatch(noneCertain.text, /### 依赖 \/ 被依赖（[1-9]/)
  assert.ok((await run('file:root.ts', { edgeMode: 'maybe' })).error)
  assert.ok((await run('ipc:anything', { edgeMode: 'certain' })).error)
  ok('conditional exports remain candidates and all/certain queries keep independent traversal indexes and file lists')

  put('packages/app/choice.cts', 'import "@demo/tool/choice";\n')
  put('packages/app/choice.mts', 'import "@demo/tool/choice";\n')
  put('packages/app/dynamic.cts', 'import("@demo/tool/choice");\n')
  put('packages/app/tsconfig.json', { compilerOptions: { module: 'NodeNext' } })
  let modes = (await assembleTraceGraph(root)).graph
  assert.deepEqual(to(modes, 'packages/app/choice.cts'), ['packages/tool/types.d.ts', 'packages/tool/cjs.cjs'])
  assert.deepEqual(to(modes, 'packages/app/choice.mts'), ['packages/tool/types.d.ts', 'packages/tool/esm.js'])
  assert.deepEqual(to(modes, 'packages/app/dynamic.cts'), ['packages/tool/types.d.ts', 'packages/tool/esm.js'])
  assert.deepEqual(to(modes, 'packages/app/choice.ts'), ['packages/tool/types.d.ts', 'packages/tool/cjs.cjs'])
  put('packages/app/tsconfig.json', { compilerOptions: { module: 'ESNext' } })
  modes = (await assembleTraceGraph(root)).graph
  assert.deepEqual(to(modes, 'packages/app/choice.ts'), ['packages/tool/types.d.ts', 'packages/tool/esm.js'])
  ok('CTS/MTS, NodeNext package type, explicit ESM and native dynamic imports select the appropriate conditional candidates')

  put('packages/tool/package.json', { name: '@demo/tool', exports: './src/a.ts' })
  assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'packages/tool/self.ts'), ['packages/tool/src/a.ts'])
  put('packages/duplicate/package.json', { name: '@demo/tool', exports: './index.ts' }); put('packages/duplicate/index.ts')
  assert.equal(issue((await assembleTraceGraph(root)).graph, 'packages/app/main.ts', '@demo/tool').reason, 'ambiguous_target')
  fs.unlinkSync(path.join(root, 'packages/duplicate/package.json'))
  put('pnpm-workspace.yaml', 'packages:\n  - "modules/*"\n  - "!modules/nope"\n')
  put('modules/shared/package.json', { name: 'pnpm-shared', main: 'index.js' }); put('modules/shared/index.js')
  put('pnpm-consumer.js', 'require("pnpm-shared");\n')
  assert.deepEqual(to((await assembleTraceGraph(root)).graph, 'pnpm-consumer.js'), ['modules/shared/index.js'])
  ok('package content changes, duplicate names and literal pnpm package lists refresh workspace resolution')

  put('packages/wild/package.json', { name: 'wild', exports: { './feat*': './src/feat*.js', './exact': './src/feat.js' } })
  put('packages/wild/src/feat.js'); put('packages/wild/src/featx.js')
  put('wild-user.cjs', 'require("wild/feat");\nrequire("wild/featx");\nrequire("wild/exact");\nrequire("#");\n')
  const wild = await assembleTraceGraph(root)
  assert.deepEqual(to(wild.graph, 'wild-user.cjs'), ['packages/wild/src/featx.js', 'packages/wild/src/feat.js'])
  assert.equal(issue(wild.graph, 'wild-user.cjs', 'wild/feat').reason, 'missing_target')
  assert.equal(issue(wild.graph, 'wild-user.cjs', '#').reason, 'unsupported_resolution')
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.symlinkSync(path.join(root, 'packages/wild'), path.join(root, 'node_modules/wild'), process.platform === 'win32' ? 'junction' : 'dir')
  const require = createRequire(path.join(root, 'wild-user.cjs'))
  assert.throws(() => require.resolve('wild/feat'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  assert.equal(path.relative(root, require.resolve('wild/featx')).replaceAll('\\', '/'), 'packages/wild/src/featx.js')
  ok('package patterns require nonempty captures while exact maps and invalid imports names keep separate rules')

  for (const [name, target] of [['dot-segment', '././x.js'], ['modules-segment', './src/NODE_MODULES/x.js']]) {
    put(`packages/${name}/package.json`, { name, exports: target }); put(`packages/${name}/${target}`)
    fs.symlinkSync(path.join(root, 'packages', name), path.join(root, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => require.resolve(name), { code: 'ERR_INVALID_PACKAGE_TARGET' })
  }
  put('packages/null-export/package.json', { name: 'null-export', exports: null, main: './x.js' }); put('packages/null-export/x.js')
  fs.symlinkSync(path.join(root, 'packages/null-export'), path.join(root, 'node_modules/null-export'), process.platform === 'win32' ? 'junction' : 'dir')
  put('package-validation.cjs', 'require("dot-segment");\nrequire("modules-segment");\nrequire("null-export");\n')
  const validation = await assembleTraceGraph(root)
  assert.deepEqual(to(validation.graph, 'package-validation.cjs'), ['packages/null-export/x.js'])
  assert.equal(issue(validation.graph, 'package-validation.cjs', 'dot-segment').reason, 'unsupported_config')
  assert.equal(path.relative(root, require.resolve('null-export')).replaceAll('\\', '/'), 'packages/null-export/x.js')
  ok('Node resolution independently rejects invalid package target segments and accepts a null top-level exports fallback')

  put('packages/optional-browser/package.json', { name: 'optional-browser', exports: { browser: './missing.js', require: './exists.cjs' } })
  put('packages/optional-browser/exists.cjs'); put('optional-browser-user.cjs', 'require("optional-browser");\n')
  fs.symlinkSync(path.join(root, 'packages/optional-browser'), path.join(root, 'node_modules/optional-browser'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(path.relative(root, require.resolve('optional-browser')).replaceAll('\\', '/'), 'packages/optional-browser/exists.cjs')
  const optional = await run('path:optional-browser-user.cjs -> packages/optional-browser/exists.cjs')
  assert.equal(optional.found, true); assert.equal(optional.incomplete, true)
  assert.equal(optional.analysis.edges[0].evidence.confidence, 'candidate')
  assert.ok(optional.diagnostics.issues.some(item => item.reason === 'conditional_target_missing'))
  ok('a missing optional environment artifact preserves available conditional candidates and reports the incomplete branch')

  put('packages/parallel-evidence/package.json', { name: 'parallel-evidence', exports: { import: './index.js' } }); put('packages/parallel-evidence/index.js')
  put('evidence-first.js', 'import "parallel-evidence"; import "./packages/parallel-evidence/index.js";\n')
  put('evidence-second.js', 'import "./packages/parallel-evidence/index.js"; import "parallel-evidence";\n')
  for (const file of ['evidence-first.js', 'evidence-second.js']) {
    assert.equal((await run(`path:${file} -> packages/parallel-evidence/index.js`, { edgeMode: 'certain' })).found, true)
    const graph = (await assembleTraceGraph(root)).graph
    assert.deepEqual(outgoing(graph, file).map(edge => edge.evidence.confidence).sort(), ['candidate', 'certain'])
  }
  ok('same-line candidate and certain evidence coexist independently of import order in both forward and reverse graphs')

  put('diagnostics.js', 'import(target);\nimport "./absent.js";\nimport "upstream-only";\nimport "../outside.js";\n')
  put('broken/tsconfig.json', '{ /* unclosed')
  put('broken/main.ts', 'import "alias";\n')
  put('oversized.js', ' '.repeat(2 * 1024 * 1024 + 1))
  const diagnostic = await run('file:diagnostics.js')
  assert.deepEqual(diagnostic.diagnostics.unresolved.map(ref => ref.reason), ['non_literal', 'missing_target', 'external_package', 'outside_root'])
  assert.ok(diagnostic.diagnostics.issues.some(item => item.path === 'broken/tsconfig.json' && item.reason === 'metadata_parse'))
  assert.ok(diagnostic.diagnostics.issues.some(item => item.path === 'oversized.js' && item.reason === 'file_too_large'))
  assert.equal((await run('file:broken/main.ts')).diagnostics.unresolved[0].reason, 'unsupported_config')
  assert.equal(diagnostic.incomplete, true)
  fs.unlinkSync(path.join(root, 'oversized.js'))
  ok('nonliteral, missing, external, outside-root, malformed configuration and skipped-file failures have structured causes')

  put('diagnostic-cap.js', Array.from({ length: 105 }, (_, n) => `import "./missing-${n}.js";`).join('\n'))
  const capped = await run('file:diagnostic-cap.js')
  assert.equal(capped.diagnostics.unresolvedTotal, 105); assert.equal(capped.diagnostics.unresolved.length, 100); assert.equal(capped.diagnostics.truncated, true)
  ok('diagnostic counts retain the denominator when returned rows are capped')

  put('ambient.d.ts', 'declare module "ambient-check" { export const value: number; }\n')
  put('ambient-user.ts', 'import "ambient-check";\n')
  assert.equal((await run('path:ambient-user.ts -> ambient.d.ts')).analysis.edges[0].evidence.confidence, 'candidate')
  assert.equal((await run('path:ambient-user.ts -> ambient.d.ts', { edgeMode: 'certain' })).found, false)
  ok('ambient declarations are evidence of a declaration provider and are excluded from certain file routes')

  fs.writeFileSync(path.join(outside, 'external.ts'), 'export const x = 1;')
  fs.symlinkSync(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir')
  put('boundary/jsconfig.json', { compilerOptions: { paths: { escape: ['../outside-link/external.ts', './local.ts'] } } })
  put('boundary/local.ts'); put('boundary/main.js', 'import "escape";\nimport "../outside-link/external.ts";\n')
  const boundary = await assembleTraceGraph(root)
  assert.deepEqual(to(boundary.graph, 'boundary/main.js'), [])
  assert.equal(issue(boundary.graph, 'boundary/main.js', 'escape').reason, 'outside_root')
  ok('physical root checks reject directory-link targets without selecting a later local alias fallback')

  resetTraceFactsCache()
  const sequential = await assembleTraceGraph(root)
  resetTraceFactsCache(); process.env.DSH_FORGE_AST_WORKERS = '2'
  sameGraphExceptSnapshot(await assembleTraceGraph(root, { workers: pool }), sequential, 'worker vs sequential project graph')
  ok('worker and sequential facts preserve the same project graph, evidence and diagnostics')

  const definitions = [], disposers = []
  for (const dispose of apply({ fs: { resolve: async file => ({ targetKey: file, displayPath: file }), processPath: target => target.targetKey, processPathFromHostPath: file => file },
    tools: { register: definition => { definitions.push(definition) } }, commands: { register() {} } }, { prewarm: false })) if (typeof dispose === 'function') disposers.push(dispose)
  try {
    assert.equal(definitions.length, 9)
    const definition = definitions.find(tool => tool.name === 'fftrace'), runtime = Object.create(ToolRuntime.prototype)
    runtime.canonicalResults = new WeakMap(); runtime.concludingExecutions = new WeakSet()
    for (const args of [{ target: 'file:diagnostics.js' }, { target: 'path:app/src/main.ts -> alternate/lib/core.ts', edgeMode: 'certain' }]) {
      const context = { ...exec, arguments: args, token: {} }, value = await definition.execute(args, context)
      assert.equal(value.error, undefined)
      assert.ok(runtime.createSuccessResult(context, definition, value).content.some(item => item.type === 'text' && item.text.includes('Trace')))
    }
  } finally { for (const dispose of disposers.reverse()) await dispose() }
  ok('the installed SDK accepts new nested evidence/diagnostics and still registers exactly nine tools')
} finally {
  await pool.dispose()
  if (previousWorkers === undefined) delete process.env.DSH_FORGE_AST_WORKERS; else process.env.DSH_FORGE_AST_WORKERS = previousWorkers
  for (const directory of [root, outside]) {
    assert.ok(path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('forge-trace-projects-'))
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
console.log(`${passed} Trace project resolution groups passed`)
