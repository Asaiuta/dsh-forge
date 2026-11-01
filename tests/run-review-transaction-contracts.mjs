import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { storeFor, ensureWorkspaceMeta, putBlob, getBlob, gcStoreBlobs, recoverStore, readLedgerTail, pruneOrphanedStores, workspaceKey } from '../src/ledger.ts'
import { withFileLock } from '../src/core.ts'
import { createStatusCommand } from '../src/status.ts'
import { createEditTool } from '../src/tools-edit.ts'
import { loadTicket } from '../src/tickets.ts'
import { CAPTURE_SCHEMA, saveBaseline, fileSetDigestOf } from '../src/trace-capture.ts'
import { listRecords } from '../src/verification.ts'

const temp = mkdtempSync(path.join(tmpdir(), 'forge-transaction-contracts-'))
const oldData = process.env.DSH_FORGE_DATA_DIR
process.env.DSH_FORGE_DATA_DIR = path.join(temp, 'data')
process.env.DSH_FORGE_INDEXER = 'off'
process.env.DSH_FORGE_AST_WORKERS = '0'
after(() => {
  if (oldData === undefined) delete process.env.DSH_FORGE_DATA_DIR
  else process.env.DSH_FORGE_DATA_DIR = oldData
  rmSync(temp, { recursive: true, force: true })
})
const pool = { peekMain: () => null, live: () => [] }
const edit = createEditTool(pool)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let counter = 0
function fixture(content = 'old\n', name = 'a.js') {
  const root = path.join(temp, `workspace-${++counter}`)
  mkdirSync(root)
  const file = path.join(root, name)
  writeFileSync(file, content)
  const store = storeFor(root)
  ensureWorkspaceMeta(store)
  const exec = { agent: { session: { header: { cwd: root, id: 'transaction-test' } } } }
  return { root, file, store, exec }
}
function journal(f, before, afterBytes) {
  const beforeId = putBlob(f.store, Buffer.from(before)).id
  const afterId = putBlob(f.store, Buffer.from(afterBytes)).id
  writeFileSync(f.file, afterBytes)
  writeFileSync(path.join(f.store.dir, 'transaction.json'), JSON.stringify({ transaction: randomBytes(8).toString('hex'), nodes: [{ file: f.file, before: beforeId, after: afterId }] }))
  return { beforeId, afterId }
}
function baseline(f, content) {
  const files = [{ path: path.basename(f.file), rawHash: hash(content), textHash: hash(content), bytes: Buffer.byteLength(content) }]
  const snapshotId = randomBytes(12).toString('hex')
  assert.equal(saveBaseline({ schema: CAPTURE_SCHEMA, snapshotId, workspaceId: f.root, configKey: 'test', config: {}, provider: 'wasm', providerVersion: 'test', createdAt: new Date().toISOString(), strength: 'content-bound', files, fileSetDigest: fileSetDigestOf(files), probes: 1, scanned: 1, truncated: false, partialFiles: 0, parseErrors: 0, walkErrors: 0, capturedBytes: files[0].bytes, facts: { [files[0].path]: {} } }).ok, true)
  return snapshotId
}

test('GC retains pending WAL before/after blobs and still collects unrelated garbage', () => {
  const f = fixture()
  const { beforeId, afterId } = journal(f, 'original\n', 'partial edit\n')
  const garbage = putBlob(f.store, Buffer.from('unreferenced')).id
  const freed = gcStoreBlobs(f.store)
  assert.deepEqual(freed.map(row => row.id), [garbage])
  assert.ok(getBlob(f.store, beforeId))
  assert.ok(getBlob(f.store, afterId))
  recoverStore(f.store)
  assert.equal(readFileSync(f.file, 'utf8'), 'original\n')
})

test('GC fails closed on malformed pending WAL without deleting any blob', () => {
  const f = fixture()
  const id = putBlob(f.store, Buffer.from('protected until journal is repaired')).id
  writeFileSync(path.join(f.store.dir, 'transaction.json'), '{broken')
  assert.throws(() => gcStoreBlobs(f.store))
  assert.ok(getBlob(f.store, id))
})

test('status prune waits for the workspace transaction lock before GC', async () => {
  const f = fixture()
  const id = putBlob(f.store, Buffer.from('transaction has not published references')).id
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const held = withFileLock(f.store.dir, async () => { entered(); await gate })
  await ready
  const command = createStatusCommand(pool)
  const pruning = command.handler({ ...f.exec, rawInput: 'prune' })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(getBlob(f.store, id), 'GC must not run while another transaction owns the workspace lock')
  } finally {
    release()
    await held
    await pruning
  }
  assert.equal(getBlob(f.store, id), null, 'unreferenced blob is collected after lock release')
})

test('recovery precedes baseline validation: pending-state baseline is rejected', async () => {
  const f = fixture()
  journal(f, 'old\n', 'pending\n')
  const snapshotId = baseline(f, 'pending\n')
  const result = await edit.execute({ path: f.file, find: 'old', replaceWith: 'new', reason: 'baseline contract', snapshotId }, f.exec)
  assert.match(result.error ?? '', /snapshot .* rejected/)
  assert.equal(readFileSync(f.file, 'utf8'), 'old\n')
  assert.equal(readLedgerTail(f.store).length, 0)
})

test('recovery precedes baseline validation: restored-state baseline permits edit', async () => {
  const f = fixture()
  journal(f, 'old\n', 'pending\n')
  const snapshotId = baseline(f, 'old\n')
  const result = await edit.execute({ path: f.file, find: 'old', replaceWith: 'new', reason: 'baseline contract', snapshotId }, f.exec)
  assert.equal(result.status, 'applied', JSON.stringify(result))
  assert.equal(result.beforeEvidence.verified, true)
  assert.equal(readFileSync(f.file, 'utf8'), 'new\n')
})

test('ticket final commit retains verify checks and the decision execution workspace', async () => {
  const f = fixture('const oldA = 1;\nconst oldA = 1;\n')
  const first = await edit.execute({ path: f.file, find: 'const oldA = 1;', replaceWith: 'const newA = 1;', reason: 'ticket verification', verify: ['syntax'] }, f.exec)
  assert.ok(first.ticket, JSON.stringify(first))
  assert.equal(first.verification.status, 'not_run')
  const result = await edit.execute({ ticket: first.ticket, choice: '0' }, f.exec)
  assert.equal(result.status, 'applied', JSON.stringify(result))
  assert.equal(result.verification?.persisted, true, JSON.stringify(result))
  assert.equal(listRecords(f.store).records.length, 1)
})

test('verify checks persist across subsequent ambiguities before final commit', async () => {
  const f = fixture('let alpha = 1;\nlet alpha = 1;\nlet beta = 2;\nlet beta = 2;\n')
  const first = await edit.execute({ path: f.file, steps: [{ find: 'let alpha = 1;', replaceWith: 'let alpha2 = 1;' }, { find: 'let beta = 2;', replaceWith: 'let beta2 = 2;' }], reason: 'successive decisions', verify: ['syntax', 'syntax'] }, f.exec)
  assert.ok(first.ticket, JSON.stringify(first))
  assert.deepEqual(loadTicket(first.ticket).verify, ['syntax'])
  const second = await edit.execute({ ticket: first.ticket, choice: '0' }, f.exec)
  assert.ok(second.ticket, JSON.stringify(second))
  assert.notEqual(second.ticket, first.ticket)
  assert.deepEqual(loadTicket(second.ticket).verify, ['syntax'])
  assert.equal(readLedgerTail(f.store).length, 0)
  const result = await edit.execute({ ticket: second.ticket, choice: '0' }, f.exec)
  assert.equal(result.status, 'applied', JSON.stringify(result))
  assert.equal(result.verification?.persisted, true, JSON.stringify(result))
  assert.equal(listRecords(f.store).records.length, 1)
})

test('ticket source hash is checked after recovery and never commits a stale decision', async () => {
  const f = fixture('old\nold\n', 'a.txt')
  const first = await edit.execute({ path: f.file, find: 'old', replaceWith: 'new', reason: 'recovery invalidates ticket' }, f.exec)
  assert.ok(first.ticket)
  journal(f, 'restored\nrestored\n', 'old\nold\n')
  const result = await edit.execute({ ticket: first.ticket, choice: '0' }, f.exec)
  assert.ok(result.error || result.ticket, JSON.stringify(result))
  assert.equal(readFileSync(f.file, 'utf8'), 'restored\nrestored\n')
  assert.equal(readLedgerTail(f.store).length, 0)
})

test('persisted ticket rejects invalid verify selectors before writing', async () => {
  const f = fixture('old\nold\n', 'a.txt')
  const first = await edit.execute({ path: f.file, find: 'old', replaceWith: 'new', reason: 'invalid ticket checks' }, f.exec)
  const ticket = loadTicket(first.ticket)
  const ticketPath = path.join(process.env.DSH_FORGE_DATA_DIR, 'tickets', `${ticket.id}.json`)
  writeFileSync(ticketPath, JSON.stringify({ ...ticket, verify: ['shell'] }))
  const result = await edit.execute({ ticket: first.ticket, choice: '0' }, f.exec)
  assert.ok(result.error, JSON.stringify(result))
  assert.equal(readFileSync(f.file, 'utf8'), 'old\nold\n')
})


test('orphan cleanup preserves a store whose workspace vanished with pending recovery', () => {
  const f = fixture()
  const { beforeId } = journal(f, 'recoverable\n', 'partial\n')
  rmSync(f.root, { recursive: true, force: true })
  assert.deepEqual(pruneOrphanedStores([f.store]), [])
  assert.ok(getBlob(f.store, beforeId))
  assert.ok(existsSync(path.join(f.store.dir, 'transaction.json')))
})

test('stale ticket re-planning preserves verify across a new decision', async () => {
  const f = fixture('let alpha = 1;\nlet alpha = 1;\n')
  const first = await edit.execute({ path: f.file, find: 'let alpha = 1;', replaceWith: 'let alpha2 = 1;', reason: 'stale continuation', verify: ['syntax'] }, f.exec)
  writeFileSync(f.file, '// external change\nlet alpha = 1;\nlet alpha = 1;\n')
  const replanned = await edit.execute({ ticket: first.ticket, choice: '0' }, f.exec)
  assert.ok(replanned.ticket, JSON.stringify(replanned))
  assert.deepEqual(loadTicket(replanned.ticket).verify, ['syntax'])
  assert.equal(replanned.verification.status, 'not_run')
  const result = await edit.execute({ ticket: replanned.ticket, choice: '0' }, f.exec)
  assert.equal(result.status, 'applied', JSON.stringify(result))
  assert.equal(result.verification?.persisted, true, JSON.stringify(result))
  const { records } = listRecords(f.store)
  assert.equal(records.length, 1)
  assert.equal(records[0].workspaceId, workspaceKey(f.root))
  assert.deepEqual(records[0].checks.map(check => check.kind), ['syntax'])
})

test('legacy ticket without verify retains backward-compatible commit semantics', async () => {
  const f = fixture('old\nold\n', 'a.txt')
  const first = await edit.execute({ path: f.file, find: 'old', replaceWith: 'new', reason: 'legacy ticket' }, f.exec)
  assert.equal(loadTicket(first.ticket).verify, undefined)
  const result = await edit.execute({ ticket: first.ticket, choice: '0' }, f.exec)
  assert.equal(result.status, 'applied', JSON.stringify(result))
  assert.equal(result.verification, undefined)
  assert.equal(listRecords(f.store).records.length, 0)
})

test('ticket no-op retains requested verification as not_run without inventing a record', async () => {
  const f = fixture('let same = 1;\nlet same = 1;\n')
  const first = await edit.execute({ path: f.file, find: 'let same = 1;', replaceWith: 'let same = 1;', reason: 'no-op decision', verify: ['syntax'] }, f.exec)
  assert.ok(first.ticket, JSON.stringify(first))
  const result = await edit.execute({ ticket: first.ticket, choice: '0' }, f.exec)
  assert.equal(result.verification?.status, 'not_run', JSON.stringify(result))
  assert.equal(listRecords(f.store).records.length, 0)
  assert.equal(readLedgerTail(f.store).length, 0)
})
