/**
 * Sidecar vs WASM performance benchmark.
 *
 *   node rust_indexer/bench-sidecar.mjs <root> [maxFiles] [query]
 *
 * Measures, over a real tree:
 *   1. cold batch parse   sidecar (Rust, rayon) vs WASM (web-tree-sitter)
 *   2. warm re-parse      sidecar mtime+size cache vs WASM read+sha256 cache
 *   3. findSymbols        sidecar cold vs warm (warm must report parsed=0)
 *
 * Both sides are warmed and cache-reset before each timed run so neither gets
 * an unfair head start. WASM is timed sequentially, which is the honest
 * single-threaded number; the sidecar batch is internally parallel.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseFileSearch, resetCache as resetWasmCache, detectLanguage } from '../lib/ast.js'

const EXE = fileURLToPath(new URL('./bin/dsh_forge_indexer.exe', import.meta.url))
const ROOT = process.argv[2] ?? '.'
const MAX = Number(process.argv[3] ?? 800)
const QUERY = process.argv[4] ?? 'name'
const SKIP = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next', '.cache'])

// --- sidecar client ---------------------------------------------------------
class Sidecar {
  #child; #seq = 1; #pending = new Map(); #buf = ''
  constructor(exe) {
    this.#child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => {
      this.#buf += chunk
      let nl
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, nl); this.#buf = this.#buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg; try { msg = JSON.parse(line) } catch { continue }
        const p = this.#pending.get(msg.id)
        if (p) { this.#pending.delete(msg.id); p(msg) }
      }
    })
  }
  request(method, params = {}) {
    const id = this.#seq++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (m) => m.ok ? resolve(m) : reject(new Error(m.error)))
      this.#child.stdin.write(JSON.stringify({ id, method, ...params }) + '\n')
    })
  }
  kill() { this.#child.kill() }
}

// --- corpus -----------------------------------------------------------------
const files = []
const byLang = new Map()
function walk(dir, depth) {
  if (files.length >= MAX || depth > 12) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (files.length >= MAX) return
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(abs, depth + 1) }
    else {
      const lang = detectLanguage(abs)
      if (!lang) continue
      let size = 0
      try { size = statSync(abs).size } catch { continue }
      if (size === 0 || size > 2 * 1024 * 1024) continue
      files.push(abs)
      if (!byLang.has(lang)) byLang.set(lang, [])
      byLang.get(lang).push(abs)
    }
  }
}
walk(ROOT, 0)

if (files.length === 0) { console.error('no parseable files found under', ROOT); process.exit(1) }

// Untimed pre-pass: bytes and line counts for throughput reporting.
let bytes = 0, lines = 0
for (const f of files) {
  try {
    const text = readFileSync(f, 'utf8')
    bytes += Buffer.byteLength(text)
    lines += text.split('\n').length
  } catch { /* raced */ }
}

const ms = (t) => Number((Number(t) / 1e6).toFixed(1))
const mb = (bytes / 1048576)
const now = () => process.hrtime.bigint()
const fmt = (v, d = 1) => String(Number(v.toFixed(d)))

console.log(`corpus: ${ROOT}`)
console.log(`files=${files.length}  bytes=${fmt(mb, 2)}MB  lines=${lines.toLocaleString()}`)
console.log(`languages: ${[...byLang.entries()].map(([l, a]) => `${l}=${a.length}`).join(' ')}\n`)

const side = new Sidecar(EXE)
await side.request('ping', {})
// Warm the WASM grammar loaders so the first timed run isn't paying for them.
try { await parseFileSearch(files[0]) } catch { /* ignore */ }

// --- 1/2. cold + warm batch parse -------------------------------------------
await side.request('resetCache', {})
let t = now(); const cold = await side.request('parseBatch', { files }); const sideCold = ms(now() - t)
const symCount = cold.results.reduce((n, r) => n + (r.symbols?.length ?? 0), 0)

t = now(); await side.request('parseBatch', { files }); const sideWarm = ms(now() - t)

resetWasmCache()
t = now()
for (const f of files) { try { await parseFileSearch(f) } catch { /* ignore */ } }
const wasmCold = ms(now() - t)

t = now()
for (const f of files) { try { await parseFileSearch(f) } catch { /* ignore */ } }
const wasmWarm = ms(now() - t)

// --- 3. findSymbols cold vs warm --------------------------------------------
await side.request('resetCache', {})
t = now(); const q1 = await side.request('findSymbols', { files, name: QUERY, kinds: null }); const qCold = ms(now() - t)
t = now(); const q2 = await side.request('findSymbols', { files, name: QUERY, kinds: null }); const qWarm = ms(now() - t)

side.kill()

const row = (label, msec, note = '') =>
  console.log(
    `  ${label.padEnd(22)} ${String(msec).padStart(9)} ms   ` +
    `${fmt(files.length / (msec / 1000), 0).padStart(7)} files/s   ` +
    `${fmt(mb / (msec / 1000), 1).padStart(6)} MB/s   ${note}`,
  )

console.log('parse (all files, top-level symbols=' + symCount + ')')
row('sidecar cold', sideCold)
row('wasm cold', wasmCold, `speedup ${fmt(wasmCold / sideCold)}x`)
row('sidecar warm', sideWarm, 'mtime+size cache')
row('wasm warm', wasmWarm, `read+sha256; speedup ${fmt(wasmWarm / sideWarm)}x`)

console.log(`\nfindSymbols "${QUERY}"`)
row('sidecar cold', qCold, `scanned=${q1.parsed} reparsed=${q1.reparsed} hits=${q1.items.length}`)
row('sidecar warm', qWarm, `scanned=${q2.parsed} reparsed=${q2.reparsed} hits=${q2.items.length}  speedup ${fmt(qCold / qWarm)}x`)

console.log('\nper-language file counts')
for (const [l, a] of [...byLang.entries()].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`  ${l.padEnd(12)} ${String(a.length).padStart(5)}`)
}
