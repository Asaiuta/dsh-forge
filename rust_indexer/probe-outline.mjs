/**
 * Per-file outline comparison: ProjectForge's `outline {text, lang}` vs
 * dsh-forge's `parseBatch {files}` on the SAME file.
 *
 *   node rust_indexer/probe-outline.mjs <file> [nameFilter]
 *
 * This removes the walk/search layer and asks the narrowest question: given one
 * file's text, do the two collectors extract the same definitions? Any gap here
 * is a collector difference, not a scanning-policy one.
 */

import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PF_EXE = process.env.PF_EXE
if (!PF_EXE) { console.error('set PF_EXE to the ProjectForge indexer binary'); process.exit(1) }
const DF_EXE = fileURLToPath(new URL('./bin/dsh_forge_indexer.exe', import.meta.url))

const FILE = process.argv[2]
const FILTER = process.argv[3] ?? ''
if (!FILE) { console.error('usage: node rust_indexer/probe-outline.mjs <file...> [nameFilter]'); process.exit(1) }
// Accept several files so extraction-level agreement can be aggregated.
const FILE_LIST = process.argv.slice(2).filter((a) => !a.startsWith('--') && /\.[a-z]+$/i.test(a))

const EXT_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx', '.py': 'python', '.rs': 'rust',
  '.c': 'c', '.h': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
  '.go': 'go', '.java': 'java', '.cs': 'c_sharp', '.lua': 'lua',
}
const ext = FILE.slice(FILE.lastIndexOf('.'))
if (!EXT_LANG[ext]) { console.error(`unsupported extension ${ext}`); process.exit(1) }

class Sidecar {
  #child; #seq = 1; #pending = new Map(); #buf = ''
  constructor(label, exe, nested) {
    this.label = label; this.nested = nested; this.ready = null
    this.#child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => {
      this.#buf += chunk
      let nl
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, nl); this.#buf = this.#buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg; try { msg = JSON.parse(line) } catch { continue }
        if (msg.type === 'ready') { this.ready = msg; continue }
        const p = this.#pending.get(msg.id)
        if (p) { this.#pending.delete(msg.id); p(msg) }
      }
    })
  }
  request(method, args = {}) {
    const id = this.#seq++
    const payload = this.nested ? { id, method, params: args } : { id, method, ...args }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (m) => {
        if (m.ok === false || m.error) reject(new Error(JSON.stringify(m.error)))
        else resolve(this.nested ? m.result : m)
      })
      this.#child.stdin.write(JSON.stringify(payload) + '\n')
    })
  }
  kill() { try { this.#child.kill() } catch { /* gone */ } }
}

const pf = new Sidecar('ProjectForge', PF_EXE, true)
const df = new Sidecar('dsh-forge', DF_EXE, false)
await pf.request('ping', {})
await df.request('ping', {})

const flatten = (syms, out = []) => {
  for (const s of syms) { out.push(s); if (s.children?.length) flatten(s.children, out) }
  return out
}
const hist = (a) => {
  const m = new Map()
  for (const s of a) m.set(s.kind, (m.get(s.kind) ?? 0) + 1)
  return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join('  ')
}
const bare = (q) => String(q).split(/::|\./).filter(Boolean).pop() ?? ''

// Extraction-level comparison. The search POLICIES differ (ProjectForge is
// case-insensitive substring; dsh-forge is case-sensitive suffix), so compare
// the symbol SETS each collector produces for identical text. Key only on
// (kind, qualified) — ProjectForge's outline does not expose a line field we
// can read, and including an undefined one would make every key unmatchable.
const keyQ = (s) => `${s.kind}\u0000${s.qualified}`
const keyB = (s) => `${s.kind}\u0000${bare(s.qualified)}`
// Kind labels differ by design (ProjectForge: method; dsh-forge: function), so
// also compare on the qualified name alone to separate a labelling difference
// from a genuine set difference.
const keyN = (s) => s.qualified

let T = { pf: 0, df: 0, shQ: 0, shB: 0, shN: 0, pfB: 0, dfB: 0 }
const table = []

for (const file of FILE_LIST) {
  const ext = file.slice(file.lastIndexOf('.'))
  const lang = EXT_LANG[ext]
  if (!lang) { console.log(`  skip ${file} (unsupported ${ext})`); continue }
  const text = readFileSync(file, 'utf8')
  const pfOut = await pf.request('outline', { text, lang })
  const dfRes = await df.request('parseBatch', { files: [file] })
  const pfSyms = flatten(pfOut?.symbols ?? []).map((s) => ({
    name: s.name, qualified: s.qualified ?? s.name, kind: s.kind, line: s.startLine,
  }))
  const dfSyms = flatten(dfRes?.results?.[0]?.symbols ?? []).map((s) => ({
    name: s.name ?? String(s.qualifiedName).split(/::|\./).pop(),
    qualified: s.qualifiedName, kind: s.kind, line: s.startLine,
  }))

  const pq = new Set(pfSyms.map(keyQ)); const dq = new Set(dfSyms.map(keyQ))
  const pb = new Set(pfSyms.map(keyB)); const db = new Set(dfSyms.map(keyB))
  const pn = new Set(pfSyms.map(keyN)); const dn = new Set(dfSyms.map(keyN))
  const shQ = [...pq].filter((k) => dq.has(k)).length
  const shB = [...pb].filter((k) => db.has(k)).length
  const shN = [...pn].filter((k) => dn.has(k)).length
  T.pf += pq.size; T.df += dq.size; T.shQ += shQ; T.shB += shB; T.shN += shN
  T.pfB += pb.size; T.dfB += db.size; T.pfN = (T.pfN ?? 0) + pn.size; T.dfN = (T.dfN ?? 0) + dn.size

  const name = file.replace(/\\/g, '/').split('/').pop()
  table.push(`${name.padEnd(26)} PF ${String(pn.size).padStart(4)}  DF ${String(dn.size).padStart(4)}  qual-shared ${String(shN).padStart(4)}  kind+qual ${String(shQ).padStart(4)}`)

  if (FILE_LIST.length === 1) {
    console.log(`${name}  (lang=${lang}, ${text.split('\n').length} lines)`)
    console.log(`  PF outline: n=${pfSyms.length}   ${hist(pfSyms)}`)
    console.log(`  DF parse  : n=${dfSyms.length}   ${hist(dfSyms)}`)
    const pkq = (s) => keyQ(s)
    const onlyPf = pfSyms.filter((s) => !dq.has(pkq(s)))
    const onlyDf = dfSyms.filter((s) => !pq.has(pkq(s)))
    console.log(`  exact diff: only-PF=${onlyPf.length}  only-DF=${onlyDf.length}`)
    const show = (label, rr) => {
      const f = FILTER ? rr.filter((r) => r.name === FILTER || r.qualified.includes(FILTER)) : rr
      console.log(`\n  ${label}${FILTER ? ` (name~"${FILTER}")` : ''}: ${f.length}`)
      for (const r of f.slice(0, Number(process.env.N ?? 14))) console.log(`    ${String(r.line).padStart(5)}  ${r.kind.padEnd(10)} ${r.qualified}`)
    }
    show('only in ProjectForge', onlyPf)
    show('only in dsh-forge', onlyDf)
  }
}

if (FILE_LIST.length > 1) {
  for (const line of table) console.log(`  ${line}`)
  console.log(`\n  TOTAL over ${FILE_LIST.length} files`)
  console.log(`    symbols extracted : PF ${T.pf}   DF ${T.df}`)
  console.log(`    qualified only    : shared ${T.shN}  -> DF covers ${((T.shN / Math.max(1, T.pfN)) * 100).toFixed(0)}% of PF, PF covers ${((T.shN / Math.max(1, T.dfN)) * 100).toFixed(0)}% of DF`)
  console.log(`    exact (kind+qual) : shared ${T.shQ}  -> DF covers ${((T.shQ / Math.max(1, T.pf)) * 100).toFixed(0)}% of PF, PF covers ${((T.shQ / Math.max(1, T.df)) * 100).toFixed(0)}% of DF`)
}

pf.kill(); df.kill()

