/**
 * Symbol-set fidelity probe: sidecar (my Rust port) vs dsh-forge's own WASM
 * collector (lib/ast.js) on the SAME real files.
 *
 *   node rust_indexer/probe-kinds.mjs <file...>
 *
 * This isolates one question: where dsh-forge's hits differ from ProjectForge's,
 * is that a deviation introduced by the Rust port, or pre-existing behaviour
 * inherited from ast.ts? If Rust and WASM agree, the divergence is ast.ts's.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseFileSearch } from '../lib/ast.js'

const EXE = fileURLToPath(new URL('./bin/dsh_forge_indexer.exe', import.meta.url))
const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node rust_indexer/probe-kinds.mjs <file...>')
  process.exit(1)
}

class Sidecar {
  #child; #seq = 1; #pending = new Map(); #buf = ''
  constructor(exe) {
    this.#child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => {
      this.#buf += chunk
      let nl
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, nl)
        this.#buf = this.#buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        const p = this.#pending.get(msg.id)
        if (p) { this.#pending.delete(msg.id); p(msg) }
      }
    })
  }
  request(method, params = {}) {
    const id = this.#seq++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (m) => (m.ok ? resolve(m) : reject(new Error(JSON.stringify(m.error)))))
      this.#child.stdin.write(JSON.stringify({ id, method, ...params }) + '\n')
    })
  }
  kill() { try { this.#child.kill() } catch { /* gone */ } }
}

const side = new Sidecar(EXE)
await side.request('ping', {})

const key = (s) => `${s.kind}\u0000${s.qualifiedName}\u0000${s.startLine}`
const hist = (arr) => {
  const m = new Map()
  for (const s of arr) m.set(s.kind, (m.get(s.kind) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')
}
// findSymbols searches the whole tree, so compare nested children too — the
// bulk of the extra `field` symbols live inside interfaces/structs/objects.
const flatten = (syms, out = []) => {
  for (const s of syms) {
    out.push(s)
    if (Array.isArray(s.children) && s.children.length > 0) flatten(s.children, out)
  }
  return out
}

let total = 0
for (const f of files) {
  const r = await side.request('parseBatch', { files: [f] })
  const rust = flatten(r.results?.[0]?.symbols ?? [])
  const parsed = await parseFileSearch(f)
  const wasm = flatten(parsed?.value?.symbols ?? [])

  const rs = new Set(rust.map(key))
  const ws = new Set(wasm.map(key))
  const onlyRust = [...rs].filter((k) => !ws.has(k))
  const onlyWasm = [...ws].filter((k) => !rs.has(k))
  total += onlyRust.length + onlyWasm.length

  console.log(`\n${f.replace(/\\/g, '/').split('/').slice(-3).join('/')}`)
  console.log(`  rust n=${rust.length}   ${hist(rust)}`)
  console.log(`  wasm n=${wasm.length}   ${hist(wasm)}`)
  console.log(`  only-rust=${onlyRust.length}  only-wasm=${onlyWasm.length}`)
  for (const k of onlyRust.slice(0, 4)) console.log(`    +R  ${k.split('\u0000')[0].padEnd(10)} ${k.split('\u0000')[1]}`)
  for (const k of onlyWasm.slice(0, 4)) console.log(`    +W  ${k.split('\u0000')[0].padEnd(10)} ${k.split('\u0000')[1]}`)
}

side.kill()
console.log(`\nTOTAL (kind,qualified,line) differences across ${files.length} file(s): ${total}`)
