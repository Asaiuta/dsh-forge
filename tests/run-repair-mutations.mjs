import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createFileTool } from '../src/tools-files.ts'
import * as files from '../src/tools-files.ts'
import { createEditTool, createHistoryTool, createRollbackTool } from '../src/tools-edit.ts'
import { FinderPool } from '../src/core.ts'
import { storeFor, readLedgerTail } from '../src/ledger.ts'
import { listRecords } from '../src/verification.ts'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-repair-'))
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
const root = path.join(dir, 'work'); fs.mkdirSync(root)
process.env.DSH_FORGE_DATA_DIR = path.join(dir, 'data')
const exec = { agent: { session: { header: { cwd: root, id: 'repair' } } }, token: {} }
const pool = new FinderPool(), file = createFileTool(), edit = createEditTool(pool)
const put = (name, text) => fs.writeFileSync(path.join(root, name), text)
const get = name => fs.readFileSync(path.join(root, name))
let passed = 0, failed = 0
async function test(name, run) { try { await run(); console.log(`ok ${++passed} - ${name}`) } catch (e) { failed++; console.error(`not ok - ${name}: ${e.message}`) } }
const call = args => file.execute({ reason: 'contract', ...args }, exec)
const change = args => edit.execute({ reason: 'contract', ...args }, exec)
await test('canonical schemas remove legacy fields and use canonical names', () => {
  assert.equal(edit.name, 'ff_edit'); assert.equal(createHistoryTool().name, 'ff_history'); assert.equal(createRollbackTool(pool).name, 'ff_rollback')
  assert.ok(!('symbol' in file.parameters)); assert.ok(!('body' in file.parameters)); assert.ok(file.parameters.sourceSymbol); assert.ok(file.parameters.includeLeadingComment)
  assert.ok(!file.parameters.action.enum.includes('edit_symbol')); assert.ok(edit.parameters.sourceSymbol)
})
await test('remove with symbol rejects without changing bytes', async () => { put('keep.js', 'function keep() {}\n'); const before = get('keep.js'); const r = await call({ action: 'remove', path: 'keep.js', symbol: 'keep' }); assert.ok(r.error, JSON.stringify(r)); assert.deepEqual(get('keep.js'), before) })
await test('each action rejects foreign fields, missing and exclusive selectors', async () => {
  put('a.js', 'function a() {}\n'); put('b.js', 'function b() {}\n')
  for (const args of [
    { action: 'create', path: 'x.js', content: '', destination: 'b.js' },
    { action: 'remove', path: 'a.js', content: '' },
    { action: 'move', path: 'a.js', destination: 'b.js', after: 0 },
    { action: 'copy_code', path: 'a.js', destination: 'b.js', sourceSymbol: 'a', fromLines: 'L1', after: 0 },
    { action: 'move_code', path: 'a.js', destination: 'b.js', fromLines: 'L1', after: 0, before: 1 },
    { action: 'copy_code', path: 'a.js', destination: 'b.js', fromLines: 'L1', after: 0, includeLeadingComment: true },
    { action: 'create', path: 'x.js' }, { action: 'move', path: 'a.js' },
    { action: 'remove', path: 'a.js', overwrite: false },
  ]) assert.ok((await call(args)).error, JSON.stringify(args))
  assert.equal(get('a.js').toString(), 'function a() {}\n')
})
await test('transfer source and anchor require exact qualified names, not suffix', async () => {
  put('source.js', 'class Outer { method() {} }\n'); put('dest.js', 'class Target { anchor() {} }\n'); const before = get('dest.js')
  for (const args of [{ sourceSymbol: 'ethod', after: 0 }, { sourceSymbol: 'Outer.method', afterSymbol: 'nchor' }]) assert.ok((await call({ action: 'copy_code', path: 'source.js', destination: 'dest.js', ...args })).error)
  assert.deepEqual(get('dest.js'), before)
})
await test('symbol edit uses shared commit/audit/verify and preserves exact BOM CRLF', async () => {
  put('inline.js', '\uFEFFclass C { run() { return 1; } other() {} }\r\n')
  const result = await change({ path: 'inline.js', sourceSymbol: 'C.run', edit: 'replace', content: 'run() { return 2; }', verify: ['syntax'] })
  assert.ok(result.batch, JSON.stringify(result)); assert.ok(result.audit); assert.equal(result.verification.status, 'passed'); assert.equal(result.verification.persisted, true)
  assert.equal(get('inline.js').toString(), '\uFEFFclass C { run() { return 2; } other() {} }\r\n')
})
await test('symbol protections reject invalid syntax, shared declaration, list delete and mixed intents', async () => {
  for (const [name, text, args] of [
    ['invalid.js', 'function f() {}\n', { sourceSymbol: 'f', edit: 'replace', content: 'function {' }],
    ['shared.js', 'const first = 1, second = 2;\n', { sourceSymbol: 'first', edit: 'delete' }],
    ['list.js', 'const obj = { first() {}, second() {} };\n', { sourceSymbol: 'obj.first', edit: 'delete' }],
    ['mix.js', 'function f() {}\n', { sourceSymbol: 'f', edit: 'delete', find: 'f', replaceWith: 'g' }],
  ]) { put(name, text); const before = get(name); assert.ok((await change({ path: name, ...args })).error); assert.deepEqual(get(name), before) }
})
await test('legacy adapters are explicit and canonical old fields rejected', async () => {
  assert.deepEqual(files.normalizeLegacyFileArgs({ action: 'copy_code', symbol: 'C.f', body: true }), { action: 'copy_code', sourceSymbol: 'C.f', includeLeadingComment: false })
  const m = await import('../src/tools-edit.ts'); assert.deepEqual(m.normalizeLegacySymbolEditArgs({ action: 'edit_symbol', symbol: 'f', body: false, edit: 'delete' }), { sourceSymbol: 'f', includeLeadingComment: true, edit: 'delete' })
})
await test('history pathContains filters and rejects legacy path; rollback integer/latest contracts', async () => {
  const h = createHistoryTool(), r = createRollbackTool(pool)
  assert.ok(h.parameters.pathContains); assert.ok(!('path' in h.parameters)); assert.equal(r.parameters.batch.type, 'integer'); assert.ok(r.parameters.latest)
  assert.ok((await h.execute({ path: 'inline' }, exec)).error)
  const rows = await h.execute({ pathContains: 'inline' }, exec); assert.equal(rows.items.length, 1)
  for (const args of [{ batch: 'last' }, { batch: '1' }, { latest: 'true' }, { batch: 1, latest: true }, { latest: false }, { batch: 1, dryRun: 'false' }]) assert.ok((await r.execute({ reason: 'test', ...args }, exec)).error, JSON.stringify(args))
  assert.equal((await r.execute({ latest: true, reason: 'test' }, exec)).status, 'plan')
})
await test('independent verify persists batch and file checks without code writes or ledger batches', async () => {
  const verify = { execute: async ({ checks, ...args }, exec) => { const r = await edit.execute({ action: 'verify', ...args, ...(checks ? { verify: checks } : {}) }, exec); return r.check ?? r } }
  const before = get('inline.js'), batches = readLedgerTail(storeFor(root)).length
  const batch = (await createHistoryTool().execute({ pathContains: 'inline' }, exec)).items[0].batch
  const result = await verify.execute({ batch, checks: ['syntax'] }, exec); assert.equal(result.status, 'passed'); assert.equal(result.verification.persisted, true)
  const defaultPath = await verify.execute({ path: 'inline.js' }, exec)
  assert.equal(defaultPath.status, 'passed'); assert.deepEqual(defaultPath.checks.map(c=>c.kind), ['syntax'])
  const defaultBatch = await verify.execute({ batch }, exec)
  assert.deepEqual(defaultBatch.checks, ['bridge', 'syntax'])
  const byPath = await verify.execute({ path: 'inline.js', checks: ['syntax', 'bridge', 'ipc'] }, exec); assert.notEqual(byPath.status, 'passed'); assert.equal(byPath.verification.persisted, true)
  assert.ok(byPath.checks.filter(c=>c.kind!=='syntax').every(c=>c.status==='not_run' && c.reason.includes('no_baseline')))
  assert.ok(listRecords(storeFor(root), { limit: 20 }).records.some(r => r.batchIds.length === 0))
  assert.deepEqual(get('inline.js'), before); assert.equal(readLedgerTail(storeFor(root)).length, batches)
  for (const args of [{ batch: String(batch) }, { batch, path: 'inline.js' }, { path: '../outside.js' }, { path: 'inline.js', checks: ['tests'] }, {}]) assert.ok((await verify.execute(args, exec)).error)
})
await test('canonical transfers preserve comments by default and omit them explicitly', async () => {
  put('transfer.js', '/** selected */\r\nfunction selected() {}\r\n'); put('full.js', '\uFEFF// destination\r\n'); put('bare.js', '')
  const full = await call({ action: 'copy_code', path: 'transfer.js', sourceSymbol: 'selected', destination: 'full.js', after: 1 }); assert.ok(full.batch, JSON.stringify(full)); assert.match(get('full.js').toString(), /\uFEFF\/\/ destination\r\n\/\*\* selected \*\/\r\nfunction selected/)
  const bare = await call({ action: 'copy_code', path: 'transfer.js', sourceSymbol: 'selected', includeLeadingComment: false, destination: 'bare.js', after: 0 }); assert.ok(bare.batch, JSON.stringify(bare)); assert.equal(get('bare.js').toString().includes('/**'), false)
})
await test('literal edits, tickets and symbol insertion/deletion use shared edit behavior', async () => {
  put('ticket.txt', 'same\nsame\n')
  const ticket = await change({ path: 'ticket.txt', find: 'same', replaceWith: 'other' }); assert.equal(ticket.status, 'ticket')
  const selected = await edit.execute({ ticket: ticket.ticket, choice: '0' }, exec); assert.equal(selected.status, 'applied'); assert.equal(get('ticket.txt').toString(), 'other\nsame\n'); assert.ok(selected.audit)
  put('comments.js', '/** keep */\r\nfunction original() {}\r\n')
  const replaced = await change({ path: 'comments.js', sourceSymbol: 'original', includeLeadingComment: false, edit: 'replace', content: 'function renamed() {}' }); assert.ok(replaced.batch, JSON.stringify(replaced)); assert.equal(get('comments.js').toString(), '/** keep */\r\nfunction renamed() {}\r\n')
  const inserted = await change({ path: 'comments.js', sourceSymbol: 'renamed', edit: 'insert_after', content: '\nfunction extra() {}' }); assert.ok(inserted.batch, JSON.stringify(inserted))
  const removed = await change({ path: 'comments.js', sourceSymbol: 'renamed', edit: 'delete' }); assert.ok(removed.batch, JSON.stringify(removed)); assert.equal(get('comments.js').toString().includes('/** keep */'), false); assert.match(get('comments.js').toString(), /function extra/)
})
await test('factory schemas and actual outputs validate in the host SDK', async () => {
  const runtime = Object.create(ToolRuntime.prototype); runtime.canonicalResults = new WeakMap(); runtime.concludingExecutions = new WeakSet()
  for (const [tool, args] of [[file, { action: 'create', path: 'sdk.txt', content: 'sdk', reason: 'SDK test' }], [edit, { path: 'sdk.txt', find: 'sdk', replaceWith: 'valid', reason: 'SDK test' }], [createHistoryTool(), { pathContains: 'sdk' }], [createRollbackTool(pool), { latest: true, reason: 'SDK plan' }], [edit, { action: 'verify', path: 'comments.js', verify: ['syntax'] }]]) {
    const result = await tool.execute(args, exec); assert.ok(!result.error, JSON.stringify(result)); runtime.createSuccessResult(exec, defineTool(tool), result)
  }
})
await test('verify rejects nonexistent batch instead of implying existing scope', async () => {
  const result = await edit.execute({ action: 'verify', batch: 999999, verify: ['syntax'] }, exec); assert.ok(result.error, JSON.stringify(result))
})
await test('inline destination symbol anchors refuse scope-changing whole-line insertion without writes', async () => {
  put('anchor-source.js', 'function inserted() {}\n')
  for (const anchor of ['beforeSymbol', 'afterSymbol']) {
    put('anchor-inline.js', 'class C { a() {} b() {} }\r\n')
    const before = get('anchor-inline.js'), ledger = readLedgerTail(storeFor(root)).length
    const result = await call({ action: 'copy_code', path: 'anchor-source.js', sourceSymbol: 'inserted', destination: 'anchor-inline.js', [anchor]: 'C.a' })
    assert.match(result.error ?? '', /inline.*ff_edit/i, JSON.stringify(result)); assert.deepEqual(get('anchor-inline.js'), before); assert.equal(readLedgerTail(storeFor(root)).length, ledger)
  }
})
await test('standalone destination symbol anchors still insert at the requested boundary', async () => {
  for (const anchor of ['beforeSymbol', 'afterSymbol']) {
    put('anchor-standalone.js', '/** target */\nfunction target() {}\n')
    const result = await call({ action: 'copy_code', path: 'anchor-source.js', sourceSymbol: 'inserted', destination: 'anchor-standalone.js', [anchor]: 'target' }); assert.ok(result.batch, JSON.stringify(result))
    const value = get('anchor-standalone.js').toString()
    assert.equal(value.indexOf('function inserted') < value.indexOf('/** target */'), anchor === 'beforeSymbol')
  }
})
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
