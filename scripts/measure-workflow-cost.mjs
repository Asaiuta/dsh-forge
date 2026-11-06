/** Offline whole-workflow accounting, including retries and every evidence page. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { getEncoding } from 'js-tiktoken'
const { createEditTool, createHistoryTool } = await import(process.argv.includes('--built') ? '../lib/tools-edit.js' : '../src/tools-edit.ts')
import { createProjectTool } from '../src/tools-project.ts'
import { captureTodoProject, projectAction } from '../src/projects.ts'
import { FinderPool } from '../src/core.ts'
import { recordBatch, storeFor, putBlob } from '../src/ledger.ts'
import { snapshotPatch, oversizedHunk } from '../src/history.ts'
import { defineForgeTool } from '../src/host.ts'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { testSubprocess } from '../tests/lib/eval-subprocess.mjs'

const destination = process.argv[2]
if (!destination) throw new Error('usage: node --experimental-transform-types scripts/measure-workflow-cost.mjs <output.json>')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-workflow-'))
const previous = process.env.DSH_FORGE_DATA_DIR
process.env.DSH_FORGE_DATA_DIR = path.join(root, 'private')
const workspace = path.join(root, 'work'); fs.mkdirSync(workspace)
const exec = { agent: { session: { header: { cwd: workspace, id: 'workflow-cost' } } } }
const subprocess = testSubprocess(), pool = new FinderPool()
const services = { get: n => ({ subprocess, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workspace }) } })[n] }
const factory = createEditTool(pool, services), edit = defineForgeTool(factory)
const history = defineForgeTool(createHistoryTool()), project = defineForgeTool(createProjectTool())
const runtime = Object.create(ToolRuntime.prototype); runtime.canonicalResults = new WeakMap(); runtime.concludingExecutions = new WeakSet()
const encodings = Object.fromEntries(['o200k_base', 'cl100k_base'].map(n => [n, getEncoding(n)]))
const results = []
function measurement(name) {
  const row = { name, calls: [] }; results.push(row)
  return async (tool, args) => {
    const context = { ...exec, arguments: args, token: {}, parent: {} }
    let value, text, error
    try {
      const result = runtime.createSuccessResult(context, tool, await tool.execute(args, context))
      value = result.value; text = result.content.map(c => c.text).join('\n')
    } catch (cause) { error = cause.message; value = { error }; text = error }
    row.calls.push({ args, value, text, ...(error ? { error } : {}),
      valueBytes: Buffer.byteLength(JSON.stringify(value)), textBytes: Buffer.byteLength(text) })
    return value
  }
}
async function receipt(call, value) {
  if (!value.receiptRef) return value
  let text = '', cursor
  do {
    const next = await call(history, { ...(value.batch ? { batch: value.batch } : {}), detail: 'receipt', receiptRef: value.receiptRef, ...(cursor ? { cursor } : {}) })
    assert.ok(next.page, JSON.stringify(next))
    assert.equal(next.page.offset, text.length); text += next.page.record; cursor = next.page.nextCursor
  } while (cursor)
  return JSON.parse(text)
}
try {
  const callEdit = measurement('50 edits: full step diagnostics')
  const names = Array.from({ length: 50 }, (_, i) => `f${i}_${'X'.repeat(220)}`)
  fs.writeFileSync(path.join(workspace, 'receipt.js'), names.map(n => `function ${n}(){ return 1 }`).join('\n') + '\n')
  const steps = names.map((n, i) => ({ start: i + 1, end: i + 1, text: `function ${n}(){ return 2 }` }))
  const applied = await callEdit(edit, { path: 'receipt.js', steps, reason: 'large default receipt' })
  assert.equal(applied.status, 'applied'); assert.equal(applied.applied, 50)
  const full = await receipt(callEdit, applied)
  assert.equal(full.reports.length, 50); assert.equal(full.hash, applied.hash)
  assert.equal(fs.readFileSync(path.join(workspace, 'receipt.js'), 'utf8'), names.map(n => `function ${n}(){ return 2 }`).join('\n') + '\n')
  results.at(-1).completeEvidence = true

  for (const mode of ['unchanged', 'ticket']) {
    const callUnwritten = measurement(`50 ${mode}: full diagnostics without writing`)
    const before = names.map(n => `function ${n}(){\n  return 1\n}`).join('\n') + '\n'
    fs.writeFileSync(path.join(workspace, 'unwritten.js'), before)
    const args = mode === 'ticket' ? { find: '  return 1', replaceWith: '  return 2' }
      : { steps: names.map((n, i) => ({ start: i * 3 + 1, end: i * 3 + 1, text: `function ${n}(){` })) }
    const r = await callUnwritten(edit, { path: 'unwritten.js', ...args, reason: 'unwritten large receipt' })
    assert.equal(r.status, mode === 'ticket' ? 'ticket' : 'applied'); assert.equal(r.batch, undefined)
    const full = await receipt(callUnwritten, r)
    assert.equal((mode === 'ticket' ? full.candidates : full.reports).length, 50)
    assert.equal(fs.readFileSync(path.join(workspace, 'unwritten.js'), 'utf8'), before)
    results.at(-1).completeEvidence = true
  }

  fs.writeFileSync(path.join(workspace, 'eval.mjs'), 'export function add(a,b) { return a+b }\nexport function large() { return "中😀".repeat(6000) }\n')
  for (const symbol of ['add', 'large']) {
    const callEval = measurement(`eval ${symbol}: full result and logs`)
    const r = (await callEval(edit, { action: 'eval', path: 'eval.mjs', sourceSymbol: symbol, ...(symbol === 'add' ? { args: '[2,3]' } : {}) })).evaluation
    assert.equal(r.status, 'returned')
    let record = r.resultComplete ? r.result : undefined
    if (!record) {
      let text = '', offset = 0
      while (true) {
        const p = (await callEval(edit, { action: 'eval', resultId: r.resultId, offset })).evaluation
        assert.equal(p.offset, text.length); text += p.text
        if (p.complete) break
        offset = p.nextOffset
      }
      record = JSON.parse(text)
    }
    assert.equal(record.value.value, symbol === 'add' ? 5 : '中😀'.repeat(6000))
    assert.equal(record.stdout, ''); assert.equal(record.stderr, '')
    results.at(-1).completeEvidence = true
  }

  const callProject = measurement('task pagination across an unrelated report submission')
  const p = await captureTodoProject(workspace, { sessionId: 'workflow', callId: 'one', turn: 1 },
    Array.from({ length: 3 }, (_, i) => ({ content: `Task ${i}`, status: 'pending' })))
  const query = { action: 'get', projectId: p.id, detail: 'tasks', limit: 1 }
  const first = (await callProject(project, query)).payload
  assert.ok(first.nextCursor)
  await projectAction({ action: 'report', workspace, projectId: p.id, revision: p.revision, status: 'draft', conclusion: 'unrelated report', issues: [] })
  let seen = [...first.tasks], cursor = first.nextCursor, restarted = false
  while (cursor) {
    let next = await callProject(project, { ...query, cursor })
    if (next.error) {
      assert.match(next.error, /snapshot changed/); assert.equal(restarted, false); restarted = true; seen = []
      next = await callProject(project, query)
    }
    seen.push(...next.payload.tasks); cursor = next.payload.nextCursor
  }
  assert.deepEqual(seen.map(t => t.id), p.tasks.map(t => t.id)); results.at(-1).completeEvidence = true

  const callDiff = measurement('long path near-budget hunk: full applicable patch')
  const filename = Array.from({ length: 9 }, (_, i) => `${i}${'d'.repeat(54)}`).join('/') + '/sample.txt'
  const before = Array.from({ length: 8 }, (_, i) => `${i}${'a'.repeat(849)}\n`).join('')
  const after = before.replace(`3${'a'.repeat(849)}`, `3${'b'.repeat(849)}`)
  const patch = snapshotPatch(Buffer.from(before), Buffer.from(after), filename)
  assert.equal(patch.hunks.length, 1); assert.equal(oversizedHunk(patch.hunks[0]), false)
  const store = storeFor(workspace), batch = recordBatch(store, { kind: 'edit', reason: 'near boundary', actor: 'workflow-cost',
    nodes: [{ file: filename, op: 'update', before: putBlob(store, Buffer.from(before)).id, after: putBlob(store, Buffer.from(after)).id, bytes: Buffer.byteLength(after), eol: 'LF', bom: false }] })
  const selected = await callDiff(history, { batch: batch.id })
  let text = ''
  if (selected.page?.complete) text = selected.items[0].diffs[0].diff
  else {
    let cursor
    do {
      const next = await callDiff(history, { node: `b${batch.id}:n0`, detail: 'patch', ...(cursor ? { cursor } : {}) })
      assert.equal(next.page.offset, text.length); text += next.items[0].diffs[0].diff; cursor = next.page.nextCursor
    } while (cursor)
  }
  assert.equal(text, patch.header + patch.hunks.join('')); results.at(-1).completeEvidence = true

  const callVerify = measurement('path verification with default checks')
  const checked = await callVerify(edit, { action: 'verify', path: 'eval.mjs' })
  results.at(-1).status = checked.check.status
  results.at(-1).checks = checked.check.checks.map(c => ({ kind: c.kind, status: c.status }))
  for (const row of results) {
    row.callCount = row.calls.length; row.errorCount = row.calls.filter(c => c.error || c.value.error).length
    row.totals = Object.fromEntries(Object.entries(encodings).map(([n, enc]) => {
      const sum = { arguments: 0, nativeText: 0, ptcValue: 0 }
      for (const call of row.calls) {
        sum.arguments += enc.encode(JSON.stringify(call.args)).length
        sum.nativeText += enc.encode(call.text).length
        sum.ptcValue += enc.encode(JSON.stringify(call.value)).length
      }
      return [n, { ...sum, nativeTotal: sum.arguments + sum.nativeText, ptcTotal: sum.arguments + sum.ptcValue }]
    }))
  }
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true })
  fs.writeFileSync(destination, JSON.stringify({ modelCalls: 0,
    scope: 'All tool arguments and full text/structured outputs, including retries and continuations. No model reasoning, full request history, caching or billing. Random IDs, temporary paths and elapsed times vary.', results }, null, 2))
  console.log(JSON.stringify(results.map(({ calls, ...row }) => ({ ...row, firstValueBytes: calls[0].valueBytes, firstTextBytes: calls[0].textBytes })), null, 2))
} finally {
  pool.disposeAll(); factory.dispose()
  if (previous === undefined) delete process.env.DSH_FORGE_DATA_DIR; else process.env.DSH_FORGE_DATA_DIR = previous
  fs.rmSync(root, { recursive: true, force: true })
}
