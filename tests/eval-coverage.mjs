/**
 * Scenario coverage matrix: dsh-forge tool chains vs ProjectForge tool chains.
 *
 * Goal: show the tools are COMPLEMENTARY, not redundant — every real locate
 * scenario is expressible by at least one chain, and no single chain is
 * universal. ProjectForge is driven at its real capability surface:
 *   - the shipped indexer binary (protocol 3): findSymbols / outline / facts
 *   - the plugin's pure-function engine (engine.js): its content search
 *     (`ReadCode find=`) is anchor matching over caller-supplied files, NOT a
 *     workspace grep.
 *
 * dsh-forge chains:
 *   grep        ffgrep(pattern)
 *   grep+enc    ffgrep(pattern, enclosing:true)
 *   grep→read   ffgrep(enclosing) → ff_read_symbol
 *   find        ff_find_symbol(name)
 *   find→read   ff_find_symbol(name) → ff_read_symbol
 *   outline→read ff_outline(file) → ff_read_symbol
 *   read#sym    ff_read("file#Qualified.Symbol")
 *   fffind      fffind(fileName)
 *   multi       fff_multi_grep(patterns[])
 *
 * ProjectForge chains:
 *   pf FindSymbol   indexer findSymbols(name)
 *   pf Outline      indexer outline(file text)
 *   pf read#sym     indexer outline range ("file#qualified" read contract)
 *   pf find         ReadCode find= over a glob (anchor match, 200-file cap)
 *
 * Cell states: ok / miss / · (not expressible, or provider unavailable).
 *
 * Floors: every visible scenario located by >=1 dsh-forge chain; no
 * definitely-ignored (gitignored) scenario located by a dsh-forge chain.
 * ProjectForge availability is optional; its results are reported, and any
 * gitignore leak on its side is reported as a finding (not a hard failure).
 *
 * @module dsh-forge/tests/eval-coverage
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { FinderPool } from '../lib/core.js'
import { createGrepTool, createFindTool, createMultiGrepTool } from '../lib/tools.js'
import { createOutlineTool, createFindSymbolTool, createReadSymbolTool } from '../lib/tools-symbol.js'
import { createReadTool } from '../lib/tools-read.js'
import { buildFixture, FIXTURE_DIR } from './make-fixture.mjs'
import { localEnv } from '../scripts/local-env.mjs'

const require = createRequire(import.meta.url)
// Both ProjectForge paths live outside this repository (CC BY-NC-SA — must never
// ship). Unset means the ProjectForge column reports as unavailable.
const PF_EXE = localEnv('DSH_FORGE_PF_EXE')
const PF_PLUGIN = localEnv('DSH_FORGE_PF_PLUGIN')

const truth = buildFixture()

function lineOf(rel, token) {
  const lines = readFileSync(path.join(FIXTURE_DIR, rel), 'utf8').replace(/\r\n/g, '\n').split('\n')
  const idx = lines.findIndex((l) => l.includes(token))
  if (idx === -1) throw new Error(`fixture drift: "${token}" not in ${rel}`)
  return idx + 1
}

const S = (o) => ({ mode: 'plain', name: null, file: null, fileName: null, patterns: null, expect: 'visible', ...o })

const SCENARIOS = [
  S({ id: 'A1', kind: '寻址', question: 'js 顶层函数定义', name: 'isEmail', pattern: 'isEmail', file: 'src/validate.js', target: { file: 'src/validate.js', line: truth.validateIsEmail } }),
  S({ id: 'A2', kind: '寻址', question: 'js 类方法定义', name: 'Store.putBlob', pattern: 'putBlob(buffer)', file: 'src/store.js', target: { file: 'src/store.js', line: truth.storePutBlob } }),
  S({ id: 'A3', kind: '寻址', question: 'js 函数（带 JSDoc）', name: 'greet', pattern: 'export function greet', file: 'src/doced.js', target: { file: 'src/doced.js', line: truth.docedGreet } }),
  S({ id: 'A4', kind: '寻址', question: 'js const-arrow 声明', name: 'shout', pattern: 'const shout', file: 'src/doced.js', target: { file: 'src/doced.js', line: truth.docedShout } }),
  S({ id: 'A5', kind: '寻址', question: 'ts 接口定义', name: 'User', pattern: 'export interface User', file: 'src/nested/deep.ts', target: { file: 'src/nested/deep.ts', line: 1 } }),
  S({ id: 'A6', kind: '寻址', question: 'ts 类方法定义', name: 'UserService.getUser', pattern: 'getUser(id', file: 'src/nested/deep.ts', target: { file: 'src/nested/deep.ts', line: lineOf('src/nested/deep.ts', 'getUser(id') } }),
  S({ id: 'A7', kind: '寻址', question: 'py 函数定义', name: 'normalize_path', pattern: 'def normalize_path', file: 'lib/utils.py', target: { file: 'lib/utils.py', line: lineOf('lib/utils.py', 'def normalize_path') } }),
  S({ id: 'A8', kind: '寻址', question: 'py 类方法定义', name: 'Cache.put', pattern: 'def put(self', file: 'lib/utils.py', target: { file: 'lib/utils.py', line: lineOf('lib/utils.py', 'def put(self') } }),
  S({ id: 'A9', kind: '寻址', question: 'rust impl 方法（:: 分隔）', name: 'Config::default_weight', pattern: 'pub fn default_weight', file: 'lib/scoring.rs', target: { file: 'lib/scoring.rs', line: truth.rsDefaultWeight } }),
  S({ id: 'A10', kind: '寻址', question: 'go 方法定义', name: 'Greeter.Greet', pattern: 'func (g Greeter) Greet', file: 'cmd/server.go', target: { file: 'cmd/server.go', line: truth.goGreet } }),
  S({ id: 'A11', kind: '寻址', question: 'go 顶层函数 main', name: 'main', pattern: 'func main()', file: 'cmd/server.go', target: { file: 'cmd/server.go', line: truth.goMain } }),

  S({ id: 'B1', kind: '发现', question: '字符串字面量（中文错误信息）', pattern: '邮箱格式不正确', target: { file: 'src/login.js', line: lineOf('src/login.js', '邮箱格式不正确') } }),
  S({ id: 'B2', kind: '发现', question: '调用点（用法，非定义）', pattern: 'store.putBlob(', target: { file: 'src/login.js', line: lineOf('src/login.js', 'store.putBlob(') } }),
  S({ id: 'B3', kind: '发现', question: 'markdown 文档里的内容', pattern: 'Call `putBlob`', target: { file: 'docs/guide.md', line: lineOf('docs/guide.md', 'Call `putBlob`') } }),
  S({ id: 'B4', kind: '发现', question: '中文文档内容（多字节）', pattern: '中文标记', target: { file: 'data/unicode.md', line: lineOf('data/unicode.md', '中文标记') } }),
  S({ id: 'B5', kind: '发现', question: '拼写容错（fuzzy）', pattern: 'normailze_path', mode: 'fuzzy', target: { file: 'lib/utils.py', line: lineOf('lib/utils.py', 'def normalize_path') } }),
  S({ id: 'B6', kind: '发现', question: '正则模式', pattern: 'function\\s+(submit|showError)', mode: 'regex', target: { file: 'src/login.js', line: lineOf('src/login.js', 'function submit') } }),
  S({ id: 'B7', kind: '发现', question: '非代码文本常量', pattern: 'CRLF_TOKEN', target: { file: 'data/crlf.txt', line: truth.crlfToken } }),
  S({ id: 'B8', kind: '发现', question: '源码注释内容', pattern: 'Blob store with dedup', target: { file: 'src/store.js', line: lineOf('src/store.js', 'Blob store with dedup') } }),

  S({ id: 'C1', kind: '文件', question: '按文件名精确找', fileName: 'server.go', target: { file: 'cmd/server.go', line: 1 } }),
  S({ id: 'C2', kind: '文件', question: '按文件名拼错找', fileName: 'scorng', target: { file: 'lib/scoring.rs', line: 1 } }),
  S({ id: 'C3', kind: '文件', question: '按路径线索找', fileName: 'nested deep', target: { file: 'src/nested/deep.ts', line: 1 } }),

  S({ id: 'D1', kind: '边界', question: 'gitignored build/ 内容不可见', pattern: 'IGNORED_BUILD_TOKEN', expect: 'hidden', target: { file: 'build/generated.js', line: 2 } }),
  S({ id: 'D2', kind: '边界', question: 'gitignored logs/ 内容不可见', pattern: 'IGNORED_LOG_TOKEN', expect: 'hidden', target: { file: 'logs/app.log', line: 1 } }),

  S({ id: 'E1', kind: '多模式', question: 'OR 多模式一次扫（改名验证）', patterns: ['putBlob', 'getBlob'], target: { file: 'src/store.js', line: truth.storePutBlob } }),
]

// ---------------------------------------------------------------------------
const pool = new FinderPool()
const grep = createGrepTool(pool)
const fffind = createFindTool(pool)
const multiGrep = createMultiGrepTool(pool)
const outline = createOutlineTool()
const findSymbol = createFindSymbolTool()
const readSymbol = createReadSymbolTool()
const read = createReadTool()

const exec = { agent: { session: { header: { cwd: FIXTURE_DIR, id: 'eval-coverage' } } }, token: {} }
const b = (s) => Buffer.byteLength(String(s ?? ''), 'utf8')
const sumB = (arr) => arr.reduce((s, x) => s + b(x), 0)
const norm = (p) => String(p).split(path.sep).join('/')
const covered = (s, start, end) => start <= s.line && s.line <= end
const parseRange = (spec) => {
  const m = /^L(\d+)(?:-(\d+))?$/.exec(String(spec ?? ''))
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null
}

// ---------------------------------------------------------------------------
// ProjectForge driver: indexer binary + plugin pure-function engine
// ---------------------------------------------------------------------------
class PfIndexer {
  constructor() { this.proc = null; this.buf = ''; this.pending = new Map(); this.id = 1 }
  async start() {
    this.proc = spawn(PF_EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('PF ready timeout')), 15000)
      this.proc.on('error', () => { clearTimeout(t); rej(new Error('PF spawn failed')) })
      this.proc.stdout.on('data', (d) => {
        this.buf += d.toString()
        let i
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const l = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1)
          if (!l) continue
          let m; try { m = JSON.parse(l) } catch { continue }
          if (m.type === 'ready') { clearTimeout(t); res(m); continue }
          if (m.id !== undefined && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) }
        }
      })
    })
  }
  call(method, params) {
    return new Promise((res) => {
      const i = this.id++
      const t = setTimeout(() => { this.pending.delete(i); res({ ok: false, error: { code: 'TIMEOUT' } }) }, 60000)
      this.pending.set(i, m => { clearTimeout(t); res(m) })
      this.proc.stdin.write(JSON.stringify({ id: i, method, params }) + '\n')
    })
  }
  stop() { try { this.proc?.stdin.end() } catch { /* ignore */ } this.proc?.kill() }
}

let pfIndexer = null
if (PF_EXE) { try { pfIndexer = new PfIndexer(); await pfIndexer.start() } catch { pfIndexer = null } }
let pfEngine = null
if (PF_PLUGIN) { try { pfEngine = require(path.join(PF_PLUGIN, 'engine.js')) } catch { pfEngine = null } }
const PF_OK = { indexer: !!pfIndexer, engine: !!pfEngine }

const pfLang = (rel) => path.extname(rel).slice(1).replace(/^m?js$/, 'javascript').replace(/^tsx?$/, 'typescript').replace('rs', 'rust')
  .replace('py', 'python').replace('cpp', 'cpp')

/** PF's ReadCode find= target collection: glob walk with node_modules/.git only. */
function pfCollect(glob = '**/*', cap = 200) {
  const out = []
  const walk = (dir, rel) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (r.includes('node_modules') || r.includes('.git')) continue
        walk(path.join(dir, e.name), r)
      } else out.push(r)
    }
  }
  walk(FIXTURE_DIR, '')
  return out.sort().slice(0, cap)
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------
const CHAINS = [
  {
    id: 'grep', needs: ['pattern'], label: 'ffgrep', family: 'forge',
    run: async (s) => {
      const r = await grep.execute({ pattern: s.pattern, mode: s.mode, limit: 50 }, exec)
      const items = r.items ?? []
      const ok = items.some((i) => norm(i.file) === s.target.file && i.line === s.target.line)
      return { ok, bytes: sumB(items.map((i) => i.text)), detail: `${items.length} hits` }
    },
  },
  {
    id: 'grep+enc', needs: ['pattern'], label: 'grep+enc', family: 'forge',
    run: async (s) => {
      const r = await grep.execute({ pattern: s.pattern, mode: s.mode, limit: 50, enclosing: true }, exec)
      const items = r.items ?? []
      const ok = items.some((i) => norm(i.file) === s.target.file && i.line === s.target.line)
      return { ok, bytes: sumB(items.map((i) => i.text)), detail: `${items.length} hits, ${items.filter((i) => i.in).length} sym` }
    },
  },
  {
    id: 'grep→read', needs: ['pattern'], label: 'g→read', family: 'forge',
    run: async (s) => {
      const r = await grep.execute({ pattern: s.pattern, mode: s.mode, limit: 50, enclosing: true }, exec)
      let bytes = sumB((r.items ?? []).map((i) => i.text))
      const seen = new Set()
      for (const item of (r.items ?? [])) {
        if (!item.in?.name) continue
        const key = `${item.file}#${item.in.name}`
        if (seen.has(key)) continue
        seen.add(key)
        const rr = await readSymbol.execute({ path: item.file, symbol: item.in.name, line: item.line }, exec)
        if (rr.error) continue
        bytes += b(rr.text)
        if (norm(item.file) === s.target.file && covered(s.target, rr.startLine, rr.endLine)) return { ok: true, bytes, detail: `read ${key}` }
      }
      return { ok: false, bytes, detail: `${(r.items ?? []).length} hits, no covering read` }
    },
  },
  {
    id: 'find', needs: ['name'], label: 'find', family: 'forge',
    run: async (s) => {
      const r = await findSymbol.execute({ name: s.name, limit: 50 }, exec)
      const items = r.items ?? []
      const hit = items.find((i) => norm(i.file) === s.target.file && covered(s.target, i.startLine, i.endLine))
      return { ok: !!hit, bytes: sumB(items.map((i) => i.signature)), detail: `${items.length} defs` }
    },
  },
  {
    id: 'find→read', needs: ['name'], label: 'f→read', family: 'forge',
    run: async (s) => {
      const r = await findSymbol.execute({ name: s.name, limit: 50 }, exec)
      let bytes = sumB((r.items ?? []).map((i) => i.signature))
      for (const i of (r.items ?? [])) {
        if (norm(i.file) !== s.target.file) continue
        const rr = await readSymbol.execute({ path: i.file, symbol: i.qualifiedName, occurrence: i.occurrence }, exec)
        if (rr.error) continue
        bytes += b(rr.text)
        if (covered(s.target, rr.startLine, rr.endLine)) return { ok: true, bytes, detail: `read ${i.qualifiedName}` }
      }
      return { ok: false, bytes, detail: 'no covering read' }
    },
  },
  {
    id: 'outline→read', needs: ['file'], label: 'o→read', family: 'forge',
    run: async (s) => {
      const o = await outline.execute({ path: s.file }, exec)
      if (o.error) return { ok: false, bytes: 0, detail: o.error.slice(0, 40) }
      const items = o.items ?? []
      const cand = items.find((i) => covered(s.target, i.startLine, i.endLine))
      if (!cand) return { ok: false, bytes: sumB(items.map((i) => i.qualifiedName)), detail: `${items.length} symbols, none covers L${s.target.line}` }
      const rr = await readSymbol.execute({ path: s.file, symbol: cand.qualifiedName }, exec)
      if (rr.error) return { ok: false, bytes: 0, detail: rr.error.slice(0, 40) }
      return { ok: covered(s.target, rr.startLine, rr.endLine), bytes: b(rr.text), detail: `read ${cand.qualifiedName}` }
    },
  },
  {
    id: 'read#sym', needs: ['file', 'name'], label: 'r#sym', family: 'forge',
    run: async (s) => {
      const r = await read.execute({ path: `${s.file}#${s.name}` }, exec)
      if (r.error) return { ok: false, bytes: 0, detail: r.error.slice(0, 40) }
      const blk = (r.blocks ?? [])[0]
      if (!blk) return { ok: false, bytes: 0, detail: 'no block' }
      const range = parseRange(blk.lines)
      return { ok: range ? covered(s.target, range[0], range[1]) : false, bytes: b(blk.text), detail: blk.lines ?? 'n/a' }
    },
  },
  {
    id: 'fffind', needs: ['fileName'], label: 'fffind', family: 'forge',
    run: async (s) => {
      const r = await fffind.execute({ pattern: s.fileName, limit: 20 }, exec)
      const items = r.items ?? []
      return { ok: items.some((i) => norm(i.path) === s.target.file), bytes: sumB(items.map((i) => i.path)), detail: `${items.length} files` }
    },
  },
  {
    id: 'multi', needs: ['patterns'], label: 'multi', family: 'forge',
    run: async (s) => {
      const r = await multiGrep.execute({ patterns: s.patterns, limit: 50 }, exec)
      const items = r.items ?? []
      const ok = items.some((i) => norm(i.file) === s.target.file && i.line === s.target.line)
      return { ok, bytes: sumB(items.map((i) => i.text)), detail: `${items.length} hits` }
    },
  },

  // ---- ProjectForge -------------------------------------------------------
  {
    id: 'pfFind', needs: ['name'], label: 'pfFind', family: 'pf', available: () => PF_OK.indexer,
    run: async (s) => {
      const r = await pfIndexer.call('findSymbols', { root: FIXTURE_DIR, name: s.name, limit: 50 })
      if (!r.ok) return { ok: false, bytes: 0, detail: `err ${r.error?.code}` }
      const hits = r.result.hits ?? []
      const hit = hits.find((h) => norm(h.path) === s.target.file && h.start <= s.target.line && s.target.line <= h.end)
      return { ok: !!hit, bytes: sumB(hits.map((h) => h.signature)), detail: `${hits.length} hits, scanned ${r.result.scanned}` }
    },
  },
  {
    id: 'pfOutline', needs: ['file'], label: 'pf o→read', family: 'pf', available: () => PF_OK.indexer,
    run: async (s) => {
      const text = readFileSync(path.join(FIXTURE_DIR, ...s.file.split('/')), 'utf8')
      const r = await pfIndexer.call('outline', { text, path: s.file, lang: pfLang(s.file) })
      if (!r.ok) return { ok: false, bytes: 0, detail: `err ${r.error?.code}` }
      const syms = r.result.symbols ?? []
      let bytes = sumB(syms.map((x) => x.qualified))
      const hit = syms.find((x) => x.start <= s.target.line && s.target.line <= x.end)
      if (!hit) return { ok: false, bytes, detail: `${syms.length} symbols, none covers L${s.target.line}` }
      // PF's Outline command is outline-only; a consumer that needs the body
      // follows with ReadCode symbol= — mirror forge's o→read by counting it.
      bytes += b(text.replace(/\r\n/g, '\n').split('\n').slice(hit.fullStart - 1, hit.end).join('\n'))
      return { ok: covered(s.target, hit.start, hit.end), bytes, detail: `${hit.qualified} L${hit.fullStart}-${hit.end}` }
    },
  },
  {
    id: 'pfRead#sym', needs: ['file', 'name'], label: 'pf r#sym', family: 'pf', available: () => PF_OK.indexer,
    run: async (s) => {
      const text = readFileSync(path.join(FIXTURE_DIR, ...s.file.split('/')), 'utf8')
      const r = await pfIndexer.call('outline', { text, path: s.file, lang: pfLang(s.file) })
      if (!r.ok) return { ok: false, bytes: 0, detail: `err ${r.error?.code}` }
      const want = s.name.replace(/::/g, '.')
      const sym = (r.result.symbols ?? []).find((x) => String(x.qualified).replace(/::/g, '.') === want)
      if (!sym) return { ok: false, bytes: 0, detail: 'symbol not found for range read' }
      const lines = text.replace(/\r\n/g, '\n').split('\n').slice(sym.fullStart - 1, sym.end)
      return { ok: covered(s.target, sym.start, sym.end), bytes: b(lines.join('\n')), detail: `${sym.qualified} L${sym.fullStart}-${sym.end}` }
    },
  },
  {
    id: 'pfFindInFiles', needs: ['pattern'], label: 'pf find', family: 'pf', available: () => PF_OK.engine,
    run: async (s) => {
      // Faithful to ProjectForgeService.findInFiles: glob targets, per-file
      // buildIndex + locateTarget (anchor match). No fuzzy, no regex.
      let bytes = 0
      let located = false
      let scanned = 0
      for (const rel of pfCollect()) {
        if (located) break
        let text
        try { text = readFileSync(path.join(FIXTURE_DIR, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n') } catch { continue }
        scanned++
        const idx = pfEngine.buildIndex(text)
        let hits = []
        try { hits = pfEngine.locateTarget(idx, s.pattern).hits } catch { hits = [] }
        for (const h of hits) {
          bytes += b(pfEngine.contextBlock(idx, h.startLine, h.endLine))
          if (rel === s.target.file && h.startLine <= s.target.line && s.target.line <= h.endLine) { located = true; break }
        }
      }
      return { ok: located, bytes, detail: `scanned ${scanned} files` }
    },
  },
]

// ---------------------------------------------------------------------------
const has = (s, k) => s[k] !== null && s[k] !== undefined
const usable = (c) => (c.available ? c.available() : true)
const applicable = (s, c) => usable(c) && c.needs.every((k) => has(s, k))

const matrix = []
const forgeViolations = []
const pfLeaks = []
for (const s of SCENARIOS) {
  const row = { s, cells: {} }
  for (const c of CHAINS) {
    if (!applicable(s, c)) { row.cells[c.id] = { state: '·' }; continue }
    const r = await c.run(s)
    row.cells[c.id] = { state: r.ok ? 'ok' : 'miss', bytes: r.bytes, detail: r.detail }
  }
  const forgeOks = CHAINS.filter((c) => c.family === 'forge' && row.cells[c.id].state === 'ok').map((c) => c.id)
  const pfOks = CHAINS.filter((c) => c.family === 'pf' && row.cells[c.id].state === 'ok').map((c) => c.id)
  const allOks = [...forgeOks, ...pfOks]
  row.forgeLocatedBy = forgeOks
  row.pfLocatedBy = pfOks
  if (s.expect === 'hidden') {
    if (forgeOks.length > 0) forgeViolations.push(`${s.id}: dsh-forge located a gitignored target via ${forgeOks.join(',')}`)
    if (pfOks.length > 0) pfLeaks.push(`${s.id} ${s.question} via ${pfOks.join(',')}`)
    if (allOks.length === 0) { /* expected */ }
  } else if (allOks.length === 0) {
    forgeViolations.push(`${s.id} ${s.question}: no chain located the target`)
  }
  matrix.push(row)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n)
const cellW = 9
console.log('\n== scenario coverage: dsh-forge chains | ProjectForge chains ==')
console.log(pad('id  场景', 30) + CHAINS.map((c) => pad(c.label, c.family === 'pf' ? cellW + 2 : cellW).slice(0, c.family === 'pf' ? cellW + 2 : cellW)).join(''))
console.log(pad('', 30) + CHAINS.map((c) => pad(c.family === 'pf' ? '·PF·' : '', c.family === 'pf' ? cellW + 2 : cellW).slice(0, c.family === 'pf' ? cellW + 2 : cellW)).join(''))
for (const row of matrix) {
  const cells = CHAINS.map((c) => {
    const st = row.cells[c.id].state
    const mark = st === 'ok' ? 'ok' : st === 'miss' ? 'x' : '·'
    const w = c.family === 'pf' ? cellW + 2 : cellW
    return pad(mark, w).slice(0, w)
  }).join('')
  console.log(pad(`${row.s.id} ${row.s.question}`, 30).slice(0, 30) + cells)
}

console.log('\n-- coverage by kind (any chain) --')
const kinds = {}
for (const row of matrix) {
  const k = row.s.kind
  kinds[k] ??= { total: 0, forge: 0, pf: 0 }
  kinds[k].total++
  if (row.forgeLocatedBy.length) kinds[k].forge++
  if (row.pfLocatedBy.length) kinds[k].pf++
}
console.log('  kind'.padEnd(10) + 'dsh-forge'.padStart(10) + 'ProjectForge'.padStart(14))
for (const [k, v] of Object.entries(kinds)) {
  console.log(`  ${pad(k, 8)}${`${v.forge}/${v.total}`.padStart(10)}${`${v.pf}/${v.total}`.padStart(14)}`)
}

console.log('\n-- chain reach --')
for (const c of CHAINS) {
  const expr = matrix.filter((r) => r.cells[c.id].state !== '·')
  const ok = expr.filter((r) => r.cells[c.id].state === 'ok')
  const tok = ok.reduce((s, r) => s + Math.ceil((r.cells[c.id].bytes ?? 0) / 4), 0)
  const tag = c.family === 'pf' ? ' [PF]' : ''
  const avail = usable(c) ? '' : '  (unavailable — skipped)'
  console.log(`  ${pad(c.label + tag, 16)} 可表达 ${String(expr.length).padStart(2)}/${matrix.length}  命中 ${String(ok.length).padStart(2)}  定位总上下文 ${String(tok).padStart(4)} estTokens${avail}`)
}

if (PF_OK.indexer || PF_OK.engine) {
  console.log(`\n-- ProjectForge provider -- indexer ${PF_OK.indexer ? 'ok' : 'MISSING'}, engine.js ${PF_OK.engine ? 'ok' : 'MISSING'}`)
  console.log('-- scenarios dsh-forge covers but ProjectForge cannot --')
  for (const row of matrix) {
    if (row.forgeLocatedBy.length && row.pfLocatedBy.length === 0) {
      const why = CHAINS.filter((c) => c.family === 'pf' && row.cells[c.id].state === '·').map((c) => c.label)
      console.log(`  ${row.s.id} ${pad(row.s.question, 26)} by [${row.forgeLocatedBy.join(',')}]  PF 无法表达: ${why.join(',') || '—'}`)
    }
  }
  console.log('-- scenarios ProjectForge covers but dsh-forge cannot --')
  let any = false
  for (const row of matrix) {
    if (row.pfLocatedBy.length && row.forgeLocatedBy.length === 0) { console.log(`  ${row.s.id} ${row.s.question}`); any = true }
  }
  if (!any) console.log('  (none)')
  if (pfLeaks.length) {
    console.log('\n-- ProjectForge gitignore leaks (dsh-forge stays clean) --')
    for (const l of pfLeaks) console.log('  ! ' + l)
  } else {
    console.log('\n-- ProjectForge gitignore leaks: none observed --')
  }
} else {
  console.log('\n[ProjectForge unavailable: set DSH_FORGE_PF_EXE / DSH_FORGE_PF_PLUGIN to enable the PF columns]')
}

const visibleForge = matrix.filter((r) => r.s.expect !== 'hidden' && r.forgeLocatedBy.length > 0).length
const visibleTotal = matrix.filter((r) => r.s.expect !== 'hidden').length
console.log(`\ndsh-forge: visible ${visibleForge}/${visibleTotal} located; hidden leaks ${forgeViolations.filter((v) => v.includes('gitignored')).length}`)
if (forgeViolations.length) {
  console.log('\nFORGE VIOLATIONS:')
  for (const v of forgeViolations) console.log('  ! ' + v)
}
assert.equal(forgeViolations.length, 0, 'dsh-forge coverage floors violated')
pfIndexer?.stop()
pool.disposeAll()
console.log('\nall dsh-forge coverage floors hold')
