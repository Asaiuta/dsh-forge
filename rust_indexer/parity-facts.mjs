/**
 * Trace facts parity: sidecar `traceFacts` vs the WASM `extractTraceFile`.
 * A language may use the native path only with zero differences here.
 *
 *   node rust_indexer/parity-facts.mjs <root> [<root> ...]
 *
 * Requires a current lib/ (`node build.mjs`). DSH_FORGE_INDEXER_EXE overrides
 * the sidecar binary (e.g. target/release while iterating).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractTraceFile } from '../lib/trace-facts.js'

const EXE = process.env.DSH_FORGE_INDEXER_EXE ?? fileURLToPath(new URL('./bin/dsh_forge_indexer.exe', import.meta.url))
const EXT = { '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx', '.py': 'python', '.pyi': 'python', '.rs': 'rust', '.go': 'go', '.c': 'c', '.java': 'java', '.lua': 'lua',
  ...Object.fromEntries(['.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.cppm', '.ixx'].map(ext => [ext, 'cpp'])) }
const SKIP = new Set((process.env.PARITY_SKIP ?? 'node_modules,.git,target,.venv,venv,__pycache__').split(','))
const LIMIT = Number(process.env.PARITY_LIMIT ?? 20000)

function walk(dir, out) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= LIMIT) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(full, out) }
    else if (entry.isFile() && EXT[path.extname(entry.name).toLowerCase()]) out.push(full)
  }
}

function request(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] })
    const parts = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      const nl = chunk.indexOf('\n')
      if (nl < 0) { parts.push(chunk); return }
      parts.push(chunk.slice(0, nl))
      child.stdin.end()
      const msg = JSON.parse(parts.join(''))
      msg.ok ? resolve(msg.results) : reject(new Error(msg.error))
    })
    child.on('error', reject)
    child.stdin.write(JSON.stringify({ id: 1, method: 'traceFacts', files }) + '\n')
  })
}

/** First differing path, for a readable minimal counterexample. */
function firstDiff(a, b, at = '') {
  if (Object.is(a, b)) return null
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return { at, wasm: a, native: b }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const found = firstDiff(a[key], b[key], `${at}.${key}`)
    if (found) return found
  }
  return null
}

const roots = process.argv.slice(2)
if (!roots.length) { console.error('usage: parity-facts.mjs <root> [...]'); process.exit(2) }
const files = []
for (const root of roots) walk(path.resolve(root), files)
const t0 = performance.now()
const native = await request(files)
const nativeMs = performance.now() - t0
const t1 = performance.now()
const wasm = []
for (const file of files) wasm.push(await extractTraceFile(file))
const wasmMs = performance.now() - t1

const stats = {}
let shown = 0
files.forEach((file, index) => {
  const lang = EXT[path.extname(file).toLowerCase()]
  const s = stats[lang] ??= { files: 0, equal: 0, differ: 0, clean: 0, nativeError: 0, categories: {} }
  s.files++
  const n = native[index]
  if (n.error) { s.nativeError++; return }
  const w = JSON.parse(JSON.stringify(wasm[index]))
  try { assert.deepStrictEqual(n, w); s.equal++ } catch {
    s.differ++
    // Both grammars parsed cleanly: any difference is a port bug. Otherwise the
    // two grammar versions recovered from a syntax error differently (newer
    // syntax such as Rust 2024 `unsafe extern`), which needs manual review.
    const clean = n.partialFiles === 0 && w.partialFiles === 0
    if (clean) s.clean++
    const diff = firstDiff(w, n)
    const category = (clean ? 'CLEAN ' : 'recovery ') + (diff?.at.replace(/\.\d+/g, '[]') ?? '?')
    s.categories[category] = (s.categories[category] ?? 0) + 1
    if (clean || process.env.PARITY_SHOW_RECOVERY) if (shown++ < Number(process.env.PARITY_SHOW ?? 12)) {
      console.log(`DIFF ${file}\n  at ${diff?.at}\n  wasm:   ${JSON.stringify(diff?.wasm)?.slice(0, 300)}\n  native: ${JSON.stringify(diff?.native)?.slice(0, 300)}`)
    }
  }
})
console.log(`\n${files.length} files  native ${nativeMs.toFixed(0)} ms  wasm(sequential) ${wasmMs.toFixed(0)} ms`)
console.table(Object.fromEntries(Object.entries(stats).map(([lang, s]) => [lang, { files: s.files, equal: s.equal, cleanDiffer: s.clean, recoveryDiffer: s.differ - s.clean, nativeError: s.nativeError }])))
for (const [lang, s] of Object.entries(stats)) if (s.differ) console.log(lang, s.categories)
process.exit(Object.values(stats).some(s => s.clean) ? 1 : 0)
