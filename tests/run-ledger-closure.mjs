import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const temp = mkdtempSync(path.join(os.tmpdir(), 'forge-closure-'))
import { Readable } from 'node:stream'
process.env.DSH_FORGE_DATA_DIR = path.join(temp, 'private')
const { projectAction: act, getProject, projectOverview } = await import('../src/projects.ts')
const ledger = await import('../src/ledger.ts')
const api = await import('../src/ledger-api.ts')
const { createFileTool } = await import('../src/tools-files.ts')
const { createEditTool, createRollbackTool, createHistoryTool } = await import('../src/tools-edit.ts')
const { createLedgerRollbackService } = await import('../src/ledger-rollback.ts')
const { FinderPool } = await import('../src/core.ts')
const { appendRecord, VERIFICATION_SCHEMA } = await import('../src/verification.ts')
const workspace = path.join(temp, 'work'); mkdirSync(workspace)
const pool = new FinderPool()
const { createLedgerHandler } = await import('../src/http-plugin.ts')
async function httpGet(params) {
 const request = Readable.from([]); request.method = 'GET'; request.url = '/forge-ledger?' + new URLSearchParams({ workspace, ...params }); request.headers = {}
 const out = {}; await createLedgerHandler()(request, { writeHead(status) { out.status = status }, end(value) { out.body = JSON.parse(value) } }); return out
}
const exec = { agent: { session: { header: { cwd: workspace, id: 'contract-actor' } } } }
const fileTool = createFileTool(), edit = createEditTool(pool), rollback = createRollbackTool(pool)
const call = input => act({ workspace, ...input })
let p, taskId, direct, manual, unassigned, passed = 0, failed = 0
async function test(name, fn) { try { await fn(); passed++; console.log('PASS', name) } catch (e) { failed++; console.error('FAIL', name, e) } }
const last = () => ledger.readLedgerTail(ledger.storeFor(workspace), 1)[0]
try {
p = await call({ action: 'create', name: 'Closure' })
p = await call({ action: 'task_add', projectId: p.id, revision: p.revision, title: 'Implement' }); taskId = p.tasks[0].id
await test('file construction commits explicit attribution in the same ledger record, without mutating project revision', async () => {
 const r = await fileTool.execute({ action: 'create', path: 'a.txt', content: 'one\n', reason: 'seed', projectId: p.id, taskId }, exec)
 assert.ok(!r.error, r.error); direct = last(); assert.deepEqual(direct.attribution, { projectId: p.id, taskId }); assert.equal(direct.id, r.batch)
 assert.equal(getProject(workspace, p.id).revision, p.revision); assert.equal(projectOverview(workspace, p.id).batches, 1)
})
await test('invalid project/task/type and archived project fail before file or ledger writes', async () => {
 const before = readFileSync(path.join(workspace, 'a.txt')), n = last().id
 for (const fields of [{ projectId: 'missing' }, { taskId }, { projectId: p.id, taskId: 'missing' }, { projectId: 3 }, { projectId: '' }]) {
  const r = await edit.execute({ path: 'a.txt', find: 'one', replaceWith: 'bad', reason: 'invalid', ...fields }, exec)
  assert.ok(r.error, JSON.stringify(fields)); assert.deepEqual(readFileSync(path.join(workspace, 'a.txt')), before); assert.equal(last().id, n)
 }
 let archived = await call({ action: 'create', name: 'Archived' }); archived = await call({ action: 'update', projectId: archived.id, revision: archived.revision, status: 'archived' })
 const r = await fileTool.execute({ action: 'create', path: 'blocked.txt', content: 'bad', reason: 'invalid', projectId: archived.id }, exec)
 assert.match(r.error, /archived/); assert.equal(last().id, n)
})
await test('unattributed legacy calls remain valid, and manual links deduplicate project statistics', async () => {
 const a = await fileTool.execute({ action: 'create', path: 'manual.txt', content: 'manual', reason: 'manual' }, exec); assert.ok(!a.error, a.error); manual = last()
 p = await call({ action: 'link', projectId: p.id, revision: p.revision, taskId, batchId: manual.id })
 await fileTool.execute({ action: 'create', path: 'loose.txt', content: 'loose', reason: 'loose' }, exec); unassigned = last()
 assert.equal(projectOverview(workspace, p.id).batches, 2)
 p = await call({ action: 'link', projectId: p.id, revision: p.revision, taskId, batchId: direct.id })
 assert.equal(projectOverview(workspace, p.id).batches, 2)
})
await test('project, task, exact-file and unassigned filters compose and expose origin', async () => {
 const rows = api.ledgerList(workspace, { projectId: p.id }).batches
 assert.deepEqual(rows.map(b => b.id).sort((a,b)=>a-b), [direct.id, manual.id])
 assert.equal(rows.find(b => b.id === direct.id).membership, 'direct'); assert.equal(rows.find(b => b.id === manual.id).membership, 'linked')
 assert.deepEqual(api.ledgerList(workspace, { projectId: p.id, taskId, file: 'a.txt' }).batches.map(b=>b.id), [direct.id])
 assert.deepEqual(api.ledgerList(workspace, { unassigned: true }).batches.map(b=>b.id), [unassigned.id])
 const history = await createHistoryTool().execute({ projectId: p.id, taskId, file: 'a.txt' }, exec)
 assert.ok(!history.error, history.error); assert.deepEqual(history.items.map(b => b.batch), [direct.id])
 assert.throws(() => api.ledgerList(workspace, { taskId }), /projectId/)
 assert.throws(() => api.ledgerList(workspace, { projectId: p.id, unassigned: true }), /exclusive/)
})
await test('HTTP forwards project/task/unassigned/exact-file filters and snapshot pages with strict bounds', async () => {
 let r = await httpGet({ projectId: p.id, taskId, file: 'a.txt' }); assert.equal(r.status, 200); assert.deepEqual(r.body.batches.map(b=>b.id), [direct.id])
 r = await httpGet({ unassigned: 'true' }); assert.equal(r.status, 200); assert.deepEqual(r.body.batches.map(b=>b.id), [unassigned.id])
 r = await httpGet({ node: `b${direct.id}:n0`, side: 'after', offset: '1', limit: '2' }); assert.equal(r.status, 200); assert.equal(r.body.snapshot.text, 'ne')
 for (const params of [{ unassigned: 'nope' }, { node: `b${direct.id}:n0`, side: 'wrong' }, { node: `b${direct.id}:n0`, side: 'after', offset: '-1' }]) assert.equal((await httpGet(params)).status, 400)
})
await test('membership-changing revisions invalidate project pagination rather than skipping history', async () => {
 const page = api.ledgerList(workspace, { projectId: p.id, limit: 1 }); assert.ok(page.nextCursor)
 p = await call({ action: 'task_update', projectId: p.id, revision: p.revision, taskId, note: 'revision' })
 assert.throws(() => api.ledgerList(workspace, { projectId: p.id, limit: 1, cursor: page.nextCursor }), /changed/)
})
await test('ambiguity ticket preserves attribution and revalidates it on resolution', async () => {
 writeFileSync(path.join(workspace, 'ticket.txt'), 'same\nsame\n')
 const r = await edit.execute({ path: 'ticket.txt', find: 'same', replaceWith: 'chosen', reason: 'ticket', projectId: p.id, taskId }, exec)
 assert.ok(r.ticket, JSON.stringify(r))
 const applied = await edit.execute({ ticket: r.ticket, choice: '0' }, exec); assert.ok(!applied.error, applied.error); assert.deepEqual(last().attribution, { projectId: p.id, taskId })
})
await test('ticket resolution refuses a now-archived task without modifying its file', async () => {
 const ticket = await edit.execute({ path: 'ticket.txt', find: 'same', replaceWith: 'same\nsame', reason: 'expand', projectId: p.id, taskId }, exec); assert.ok(!ticket.error, ticket.error)
 const ambiguous = await edit.execute({ path: 'ticket.txt', find: 'same', replaceWith: 'blocked', reason: 'park', projectId: p.id, taskId }, exec); assert.ok(ambiguous.ticket)
 p = await call({ action: 'task_update', projectId: p.id, revision: p.revision, taskId, archived: true })
 const before = readFileSync(path.join(workspace, 'ticket.txt')), count = last().id
 const r = await edit.execute({ ticket: ambiguous.ticket, choice: '0' }, exec); assert.match(r.error, /archived/); assert.deepEqual(readFileSync(path.join(workspace, 'ticket.txt')), before); assert.equal(last().id, count)
 p = await call({ action: 'task_update', projectId: p.id, revision: p.revision, taskId, archived: false })
})
await test('report freezes concrete batch/node/blob/check references and submission-time applicability', async () => {
 const store = ledger.storeFor(workspace)
 const record = { schema: VERIFICATION_SCHEMA, id: 'closure-check', workspaceId: 'closure', batchIds: [direct.id], afterHashes: [{ file: 'a.txt', hash: direct.nodes[0].after }], checks: [{ id: 'syntax', kind: 'syntax', status: 'passed', coverage: { files: 1 }, findings: [] }], requiredChecks: ['syntax'], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), provenance: 'internal-static' }
 assert.equal((await appendRecord(store, workspace, record)).ok, true)
 p = await call({ action: 'report', projectId: p.id, revision: p.revision, status: 'review', conclusion: 'Review', issues: [] })
 const report = p.reports.at(-1), e = report.evidence
 assert.equal(e.version, 1); assert.equal(e.projectRevision, p.revision - 1); assert.ok(e.batches.some(b => b.id === direct.id && b.nodes[0].node === `b${direct.id}:n0` && b.nodes[0].after === direct.nodes[0].after))
 assert.equal(e.verification.find(r=>r.id===record.id).effective, 'passed'); assert.equal(e.verification.find(r=>r.id===record.id).applicable, true)
 assert.equal(e.verification.find(r=>r.id===record.id).record.id, record.id)
 const frozen = JSON.stringify(report)
 p = await call({ action: 'unlink', projectId: p.id, revision: p.revision, taskId, batchId: manual.id })
 writeFileSync(path.join(workspace, 'a.txt'), 'drift\n')
 assert.equal(JSON.stringify(getProject(workspace, p.id).reports.at(-1)), frozen)
})
await test('report refuses unreadable verification evidence without changing project revision', async () => {
 const store = ledger.storeFor(workspace), original = p.revision
 const filename = path.join(store.dir, 'verification', 'closure-check.json'), raw = readFileSync(filename)
 try { writeFileSync(filename, '{broken'); await assert.rejects(call({ action: 'report', projectId: p.id, revision: original, status: 'review', conclusion: 'Incomplete', issues: [] }), /unreadable|evidence/); assert.equal(getProject(workspace, p.id).revision, original) }
 finally { writeFileSync(filename, raw) }
})
await test('complete immutable snapshot supports bounded paging, absence and corruption without silent truncation', async () => {
 assert.equal(typeof api.ledgerNodeSnapshot, 'function')
 const text = '\uFEFF' + 'line 😀\r\n'.repeat(12000), store = ledger.storeFor(workspace), blob = ledger.putBlob(store, Buffer.from(text))
 const b = ledger.recordBatch(store, { kind: 'edit', reason: 'large', actor: 'test', nodes: [{ file: 'large.txt', op: 'create', before: null, after: blob.id, bytes: Buffer.byteLength(text), eol: 'CRLF', bom: true }] })
 let result = '', offset = 0
 do { const chunk = api.ledgerNodeSnapshot(workspace, `b${b.id}:n0`, 'after', offset, 4096); assert.equal(chunk.status, 'text'); assert.equal(chunk.hash, blob.id); assert.ok(chunk.text.length <= 4096); result += chunk.text; offset = chunk.nextOffset } while (offset !== null)
 assert.equal(result, text); assert.equal(api.ledgerNodeSnapshot(workspace, `b${b.id}:n0`, 'before').status, 'absent')
 assert.throws(() => api.ledgerNodeSnapshot(workspace, `b${b.id}:n0`, 'nope'), /side/)
 const binary = ledger.putBlob(store, Buffer.from([0, 1, 255])); const bin = ledger.recordBatch(store, { kind: 'edit', reason: 'binary', actor: 'test', nodes: [{ file: 'bin', op: 'create', before: null, after: binary.id, bytes: 3, eol: 'LF', bom: false }] })
 assert.equal(api.ledgerNodeSnapshot(workspace, `b${bin.id}:n0`, 'after').status, 'binary')
 writeFileSync(path.join(store.blobsDir, `${blob.id}.gz`), 'corrupt'); assert.equal(api.ledgerNodeSnapshot(workspace, `b${b.id}:n0`, 'after').status, 'unreadable')
})
await test('node before/after restore affects only selected file and supports creation/deletion snapshots', async () => {
 const created = await fileTool.execute({ action: 'create', path: 'restore.txt', content: 'A', reason: 'seed' }, exec); assert.ok(!created.error, created.error)
 const changed = await edit.execute({ path: 'restore.txt', find: 'A', replaceWith: 'B', reason: 'second' }, exec); assert.ok(!changed.error, changed.error); const b = last()
 writeFileSync(path.join(workspace, 'restore.txt'), 'C'); const loose = readFileSync(path.join(workspace, 'loose.txt'))
 for (const [version, expected] of [['before', 'A'], ['after', 'B']]) {
  const r = await rollback.execute({ batch: b.id, node: `b${b.id}:n0`, version, dryRun: false, reason: 'restore' }, exec)
  assert.ok(!r.error, r.error); assert.equal(readFileSync(path.join(workspace, 'restore.txt'), 'utf8'), expected); assert.deepEqual(readFileSync(path.join(workspace, 'loose.txt')), loose)
 }
 const invalid = await rollback.execute({ batch: b.id, version: 'after', reason: 'invalid' }, exec); assert.match(invalid.error, /node/)
})
await test('restoring create-before deletes only that file; delete-before recreates; delete-after removes', async () => {
 const created = await fileTool.execute({ action: 'create', path: 'presence.txt', content: 'bytes', reason: 'presence' }, exec)
 let r = await rollback.execute({ batch: created.batch, node: `b${created.batch}:n0`, version: 'before', dryRun: false, reason: 'absent' }, exec); assert.ok(!r.error, r.error)
 r = await rollback.execute({ batch: created.batch, node: `b${created.batch}:n0`, version: 'after', dryRun: false, reason: 'recreate' }, exec); assert.ok(!r.error, r.error); assert.equal(readFileSync(path.join(workspace, 'presence.txt'), 'utf8'), 'bytes')
 const removed = await fileTool.execute({ action: 'remove', path: 'presence.txt', reason: 'remove' }, exec)
 for (const version of ['before', 'after']) { r = await rollback.execute({ batch: removed.batch, node: `b${removed.batch}:n0`, version, dryRun: false, reason: version }, exec); assert.ok(!r.error, r.error) }
})
await test('GUI after-version restoration binds preview to side and rejects drift or token reuse', async () => {
 const b = direct, service = createLedgerRollbackService({ guard: async e => ({ ...e, withNativeWrite: async (_files, fn) => fn() }) })
 const args = { action: 'preview', workspace, selection: { batch: b.id, node: `b${b.id}:n0`, version: 'after' }, reason: 'gui version' }
 const preview = await service(args); writeFileSync(path.join(workspace, 'a.txt'), 'new drift')
 await assert.rejects(service({ action: 'confirm', workspace, token: preview.token, reason: args.reason }), /changed/)
 const valid = await service(args); const r = await service({ action: 'confirm', workspace, token: valid.token, reason: args.reason }); assert.equal(r.result.status, 'applied'); assert.equal(readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'one\n')
 await assert.rejects(service({ action: 'confirm', workspace, token: valid.token, reason: args.reason }), /consumed|expired/)
})
console.log(`${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
} finally { pool.disposeAll(); rmSync(temp, { recursive: true, force: true }) }
