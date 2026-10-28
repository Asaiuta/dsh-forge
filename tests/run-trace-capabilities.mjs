/**
 * Capability matrix truth: the documented Trace support boundary must match the
 * walker, and parse support must never be advertised as dependency support.
 * M0.1 in docs/forge-plan-m0-m1.md.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TRACE_BINARY_EVIDENCE, TRACE_CAPABILITY_MATRIX, TRACE_SCAN_EXTENSIONS, traceLanguageCapability } from '../lib/trace-capabilities.js'
import { detectLanguage } from '../lib/ast.js'
import { assembleTraceGraph, resetTraceFactsCache } from '../lib/tools-trace.js'

let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)

// Pinned independently of the matrix: widening the walker is a deliberate
// change that must edit this list, the matrix and docs/trace-reference.md in
// the same breath.
const PINNED_SCAN = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.html', '.vue', '.svelte',
  '.py', '.pyi', '.rs', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.cppm', '.ixx', '.go', '.java', '.lua']

assert.deepEqual([...TRACE_SCAN_EXTENSIONS].sort(), [...PINNED_SCAN].sort())
ok('scan extension set is unchanged and derived from the matrix')

const owners = new Map()
for (const row of TRACE_CAPABILITY_MATRIX) {
  for (const ext of row.extensions) {
    assert.equal(owners.has(ext), false, `${ext} is owned by both ${owners.get(ext)} and ${row.language}`)
    owners.set(ext, row.language)
  }
  assert.equal(row.symbolReferences, false, `${row.language} must not claim symbol references`)
  assert.equal(row.runtime, false, `${row.language} must not claim runtime evidence`)
  assert.equal(row.parse !== false, true, `${row.language} has no parse channel`)
}
ok('every row disclaims symbol references and runtime evidence')

assert.deepEqual([...TRACE_SCAN_EXTENSIONS].filter(ext => !owners.has(ext)), [])
for (const ext of TRACE_SCAN_EXTENSIONS) {
  assert.notEqual(traceLanguageCapability(owners.get(ext)).fileDependency, false, `${ext} is scanned but its matrix row disclaims file dependency`)
}
ok('each scanned extension belongs to exactly one file-dependency row')

// The C# trap: parseable, but not a Trace language.
const csharp = traceLanguageCapability('csharp')
assert.equal(csharp.parse, 'supported')
assert.equal(csharp.fileDependency, false)
assert.equal(csharp.projectResolution, false)
assert.equal(TRACE_SCAN_EXTENSIONS.has('.cs'), false)
assert.equal(detectLanguage('C:\\work\\Program.cs'), 'c_sharp')
ok('C# parses definitions but is neither scanned nor documented as file-dependency support')

assert.equal(traceLanguageCapability('vue').parse, 'partial')
assert.equal(traceLanguageCapability('svelte').parse, 'partial')
assert.equal(traceLanguageCapability('html').parse, 'partial')
assert.equal(traceLanguageCapability('javascript').projectResolution, 'supported')
for (const language of ['java', 'lua', 'csharp']) assert.equal(traceLanguageCapability(language).projectResolution, false)
ok('partial parse channels and absent project resolution are recorded honestly')

assert.deepEqual(TRACE_BINARY_EVIDENCE.extensions.sort(), ['.dll', '.elf', '.exe', '.node', '.so', '.wasm'])
assert.equal(TRACE_CAPABILITY_MATRIX.some(row => row.language === 'binary'), false)
ok('binary metadata stays outside the language rows')

// Behavior, not just table shape: a .cs file next to a .vue script is invisible
// to graph edges while the component's script import resolves.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-capabilities-'))
const previousWorkers = process.env.DSH_FORGE_AST_WORKERS
try {
  process.env.DSH_FORGE_AST_WORKERS = '0'
  const put = (rel, text) => {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  put('main.js', "import { x } from './view.vue'\n")
  put('view.vue', '<template><p>plain text</p></template>\n<script>import "./dep.js"\nexport const x = 1\n</script>\n')
  put('dep.js', 'export const y = 2\n')
  put('Program.cs', 'using Nope.Missing;\nclass Program { static void Main() { } }\n')
  resetTraceFactsCache()
  const { graph } = await assembleTraceGraph(root)
  const files = [...graph.files.keys()].sort()
  assert.deepEqual(files, ['dep.js', 'main.js', 'view.vue'])
  assert.deepEqual((graph.deps.get('view.vue') ?? []).map(edge => edge.to), ['dep.js'])
  assert.equal(files.includes('Program.cs'), false)
  ok('a .cs file contributes no graph node while a .vue script block still does')
} finally {
  if (previousWorkers === undefined) delete process.env.DSH_FORGE_AST_WORKERS
  else process.env.DSH_FORGE_AST_WORKERS = previousWorkers
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
}

console.log(`\n${passed} Trace capability matrix groups passed`)
