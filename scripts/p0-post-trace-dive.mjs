/** Post-trace dive: what did the model do AFTER fftrace returned, and did trace already contain it?
 *
 *   node scripts/p0-post-trace-dive.mjs <mangled-workspace-dir>
 *
 * The argument is the directory name under `~/.dsh/sessions/` (the workspace's
 * absolute path with separators replaced by `-`). */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'

const workspace = process.argv[2]
if (!workspace) { console.error('usage: node scripts/p0-post-trace-dive.mjs <mangled-workspace-dir>'); process.exit(1) }
const dir = path.join(os.homedir(), '.dsh/sessions', workspace)
const MAG = 0xFD2FB528

function decode(file) {
  const buf = fs.readFileSync(file)
  let txt = ''
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === MAG) {
      try { txt += zlib.zstdDecompressSync(buf.subarray(i)).toString('utf8') } catch { /* partial */ }
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

for (const s of sessions) {
  const calls = s.events.filter(e => e.type === 'tool/call').map(e => {
    let args = {}
    try { args = JSON.parse(e.data.arguments ?? '{}') } catch { /* raw */ }
    return { id: e.data.callId, name: e.data.name, args }
  })
  const traceIdx = calls.findIndex(c => c.name === 'fftrace')
  if (traceIdx < 0) continue
  const results = new Map()
  for (const e of s.events.filter(e => e.type === 'tool/result')) {
    const id = e.data?.message?.toolCallId ?? e.data?.message?.source?.callId ?? e.data?.callId
    const text = (e.data?.message?.content ?? []).map(c => c.text ?? '').join('')
    if (id) results.set(id, text || JSON.stringify(e.data?.message ?? {}))
  }
  const prompt = s.events.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'user').map(e => (e.data.content ?? []).map(c => c.text ?? '').join(''))[0] ?? ''
  const trace = calls[traceIdx]
  const traceText = results.get(trace.id) ?? '(no result captured)'
  console.log(`\n########## ${s.id} ${new Date(s.createdAt).toLocaleTimeString()} :: ${prompt.replace(/\s+/g, ' ').slice(0, 50)}`)
  console.log(`TRACE ${trace.args.target} -> found:${/found":\s*true/.test(traceText) ? 'true' : '?'} len:${traceText.length}`)
  console.log('TRACE TEXT HEAD:\n' + traceText.slice(0, 900).replaceAll('\n', '\n| '))
  const post = calls.slice(traceIdx + 1)
  console.log(`\nPOST-TRACE CALLS (${post.length}):`)
  for (const c of post) {
    const a = c.args
    const brief = c.name === 'read' ? `${a.path ?? ''}${a.lines ? ' lines=' + a.lines : ''}${a.view ? ' view=' + a.view : ''}${a.symbol ? ' symbol=' + a.symbol : ''}`
      : c.name === 'grep' ? `pattern=${String(a.pattern ?? '').slice(0, 50)} path=${a.path ?? ''}`
      : c.name === 'glob' ? `pattern=${a.pattern ?? ''}`
      : c.name === 'ops_bash' || c.name === 'pwsh' ? String(a.command ?? a.script ?? '').slice(0, 70).replace(/\s+/g, ' ')
      : JSON.stringify(a).slice(0, 70)
    // was this target already present in the trace output?
    const target = String(a.path ?? a.pattern ?? '')
    const covered = target.length > 3 && traceText.includes(target.replace(/^.*[\\/]/, '').slice(0, 24))
    console.log(`  [${c.name}]${covered ? '(已在trace中)' : ''} ${brief.slice(0, 110)}`)
  }
}
