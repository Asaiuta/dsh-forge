import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temp = mkdtempSync(path.join(os.tmpdir(), 'forge-project-output-'))
process.env.DSH_FORGE_DATA_DIR = path.join(temp, 'private')
const { projectAction, getProject, listProjects, captureTodoProject } = await import('../src/projects.ts')
const { createProjectTool } = await import('../src/tools-project.ts')
const { ProjectOutput } = await import('../src/project-output.ts')
const { defineForgeTool } = await import('../src/host.ts')
const { storeFor, putBlob, recordBatch } = await import('../src/ledger.ts')
const workspace = path.join(temp, 'work'), other = path.join(temp, 'other')
mkdirSync(workspace); mkdirSync(other)
const factory = createProjectTool(), tool = defineForgeTool(factory)
const exec = { agent: { session: { header: { cwd: workspace, id: 'output-test' } } } }
let passed = 0
async function test(name, fn) { await fn(); console.log('PASS', name); passed++ }
async function call(args) {
 const result = await tool.execute(args, exec)
 assert.equal(result.ok, true)
 const text = tool.output.render(args, result).map(p => p.text).join('\n')
 assert.deepEqual(JSON.parse(text), result.payload, 'native and structured results carry the same projection')
 assert.ok(Buffer.byteLength(text) <= 12 * 1024, 'rendered page exceeds budget')
 assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12 * 1024, 'structured page exceeds budget')
 return result.payload
}
async function pages(args, key) {
 const items = [], cursors = new Set()
 let cursor, snapshot, total
 do {
  const page = await call({ ...args, ...(cursor ? { cursor } : {}) })
  snapshot ??= page.snapshot; total ??= page.total
  assert.equal(page.snapshot, snapshot); assert.equal(page.total, total)
  assert.equal(page.returned, page[key].length)
  items.push(...page[key]); cursor = page.nextCursor
  assert.equal(page.complete, !cursor)
  if (cursor) { assert.ok(page.returned > 0); assert.ok(!cursors.has(cursor)); cursors.add(cursor) }
 } while (cursor)
 assert.equal(items.length, total)
 return items
}
async function record(args, onFirst) {
 let text = '', cursor, snapshot, count = 0
 do {
  const page = await call({ action: 'get', detail: 'record', ...args, ...(cursor ? { cursor } : {}) })
  assert.equal(page.format, 'json-fragment'); assert.equal(page.offset, text.length)
  assert.ok(page.text.isWellFormed(), 'a page splits a surrogate pair')
  snapshot ??= page.snapshot; assert.equal(page.snapshot, snapshot)
  text += page.text; count++; cursor = page.nextCursor
  assert.equal(page.complete, !cursor)
  if (page.complete) assert.equal(text.length, page.totalChars)
  else assert.ok(page.text.length > 0)
  if (count === 1 && onFirst) await onFirst()
 } while (cursor)
 return { value: JSON.parse(text), count }
}
const todos = n => Array.from({ length: n }, (_, i) => ({ content: `Task ${i}: verify bounded output and preserve evidence`, status: 'pending' }))
let p, large, frozen, frozenEvidence
try {
await test('100 to 1000 tasks keep mutation and default query results bounded', async () => {
 const sizes = []
 for (const n of [100, 1000]) {
  const plan = await captureTodoProject(workspace, { sessionId: `scale-${n}`, callId: 'one', turn: 1 }, todos(n))
  const changed = await call({ action: 'task_update', projectId: plan.id, revision: plan.revision, taskId: plan.tasks[0].id, status: 'done' })
  assert.equal(changed.task.id, plan.tasks[0].id); assert.equal(changed.tasks.total, n); assert.equal(changed.tasks.done, 1)
  assert.equal('reports' in changed.project, false)
  const summary = await call({ action: 'get', projectId: plan.id })
  assert.equal(summary.project.tasks.total, n); assert.equal(typeof summary.project.reports, 'number')
  sizes.push(Buffer.byteLength(JSON.stringify(changed)))
  assert.ok(sizes.at(-1) < 1000); assert.ok(JSON.stringify(summary).length < 1000)
  if (n === 100) p = getProject(workspace, plan.id)
  else large = getProject(workspace, plan.id)
 }
 assert.ok(Math.abs(sizes[1] - sizes[0]) < 30)
})
await test('all 1000 tasks remain reachable without duplicates across row and byte limits', async () => {
 const all = await pages({ action: 'get', projectId: large.id, detail: 'tasks', limit: 100 }, 'tasks')
 assert.deepEqual(all.map(t => t.id), large.tasks.map(t => t.id))
 assert.equal(new Set(all.map(t => t.id)).size, 1000)
})
await test('long Unicode previews are explicit and the selected task record is lossless', async () => {
 const title = 'x'.repeat(239) + '😀' + '长标题'.repeat(200)
 const note = '中文😀"\\\n'.repeat(1500)
 const changed = await call({ action: 'task_update', projectId: p.id, revision: p.revision, taskId: p.tasks[0].id, title, note })
 assert.deepEqual(changed.task.truncated, ['title', 'note']); assert.ok(changed.task.title.isWellFormed())
 p = getProject(workspace, p.id)
 const full = await record({ projectId: p.id, taskId: p.tasks[0].id })
 assert.ok(full.count > 1); assert.deepEqual(full.value, p.tasks[0])
 const selected = await pages({ action: 'get', projectId: p.id, detail: 'tasks', taskId: p.tasks[0].id }, 'tasks')
 assert.equal(selected.length, 1); assert.equal(selected[0].id, p.tasks[0].id)
})
await test('invalid view arguments fail before a mutation writes storage', async () => {
 const filename = path.join(storeFor(workspace).dir, 'projects.json'), before = readFileSync(filename)
 const base = { action: 'update', projectId: p.id, revision: p.revision, name: 'must not commit' }
 for (const fields of [{ detail: 'tasks' }, { cursor: 'bad' }, { limit: 1 }, { reportId: 'bad' }, { unexpected: true }]) {
  await assert.rejects(tool.execute({ ...base, ...fields }, exec))
 }
 assert.deepEqual(readFileSync(filename), before)
 for (const fields of [{ detail: 'evidence' }, { detail: 'tasks', limit: 101 }, { detail: 'tasks', limit: 0 }, { detail: 'tasks', limit: 1.5 }, { detail: 'record', taskId: p.tasks[0].id, reportId: 'bad' }]) {
  await assert.rejects(tool.execute({ action: 'get', projectId: p.id, ...fields }, exec))
 }
})
await test('cursors reject changed query, limit, workspace and Todo updates without revision changes', async () => {
 const args = { action: 'get', projectId: large.id, detail: 'tasks', limit: 1 }
 const first = await call(args)
 const { limit, ...withoutLimit } = args
 const next = await call({ ...withoutLimit, cursor: first.nextCursor })
 assert.equal(next.tasks[0].id, large.tasks[1].id)
 for (const fields of [{ limit: 2 }, { projectId: p.id }, { detail: 'record' }]) {
  await assert.rejects(tool.execute({ ...withoutLimit, cursor: first.nextCursor, ...fields }, exec), /cursor.*match/)
 }
 const list = await call({ action: 'list', workspace, limit: 1 })
 await assert.rejects(tool.execute({ action: 'list', workspace: other, limit: 1, cursor: list.nextCursor }, exec), /cursor.*match/)
 const changed = todos(1000); changed[5].status = 'completed'
 const mirror = await captureTodoProject(workspace, { sessionId: 'scale-1000', callId: 'two', turn: 1 }, changed)
 assert.equal(mirror.revision, large.revision)
 await assert.rejects(tool.execute({ ...args, cursor: first.nextCursor }, exec), /snapshot changed/)
 large = mirror
})
await test('expired and evicted cursors fail explicitly; retries before expiry are stable', async () => {
 let now = 1000
 const output = new ProjectOutput(() => now)
 const first = output.project(large, 'get', {}, { detail: 'tasks', limit: 1 })
 const view = { detail: 'tasks', cursor: first.nextCursor }
 assert.equal(output.project(large, 'get', {}, view).tasks[0].id, large.tasks[1].id)
 now += 30 * 60_000
 assert.throws(() => output.project(large, 'get', {}, view), /expired|unknown/)
 const old = output.project(large, 'get', {}, { detail: 'tasks', limit: 1 }).nextCursor
 for (let i = 0; i < 129; i++) output.project(large, 'get', {}, { detail: 'tasks', limit: 1 })
 assert.throws(() => output.project(large, 'get', {}, { detail: 'tasks', cursor: old }), /expired|unknown/)
})
await test('one batch linked twice counts as two links and one batch, retaining full evidence', async () => {
 const store = storeFor(workspace), before = putBlob(store, Buffer.from('before\n')), after = putBlob(store, Buffer.from('after\n'))
 const batch = recordBatch(store, { kind: 'edit', reason: 'immutable evidence '.repeat(1200), actor: 'test',
  nodes: [{ file: 'a.txt', op: 'update', before: before.id, after: after.id, bytes: 6, eol: 'LF', bom: false }] })
 for (const task of p.tasks.slice(0, 2)) {
  await call({ action: 'link', projectId: p.id, revision: p.revision, taskId: task.id, batchId: batch.id })
  p = getProject(workspace, p.id)
 }
 assert.equal((await call({ action: 'get', projectId: p.id })).project.links, 2)
 const overview = await call({ action: 'overview', projectId: p.id })
 assert.equal(overview.overview.batches, 1); assert.equal(overview.overview.files, 1)
 assert.equal(overview.overview.lineChanges.added, 1); assert.equal(overview.overview.lineChanges.deleted, 1)
 for (let i = 0; i < 10; i++) {
  const result = await call({ action: 'report', projectId: p.id, revision: p.revision, status: 'draft', conclusion: '结论😀'.repeat(3000), issues: ['Issue '.repeat(1000)] })
  assert.deepEqual(result.report.truncated, ['conclusion']); assert.equal(result.report.evidence.batches, 1)
  assert.ok(JSON.stringify(result).length < 1600)
  p = getProject(workspace, p.id)
  const summary = await call({ action: 'get', projectId: p.id })
  assert.equal(summary.project.reports, i + 1); assert.ok(JSON.stringify(summary).length < 1000)
 }
 frozen = p.reports[0]; frozenEvidence = frozen.evidence
 assert.equal(frozenEvidence.batches[0].taskIds.length, 2)
})
await test('report and frozen evidence fragments reconstruct exactly despite later live changes', async () => {
 const report = await record({ projectId: p.id, reportId: frozen.id }, async () => {
  await call({ action: 'task_update', projectId: p.id, revision: p.revision, taskId: p.tasks[1].id, note: 'later change' })
  p = getProject(workspace, p.id); writeFileSync(path.join(workspace, 'a.txt'), 'drift\n')
 })
 assert.ok(report.count > 1); assert.deepEqual(report.value, frozen)
 const evidence = await record({ projectId: p.id, reportId: frozen.id, detail: 'evidence' })
 assert.ok(evidence.count > 1); assert.deepEqual(evidence.value, frozenEvidence)
 const all = await pages({ action: 'get', projectId: p.id, detail: 'reports', limit: 3 }, 'reports')
 assert.deepEqual(all.map(r => r.id), [...p.reports].reverse().map(r => r.id))
 const full = await record({ projectId: p.id })
 assert.deepEqual(full.value, p, 'full storage record remains available')
})
await test('record cursors reject live changes and old reports expose missing evidence explicitly', async () => {
 const first = await call({ action: 'get', projectId: p.id, detail: 'record' })
 await call({ action: 'update', projectId: p.id, revision: p.revision, name: 'Changed' }); p = getProject(workspace, p.id)
 await assert.rejects(tool.execute({ action: 'get', projectId: p.id, detail: 'record', cursor: first.nextCursor }, exec), /snapshot changed/)
 const legacy = structuredClone(p); delete legacy.reports[0].evidence
 const output = new ProjectOutput()
 assert.deepEqual(output.project(legacy, 'get', {}, { detail: 'evidence', reportId: frozen.id }), { projectId: p.id, reportId: frozen.id, available: false })
})
await test('cross-workspace lists paginate all projects and empty results finish explicitly', async () => {
 await projectAction({ action: 'create', workspace: other, name: 'Foreign' })
 const all = await pages({ action: 'list', limit: 1 }, 'projects')
 assert.deepEqual(all.map(p => p.id), listProjects().map(p => p.id))
 assert.ok(all.every(p => p.workspace))
 assert.deepEqual(await pages({ action: 'list', query: 'does-not-exist', limit: 1 }, 'projects'), [])
})
await test('SDK hygiene preserves empty notes and report issue lists', async () => {
 await call({ action: 'task_update', projectId: p.id, revision: p.revision, taskId: p.tasks[0].id, note: '' })
 p = getProject(workspace, p.id); assert.equal(p.tasks[0].note, '')
 await call({ action: 'report', projectId: p.id, revision: p.revision, status: 'draft', conclusion: 'No issues', issues: [] })
 p = getProject(workspace, p.id); assert.deepEqual(p.reports.at(-1).issues, [])
 assert.equal(p.reports.at(-1).submittedBy, 'output-test')
})
console.log(`${passed} project output contracts passed, 0 failed`)
} finally { rmSync(temp, { recursive: true, force: true }) }
