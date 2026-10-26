/** P0 adoption attribution: decode DSH session frames and summarize tool usage per prompt.
 *
 *   node scripts/p0-adoption-report.mjs <mangled-workspace-dir>
 *
 * The argument is the directory name under `~/.dsh/sessions/` (the workspace's
 * absolute path with separators replaced by `-`). */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'

const workspace = process.argv[2]
if (!workspace) { console.error('usage: node scripts/p0-adoption-report.mjs <mangled-workspace-dir>'); process.exit(1) }
const dir = path.join(os.homedir(), '.dsh/sessions', workspace)
const MAG = 0xFD2FB528

function decode(file) {
  const buf = fs.readFileSync(file)
  let txt = ''
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === MAG) {
      try { txt += zlib.zstdDecompressSync(buf.subarray(i)).toString('utf8') } catch { /* trailing partial frame */ }
    }
  }
  return txt.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const sessions = fs.readdirSync(dir).filter(n => n.startsWith('session-')).map(n => {
  const file = path.join(dir, n, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(file)) return null
  const events = decode(file)
  const header = events.find(e => e.type === 'session')
  return header ? { id: n.slice(8, 16), createdAt: header.createdAt, events } : null
}).filter(Boolean).filter(s => s.createdAt > Date.parse('2026-10-25T16:00:00Z').valueOf()).sort((a, b) => a.createdAt - b.createdAt)

const textOf = data => (data?.content ?? []).map(c => c.text ?? '').join('')

const rows = []
for (const s of sessions) {
  const prompt = s.events.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'user').map(e => textOf(e.data))[0] ?? '(无用户输入)'
  const calls = s.events.filter(e => e.type === 'tool/call').map(e => {
    let args = {}
    try { args = JSON.parse(e.data.arguments ?? '{}') } catch { /* non-JSON */ }
    return { name: e.data.name, args }
  })
  const assistants = s.events.filter(e => e.type === 'assistant/message')
  const final = assistants.length ? textOf(assistants[assistants.length - 1].data?.message ?? assistants[assistants.length - 1].data) : ''
  const cite = (final.match(/[\w./\\-]+\.(?:js|json|html|ts|css|md)[:：]\d+/g) ?? []).length
  const traceIdx = calls.findIndex(c => c.name === 'fftrace')
  const before = traceIdx >= 0 ? calls.slice(0, traceIdx) : calls
  const manualBefore = before.filter(c => ['read', 'grep', 'glob', 'ff_read'].includes(c.name)).length
  const manualAfter = traceIdx >= 0 ? calls.slice(traceIdx + 1).filter(c => ['read', 'grep', 'glob', 'ff_read'].includes(c.name)).length : 0
  const counts = {}
  for (const c of calls) counts[c.name] = (counts[c.name] ?? 0) + 1
  const traceResult = traceIdx >= 0
    ? s.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data)).find(t => t.includes('fftrace') || /file:|impact:|path:|ipc:|api:|global:|page:/.test(t)) ?? ''
    : ''
  const found = /"found":\s*true/.test(traceResult) ? 'found=true' : /"found":\s*false/.test(traceResult) ? 'found=FALSE' : ''
  rows.push({
    id: s.id, time: new Date(s.createdAt).toLocaleTimeString(),
    prompt: prompt.replace(/\s+/g, ' ').slice(0, 46),
    total: calls.length, counts,
    traceFirst: traceIdx === 0, traceIdx: traceIdx + 1,
    traceTarget: traceIdx >= 0 ? String(calls[traceIdx].args.target ?? '') : '',
    manualBefore, manualAfter, cite, finalLen: final.length, found,
  })
}
for (const r of rows) {
  console.log(`${r.time} | ${r.prompt}`)
  console.log(`   traceFirst=${r.traceFirst} pos=${r.traceIdx} target=${r.traceTarget || '—'} ${r.found} | 手工前=${r.manualBefore} 手工后=${r.manualAfter} | 引用:行=${r.cite} 答案长=${r.finalLen} | ${JSON.stringify(r.counts)}`)
}
