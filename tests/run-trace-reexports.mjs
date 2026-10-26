// JS/TS re-export chains: named imports through barrels reach the defining file.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, createTraceTool, resetTraceFactsCache } from '../lib/tools-trace.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-reexports-'))
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const reexports = (graph, file) => (graph.deps.get(file) ?? []).filter(edge => edge.kind === 'reexport')
  .map(edge => ({ to: edge.to, names: edge.imports, via: edge.evidence.config, confidence: edge.evidence.confidence }))
const exec = { agent: { session: { header: { cwd: root, id: 'trace-reexports' } } }, token: {} }

try {
  write('src/core/math.ts', 'export function add(a: number, b: number) { return a + b }\nexport const PI = 3\n')
  write('src/core/strings.ts', 'export function upper(s: string) { return s }\nexport default function fmt() {}\n')
  write('src/core/index.ts', "export * from './math'\nexport { upper as toUpper, default as format } from './strings'\nexport * as strings from './strings'\n")
  write('src/index.ts', "export * from './core'\n")
  write('src/app.ts', "import { add, toUpper, format, strings, missing } from './index'\n")

  write('src/amb/a.ts', 'export const dup = 1\n')
  write('src/amb/b.ts', 'export const dup = 2\n')
  write('src/amb/index.ts', "export * from './a'\nexport * from './b'\n")
  write('src/useAmb.ts', "import { dup } from './amb'\n")

  write('src/def/impl.ts', 'export default 1\n')
  write('src/def/index.ts', "export * from './impl'\n")
  write('src/useDef.ts', "import { default as d } from './def'\n")

  write('src/cjs/legacy.js', 'module.exports = { old: 1 }\n')
  write('src/cjs/index.ts', "export * from './legacy.js'\n")
  write('src/useCjs.ts', "import { old } from './cjs'\n")

  write('src/bridge.ts', "import { add as plus } from './core/math'\nexport { plus }\n")
  write('src/useBridge.ts', "import { plus } from './bridge'\n")

  write('src/cyc/a.ts', "export * from './b'\n")
  write('src/cyc/b.ts', "export * from './a'\n")
  write('src/useCyc.ts', "import { nothing } from './cyc/a'\n")

  resetTraceFactsCache()
  const { graph } = await assembleTraceGraph(root)
  assert.deepEqual(reexports(graph, 'src/app.ts'), [
    { to: 'src/core/math.ts', names: ['add'], via: 'via src/index.ts → src/core/index.ts', confidence: 'candidate' },
    { to: 'src/core/strings.ts', names: ['toUpper', 'format', 'strings'], via: 'via src/index.ts → src/core/index.ts', confidence: 'candidate' },
  ])
  ok('named, renamed-default and namespace re-exports through two barrels reach the defining files')

  assert.deepEqual(reexports(graph, 'src/useAmb.ts'), [])
  assert.deepEqual(reexports(graph, 'src/useDef.ts'), [])
  assert.deepEqual(reexports(graph, 'src/useCjs.ts'), [])
  assert.deepEqual(reexports(graph, 'src/useCyc.ts'), [])
  ok('star ambiguity, default through export *, CommonJS star targets and cycles add no edge')

  assert.deepEqual(reexports(graph, 'src/useBridge.ts'), [{ to: 'src/core/math.ts', names: ['plus'], via: 'via src/bridge.ts', confidence: 'candidate' }])
  ok('an exported import binding forwards to its source module')

  const tool = createTraceTool()
  const all = await tool.execute({ target: 'file:src/app.ts' }, exec)
  assert.match(all.text, /→ `src\/core\/math\.ts` · L1 · reexport · candidate\/reexport · via src\/index\.ts → src\/core\/index\.ts · 导入 \{add\}/, all.text)
  const certain = await tool.execute({ target: 'file:src/app.ts', edgeMode: 'certain' }, exec)
  assert.doesNotMatch(certain.text, /reexport/)
  const impact = await tool.execute({ target: 'impact:src/core/math.ts' }, exec)
  assert.ok(impact.analysis.files.some(file => file.path === 'src/app.ts' && file.depth === 1), JSON.stringify(impact.analysis.files))
  ok('file: shows the chain, edgeMode=certain drops re-export edges, impact reaches importers directly')
} finally {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
}

console.log(`\n${passed} Trace re-export groups passed`)
