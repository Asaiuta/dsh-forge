/**
 * Head-to-head: latest ProjectForge indexer vs dsh-forge sidecar.
 *
 *   node rust_indexer/compare-projectforge.mjs <root> [query] [limit]
 *
 * Both sides expose a directory-scanning name search:
 *   ProjectForge  findSymbols { root, name, limit }  -> { hits, total, scanned, parsed }
 *   dsh-forge     findSymbolsRoot { root, name }     -> { items, parsed, reparsed }
 *
 * Both are cleared and then queried cold, then queried again warm, so the
 * cold number is real parsing and the warm number is the cache path. The two
 * protocols differ in shape (ProjectForge nests args under `params` and wraps
 * its payload in `result`; dsh-forge is flat), hence the `nested` flag.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PF_EXE = process.env.PF_EXE
if (!PF_EXE) { console.error('set PF_EXE to the ProjectForge indexer binary'); process.exit(1) }
const DF_EXE = fileURLToPath(new URL('./bin/dsh_forge_indexer.exe', import.meta.url))

const ROOT = process.argv[2] ?? process.cwd()
const QUERY = process.argv[3] ?? 'name'
const LIMIT = Number(process.argv[4] ?? 200000)
const TIMEOUT = 600000

class Sidecar {
  #child; #seq = 1; #pending = new Map(); #buf = ''
  constructor(label, exe, nested) {
    this.label = label
    this.nested = nested
    this.ready = null
    this.stderr = ''
    this.#child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (c) => this.#onData(c))
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (c) => { this.stderr += c })
  }
  #onData(chunk) {
    this.#buf += chunk
    let nl
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl)
      this.#buf = this.#buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'ready') { this.ready = msg; continue }
      const p = this.#pending.get(msg.id)
      if (!p) continue
      this.#pending.delete(msg.id)
      if (msg.ok === false || msg.error) p.reject(new Error(msg.error?.message ?? JSON.stringify(msg)))
      else p.resolve(this.nested ? msg.result : msg)
    }
  }
  request(method, args = {}) {
    const id = this.#seq++
    const payload = this.nested ? { id, method, params: args } : { id, method, ...args }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${this.label} ${method} timed out after ${TIMEOUT}ms`))
      }, TIMEOUT)
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) },
      })
      this.#child.stdin.write(JSON.stringify(payload) + '\n')
    })
  }
  kill() { try { this.#child.kill() } catch { /* already gone */ } }
}

const now = () => process.hrtime.bigint()
const ms = (t) => Number((Number(t) / 1e6).toFixed(1))
const n = (v) => (v === undefined || v === null ? '—' : String(v))

const pf = new Sidecar('ProjectForge', PF_EXE, true)
const df = new Sidecar('dsh-forge', DF_EXE, false)

// Handshake: dsh-forge answers `ping`; ProjectForge announces itself unasked.
await pf.request('ping')
await df.request('ping')
await new Promise((r) => setTimeout(r, 250))

console.log(`root  : ${ROOT}`)
console.log(`query : "${QUERY}"`)
for (const s of [pf, df]) {
  console.log(`${s.label.padEnd(13)} protocol=${n(s.ready?.protocolVersion)} languages=[${(s.ready?.languages ?? []).join(',')}]`)
}
console.log()

// --- ProjectForge: cold then warm -------------------------------------------
await pf.request('clearCache')
let t = now()
const pfCold = await pf.request('findSymbols', { root: ROOT, name: QUERY, limit: LIMIT })
const pfColdMs = ms(now() - t)

t = now()
const pfWarm = await pf.request('findSymbols', { root: ROOT, name: QUERY, limit: LIMIT })
const pfWarmMs = ms(now() - t)

// --- dsh-forge: cold then warm ----------------------------------------------
await df.request('resetCache')
t = now()
const dfCold = await df.request('findSymbolsRoot', { root: ROOT, name: QUERY })
const dfColdMs = ms(now() - t)

t = now()
const dfWarm = await df.request('findSymbolsRoot', { root: ROOT, name: QUERY })
const dfWarmMs = ms(now() - t)

pf.kill()
df.kill()

const row = (label, msec, detail) => console.log(`  ${label.padEnd(9)} ${String(msec).padStart(9)} ms   ${detail}`)

console.log(`name search over the whole root (query "${QUERY}")`)
row('PF cold', pfColdMs, `scanned=${n(pfCold?.scanned)} parsed=${n(pfCold?.parsed)} total=${n(pfCold?.total)} truncated=${n(pfCold?.truncated)}`)
row('PF warm', pfWarmMs, `scanned=${n(pfWarm?.scanned)} parsed=${n(pfWarm?.parsed)} total=${n(pfWarm?.total)} truncated=${n(pfWarm?.truncated)}`)
console.log()
row('DF cold', dfColdMs, `allSupported=${n(dfCold?.allSupported)} scanned=${n(dfCold?.parsed)} reparsed=${n(dfCold?.reparsed)} items=${n(dfCold?.items?.length)}`)
row('DF warm', dfWarmMs, `allSupported=${n(dfWarm?.allSupported)} scanned=${n(dfWarm?.parsed)} reparsed=${n(dfWarm?.reparsed)} items=${n(dfWarm?.items?.length)}`)
console.log()
console.log(`  cold ratio (dsh-forge / ProjectForge): ${(dfColdMs / pfColdMs).toFixed(2)}x`)
console.log(`  warm ratio (dsh-forge / ProjectForge): ${(dfWarmMs / pfWarmMs).toFixed(2)}x`)
console.log(`  hits: PF total=${n(pfCold?.total)}   DF items=${n(dfCold?.items?.length)}`)

// The two sides can disagree on HOW MANY symbols exist (different collectors),
// so show what each actually matched before comparing their clocks.
const hist = (rows, kindOf) => {
  const m = new Map()
  for (const r of rows) { const k = kindOf(r) ?? '?'; m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')
}
const pfHits = pfCold?.hits ?? []
const dfHits = dfCold?.items ?? []
console.log(`\n  PF kinds: ${hist(pfHits, (h) => h.kind)}`)
console.log(`  DF kinds: ${hist(dfHits, (h) => h.kind)}`)
console.log(`\n  PF sample: ${pfHits.slice(0, 6).map((h) => `${h.qualified ?? h.name}@${(h.path ?? '').split('/').pop()}`).join('  ')}`)
console.log(`  DF sample: ${dfHits.slice(0, 6).map((h) => `${h.qualifiedName}@${(h.absPath ?? '').split(/[\\/]/).pop()}`).join('  ')}`)

// Are the two sets even the same symbols? Compare (file, qualified) pairs.
// ProjectForge reports a root-relative posix `path`; dsh-forge an absolute
// `absPath`, so normalise both onto the same root-relative posix form.
const norm = (p) => String(p).toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '')
if (process.env.DEBUG_PATHS) {
  console.log(`\n  [debug] ROOT=${ROOT}`)
  console.log(`  [debug] PF paths: ${pfHits.slice(0, 3).map((h) => h.path).join('  |  ')}`)
  console.log(`  [debug] DF rel  : ${dfHits.slice(0, 3).map((h) => norm(path.relative(ROOT, h.absPath))).join('  |  ')}`)
  console.log(`  [debug] DF abs  : ${dfHits.slice(0, 2).map((h) => h.absPath).join('  |  ')}`)
}
const pfSet = new Set(pfHits.map((h) => `${norm(h.path)}::${norm(h.qualified ?? h.name)}`))
const dfSet = new Set(dfHits.map((h) => `${norm(path.relative(ROOT, h.absPath))}::${norm(h.qualifiedName)}`))
let shared = 0
for (const k of pfSet) if (dfSet.has(k)) shared++
console.log(`\n  exact (file::qualified) overlap: ${shared}  (PF ${pfSet.size}, DF ${dfSet.size})`)
console.log(`  DF-only: ${dfSet.size - shared}   PF-only: ${pfSet.size - shared}`)
const sample = (set, other, label) => {
  const only = [...set].filter((k) => !other.has(k)).slice(0, 5)
  console.log(`  ${label} sample: ${only.map((k) => k.split('::').slice(-1)[0] + ' @ ' + k.split('::')[0]).join('  |  ')}`)
}
sample(dfSet, pfSet, 'DF-only')
sample(pfSet, dfSet, 'PF-only')

// dsh-forge emits struct/interface fields as first-class symbols; ProjectForge
// largely does not. Re-run the overlap with `field` excluded to separate a
// genuine set divergence from a taxonomy one.
const pfNoField = pfHits.filter((h) => h.kind !== 'field')
const dfNoField = dfHits.filter((h) => h.kind !== 'field')
const pfNF = new Set(pfNoField.map((h) => `${norm(h.path)}::${norm(h.qualified ?? h.name)}`))
const dfNF = new Set(dfNoField.map((h) => `${norm(path.relative(ROOT, h.absPath))}::${norm(h.qualifiedName)}`))
let sharedNF = 0
for (const k of pfNF) if (dfNF.has(k)) sharedNF++
console.log(`\n  excluding 'field': PF ${pfNF.size}, DF ${dfNF.size}, overlap ${sharedNF}`)
console.log(`  non-field recall: DF covers ${((sharedNF / Math.max(1, pfNF.size)) * 100).toFixed(0)}% of PF's symbols; PF covers ${((sharedNF / Math.max(1, dfNF.size)) * 100).toFixed(0)}% of DF's`)

// A different qualification convention (`Trait::name` vs `name`) would look like
// a miss above. Re-run on (file::bareName) to separate true misses from naming.
const bare = (q) => String(q).split(/::|\./).filter(Boolean).pop() ?? ''
const pfBare = new Set(pfNoField.map((h) => `${norm(h.path)}::${norm(bare(h.qualified ?? h.name))}`))
const dfBare = new Set(dfNoField.map((h) => `${norm(path.relative(ROOT, h.absPath))}::${norm(bare(h.qualifiedName))}`))
let sharedBare = 0
for (const k of pfBare) if (dfBare.has(k)) sharedBare++
console.log(`  ignoring qualification (file::bareName): PF ${pfBare.size}, DF ${dfBare.size}, overlap ${sharedBare}`)
console.log(`  true recall on bare names: DF covers ${((sharedBare / Math.max(1, pfBare.size)) * 100).toFixed(0)}% of PF's; PF covers ${((sharedBare / Math.max(1, dfBare.size)) * 100).toFixed(0)}% of DF's`)
for (const s of [pf, df]) {
  if (s.stderr.trim()) console.log(`\n  [${s.label} stderr] ${s.stderr.trim().split('\n').slice(0, 5).join(' | ')}`)
}
