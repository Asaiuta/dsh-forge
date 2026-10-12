/**
 * End-to-end task eval for dsh-forge — retrieval-line D (evaluation line D).
 *
 * Measures what line-B/perf evals cannot: the cost of completing a WHOLE
 * locate task under each toolchain, using the real tools on both sides.
 *
 *   forge   = ffgrep(enclosing:true) → ff_read_symbol by the returned symbol
 *             address (edit-ready evidence: symbol body only)
 *   builtin = content grep rows (no symbol knowledge) → whole-file reads
 *             until the target is seen (the only way builtin can confirm)
 *
 * Both policies are fixed, documented, and identical in spirit: consume rows,
 * then read candidates in result order until the oracle is covered. Accounts
 * per task: located, tool calls, irrelevant reads, and context bytes (the
 * proxy for token cost — bytes/4, labelled estTokens). The same symbol-body
 * evidence is what composes an ffedit; the whole file is what builtin edits
 * consume, so the edit dimension shares this accounting.
 *
 * Floors are asserted: every task must locate under BOTH toolchains (the
 * comparison is cost, not correctness), forge must never pay more context
 * than builtin on a task, and forge's aggregate must be strictly cheaper.
 *
 * @module dsh-forge/tests/eval-task
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FinderPool } from '../lib/core.js'
import { createGrepTool } from '../lib/tools.js'
import { createReadSymbolTool } from '../lib/tools-symbol.js'
import { createEditTool } from '../lib/tools-edit.js'
import { buildFixture, FIXTURE_DIR } from './make-fixture.mjs'

// ffedit writes a real ledger — keep eval writes out of the user store.
process.env.DSH_FORGE_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'forge-eval-task-data-'))

const truth = buildFixture()

/** 1-based line of the first line containing `token` (fixture drift guard). */
function lineOf(rel, token) {
  const lines = readFileSync(path.join(FIXTURE_DIR, rel), 'utf8').replace(/\r\n/g, '\n').split('\n')
  const idx = lines.findIndex((line) => line.includes(token))
  if (idx === -1) throw new Error(`fixture drift: token "${token}" not found in ${rel}`)
  return idx + 1
}

// ---------------------------------------------------------------------------
// Tasks: question → query → oracle coordinates (located by token, never hardcoded)
// ---------------------------------------------------------------------------

const TASKS = [
  { question: 'blob 去重写入的实现', query: 'putBlob', oracleFile: 'src/store.js', oracleLine: truth.storePutBlob },
  { question: 'blob 回读的实现', query: 'getBlob', oracleFile: 'src/store.js', oracleLine: truth.storeGetBlob },
  { question: '邮箱格式校验', query: 'isEmail', oracleFile: 'src/validate.js', oracleLine: truth.validateIsEmail },
  { question: '按 id 取用户', query: 'getUser', oracleFile: 'src/nested/deep.ts', oracleLine: lineOf('src/nested/deep.ts', 'getUser(id') },
  { question: 'Python 路径归一化', query: 'normalize_path', oracleFile: 'lib/utils.py', oracleLine: lineOf('lib/utils.py', 'def normalize_path') },
  { question: 'Rust 默认权重', query: 'default_weight', oracleFile: 'lib/scoring.rs', oracleLine: truth.rsDefaultWeight },
  { question: '问候语格式化', query: 'greet', oracleFile: 'src/doced.js', oracleLine: truth.docedGreet },
  { question: 'Go 程序入口', query: 'func main', oracleFile: 'cmd/server.go', oracleLine: truth.goMain },
  { question: '登录提交逻辑', query: 'function submit', oracleFile: 'src/login.js', oracleLine: lineOf('src/login.js', 'function submit') },
]

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const pool = new FinderPool()
const ffgrep = createGrepTool(pool)
const ffReadSymbol = createReadSymbolTool()
const ffedit = createEditTool(pool)
const exec = { agent: { session: { header: { cwd: FIXTURE_DIR, id: 'eval-task' } } }, token: {} }

const bytes = (s) => Buffer.byteLength(s, 'utf8')
const estTokens = (n) => Math.ceil(n / 4)

// Warm the index once so per-task calls measure steady state, not warm-up.
{
  const warm = await ffgrep.execute({ pattern: 'putBlob', limit: 5 }, exec)
  assert.ok(warm && Array.isArray(warm.items), 'ffgrep warm-up must succeed')
}

/** Builtin side: literal smart-case scan → rows ({file,line,text}). */
function builtinGrep(pattern) {
  const lower = pattern === pattern.toLowerCase()
  const rows = []
  const walk = (dir, base = '') => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const rel = base === '' ? entry.name : `${base}/${entry.name}`
      if (entry.isDirectory()) {
        if (rel === '.git' || rel === 'build' || rel === 'logs') continue
        walk(path.join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        const text = readFileSync(path.join(dir, entry.name), 'utf8').replace(/\r\n/g, '\n')
        text.split('\n').forEach((line, i) => {
          const hay = lower ? line.toLowerCase() : line
          const needle = lower ? pattern.toLowerCase() : pattern
          if (hay.includes(needle)) rows.push({ file: rel, line: i + 1, text: line })
        })
      }
    }
  }
  walk(FIXTURE_DIR)
  return rows
}

/** Run one task under a toolchain. Returns accounting. */
async function runTask(task) {
  // ---- forge: ffgrep + symbol reads -------------------------------------
  const g = await ffgrep.execute({ pattern: task.query, enclosing: true, limit: 20 }, exec)
  assert.ok(Array.isArray(g.items) && g.items.length > 0, `ffgrep must hit for "${task.query}"`)
  let forgeBytes = g.items.reduce((s, i) => s + bytes(i.text), 0)
  let forgeCalls = 1
  let forgeIrrelevant = 0
  let forgeLocated = false
  let editAnchor = null // signature line of the located definition — edit-ready evidence
  const readSymbols = new Set()
  for (const item of g.items) {
    if (forgeLocated) break
    if (!item.in || !item.in.name) {
      // No enclosing symbol (top-level hit): the row itself pins the coordinate.
      if (item.file === task.oracleFile && item.line === task.oracleLine) {
        forgeLocated = true
        editAnchor = item.text
      }
      continue
    }
    const key = `${item.file}#${item.in.name}`
    if (readSymbols.has(key)) continue
    readSymbols.add(key)
    forgeCalls++
    const r = await ffReadSymbol.execute({ path: item.file, symbol: item.in.name, line: item.line, body: true }, exec)
    if (r.error) continue
    forgeBytes += bytes(r.text)
    if (item.file === task.oracleFile && r.startLine <= task.oracleLine && task.oracleLine <= r.endLine) {
      forgeLocated = true
      // Signature line from the already-in-context symbol body — no extra read.
      editAnchor = (r.text.split('\n').find((l) => l.includes('(')) ?? r.text.split('\n')[0]).trim()
    } else {
      forgeIrrelevant++
    }
  }

  // ---- builtin: grep rows + whole-file reads -----------------------------
  const rows = builtinGrep(task.query)
  assert.ok(rows.length > 0, `builtin grep must hit for "${task.query}"`)
  let baseBytes = rows.reduce((s, r) => s + bytes(r.text), 0)
  let baseCalls = 1
  let baseIrrelevant = 0
  let baseLocated = false
  const readFiles = new Set()
  for (const row of rows) {
    if (baseLocated) break
    if (readFiles.has(row.file)) continue
    readFiles.add(row.file)
    baseCalls++
    const size = bytes(readFileSync(path.join(FIXTURE_DIR, ...row.file.split('/')), 'utf8'))
    baseBytes += size
    if (row.file === task.oracleFile) baseLocated = true // whole file in evidence → oracle line covered
    else baseIrrelevant++
  }

  // ---- edit phase: locate evidence → one content-anchored edit ------------
  // The whole point of line D: the evidence gathered for locating must ALSO
  // carry the modification with zero extra reads and one tool call. The
  // signature line already in context is the content anchor.
  let forgeEditApplied = false
  if (forgeLocated && editAnchor) {
    const marker = ` /* touched-by:${task.query} */`
    const edit = await ffedit.execute({
      path: task.oracleFile,
      steps: [{ find: editAnchor, replaceWith: editAnchor + marker }],
      reason: 'eval-task edit phase',
    }, exec)
    forgeEditApplied = edit.status === 'applied'
    forgeCalls++
    if (!forgeEditApplied) {
      assert.ok(edit.error, 'unapplied edit must carry an error')
    }
  }

  return {
    question: task.question,
    forge: { located: forgeLocated, calls: forgeCalls, irrelevant: forgeIrrelevant, ctx: forgeBytes, tok: estTokens(forgeBytes), editApplied: forgeEditApplied },
    builtin: { located: baseLocated, calls: baseCalls, irrelevant: baseIrrelevant, ctx: baseBytes, tok: estTokens(baseBytes) },
  }
}

// ---------------------------------------------------------------------------
// Run + report + floors
// ---------------------------------------------------------------------------

const results = []
for (const task of TASKS) results.push(await runTask(task))
pool.disposeAll()

console.log('\n== end-to-end task eval (evaluation line D): locate → edit-ready evidence ==')
console.log('task                forge calls/irrel/tok   builtin calls/irrel/tok   ctx saved')
let forgeTok = 0, baseTok = 0, forgeIrrel = 0, baseIrrel = 0, editsApplied = 0
for (const r of results) {
  assert.ok(r.forge.located, `forge failed to locate: ${r.question}`)
  assert.ok(r.builtin.located, `builtin failed to locate: ${r.question}`)
  assert.ok(r.forge.editApplied, `forge edit phase must apply from locate evidence alone: ${r.question}`)
  assert.ok(r.forge.irrelevant <= 3, `forge irrelevant reads must stay <=3: ${r.question} (${r.forge.irrelevant})`)
  assert.ok(r.forge.ctx <= r.builtin.ctx, `forge context must not exceed builtin: ${r.question}`)
  forgeTok += r.forge.tok; baseTok += r.builtin.tok; forgeIrrel += r.forge.irrelevant; baseIrrel += r.builtin.irrelevant
  if (r.forge.editApplied) editsApplied++
  const saved = r.builtin.tok > 0 ? Math.round((1 - r.forge.tok / r.builtin.tok) * 100) : 0
  console.log(
    `${r.question.padEnd(18)}  ${String(r.forge.calls).padStart(2)}/${r.forge.irrelevant}/${String(r.forge.tok).padStart(5)}`
    + `            ${String(r.builtin.calls).padStart(2)}/${r.builtin.irrelevant}/${String(r.builtin.tok).padStart(6)}`
    + `            ${String(saved).padStart(3)}%`,
  )
}
console.log(`aggregate           ${forgeIrrel} irrelevant             ${baseIrrel} irrelevant   edits applied: ${editsApplied}/${results.length} (locate evidence sufficed, zero extra reads)`)
console.log(`context tokens: forge ${forgeTok} vs builtin ${baseTok}  (${Math.round((1 - forgeTok / baseTok) * 100)}% saved)`)

assert.ok(forgeTok < baseTok, 'forge aggregate context must be strictly cheaper than builtin')
assert.ok(forgeTok <= baseTok * 0.7, `forge aggregate context floor: expected <=70% of builtin, got ${Math.round((forgeTok / baseTok) * 100)}%`)
assert.ok(forgeIrrel <= baseIrrel, 'forge aggregate irrelevant reads must not exceed builtin')
console.log(`\nall ${results.length} tasks located under both toolchains; forge floors hold`)
