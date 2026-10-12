/** Project behavior, restart, concurrency, failure and actual SDK contracts. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'
import { createProjectTool } from '../lib/tools-project.js'
import { FinderPool } from '../lib/core.js'
import { createEditTool, createResolveTool, createRollbackTool, createHistoryTool } from '../lib/tools-edit.js'
import { storeFor, readLedgerTail } from '../lib/ledger.js'
import { createDiffTool } from '../lib/tools-history.js'
import { loadTicket } from '../lib/tickets.js'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'

const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'forge-projects-'))
const workspace = path.join(sandbox, 'workspace')
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
process.env.DSH_FORGE_DATA_DIR = path.join(sandbox, 'data')
const exec = actor => ({ agent: { session: { header: { cwd: workspace, id: actor } } }, token: {} })
const pool = new FinderPool()
const tool = createProjectTool(), edit = createEditTool(pool), resolve = createResolveTool(pool), rollback = createRollbackTool(pool)
const ctx = exec('session-a'), ctxB = exec('session-b')
const call = args => tool.execute(args, ctx)
const store = storeFor(workspace)
let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)
async function main() {
  const sdk = defineTool(tool)
  const runtime = Object.create(ToolRuntime.prototype)
  runtime.canonicalResults = new WeakMap(); runtime.concludingExecutions = new WeakSet()
  const createArgs = { action: 'create', name: 'Project A', root: 'src', reason: 'start' }
  const created = await sdk.execute(createArgs, ctx)
  runtime.createSuccessResult(ctx, sdk, created)
  let project = created.projects[0]
  const id = project.id
  assert.equal(project.revision, 1)
  assert.equal(project.createdBy, 'session-a')
  ok('actual SDK accepts project schema, nullable state and content rendering')
  assert.match((await call(createArgs)).error, /already exists/)
  assert.match((await call({ ...createArgs, root: '..', name: 'outside' })).error, /inside/)
  assert.match((await call({ action: 'create', name: 'missing reason' })).error, /reason/)
  ok('duplicate and out-of-workspace roots fail without project creation')

  project = (await call({ action: 'todos', projectId: id, revision: 1, todos: [{ content: 'implement', note: 'persistent' }, { content: 'verify', status: 'blocked' }], reason: 'plan' })).projects[0]
  const todoId = project.todos[0].id
  assert.equal(project.todos[1].status, 'blocked')
  const changes = await Promise.all([ctx, ctxB].map((context, i) => tool.execute({ action: 'todos', projectId: id, revision: 2,
    todos: [{ id: todoId, status: 'in_progress', note: `writer ${i}` }], reason: 'claim' }, context)))
  assert.equal(changes.filter(result => result.error).length, 1)
  assert.match(changes.find(result => result.error).error, /revision changed/)
  project = (await tool.execute({ action: 'get', projectId: id }, ctxB)).projects[0]
  assert.equal(project.todos[0].id, todoId)
  assert.equal(project.todos[0].status, 'in_progress')
  ok('stable task IDs, blocked state and concurrent stale revisions reject overwrites')

  const f = path.join(workspace, 'src/a.js')
  fs.writeFileSync(f, 'function A() {}\n')
  const edited = await edit.execute({ path: 'src/a.js', projectId: id, todoId, steps: [{ start: 1, text: 'function B() {}' }], reason: 'implement' }, ctxB)
  assert.equal(edited.status, 'applied')
  let linked = readLedgerTail(store).find(batch => batch.id === edited.batch)
  assert.equal(linked.projectId, id); assert.equal(linked.todoId, todoId); assert.equal(linked.actor, 'session-b')
  assert.equal((await createHistoryTool().execute({ projectId: id, todoId }, ctx)).items.length, 1)
  ok('edit links project/task/actor in the file commit itself, and history filters links')
  assert.match((await edit.execute({ path: '../escape.js', projectId: id, steps: [{ after: 0, text: 'no' }], reason: 'escape' }, ctx)).error, /outside/)
  assert.match((await edit.execute({ path: 'src/a.js', projectId: id, todoId: 'missing', steps: [{ start: 1, text: 'no' }], reason: 'invalid' }, ctx)).error, /todo/)
  assert.equal(fs.readFileSync(f, 'utf8'), 'function B() {}\n')
  ok('project file containment and task identity reject invalid associations before writes')

  // Revisions are independent from file batch ids; metadata never consumes last-file rollback.
  project = (await call({ action: 'get', projectId: id })).projects[0]
  project = (await call({ action: 'todos', projectId: id, revision: project.revision, todos: [{ id: todoId, status: 'completed' }], reason: 'done' })).projects[0]
  const undone = await rollback.execute({ batch: 'last', dryRun: false, reason: 'undo' }, ctx)
  assert.equal(undone.revertedBatch, edited.batch)
  assert.equal(fs.readFileSync(f, 'utf8'), 'function A() {}\n')
  linked = readLedgerTail(store).find(batch => batch.id === undone.newBatch)
  assert.equal(linked.projectId, id); assert.equal(linked.todoId, todoId)
  project = (await call({ action: 'get', projectId: id })).projects[0]
  assert.match((await call({ action: 'todos', projectId: id, revision: project.revision, todos: [{ id: todoId, remove: true }], reason: 'remove' })).error, /referenced/)
  ok('metadata revisions do not hijack last rollback; rollback retains task link and protects referenced IDs')

  const ambiguous = path.join(workspace, 'src/ambiguous.txt')
  fs.writeFileSync(ambiguous, 'same\nsame\n')
  const ticket = await edit.execute({ path: 'src/ambiguous.txt', projectId: id, todoId, steps: [{ find: 'same', replaceWith: 'changed' }], reason: 'ticket' }, ctx)
  assert.equal(ticket.status, 'ticket')
  assert.equal(loadTicket(ticket.ticket).projectId, id)
  await call({ action: 'delete', projectId: id, reason: 'archive' })
  assert.match((await resolve.execute({ ticket: ticket.ticket, choice: 0 }, ctxB)).error, /deleted/)
  assert.equal(fs.readFileSync(ambiguous, 'utf8'), 'same\nsame\n')
  project = (await call({ action: 'restore', projectId: id, reason: 'continue' })).projects[0]
  const resolved = await resolve.execute({ ticket: ticket.ticket, choice: 1 }, ctxB)
  assert.equal(resolved.status, 'applied')
  assert.equal(readLedgerTail(store).at(-1).todoId, todoId)
  project = (await call({ action: 'get', projectId: id })).projects[0]
  ok('tickets retain project/task across sessions and refuse deleted projects until restored')

  const report = await call({ action: 'report', projectId: id, revision: project.revision, conclusion: 'completed core', status: 'review', reason: 'review' })
  runtime.createSuccessResult(ctx, sdk, report)
  assert.ok(report.projects[0].report.content.includes('session-b'))
  assert.ok(report.projects[0].report.content.includes('src/a.js'))
  assert.ok(report.projects[0].report.throughBatch < readLedgerTail(store).at(-1).id)
  ok('report freezes task/files/participants at a named ledger boundary')

  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createProjectTool} from ${JSON.stringify(pathToFileURL(path.resolve('lib/tools-project.js')).href)}; const result=await createProjectTool().execute({action:'get',projectId:${JSON.stringify(id)}},${JSON.stringify(ctxB)}); console.log(JSON.stringify(result))`],
    { encoding: 'utf8', env: process.env, windowsHide: true })
  assert.equal(restarted.status, 0, restarted.stderr)
  assert.deepEqual(JSON.parse(restarted.stdout).projects[0], report.projects[0])
  ok('fresh process recovers exact project/task/report state from durable ledger')

  const flush = fs.fsyncSync
  let inject = true
  const before = fs.readFileSync(store.ledgerFile)
  fs.fsyncSync = function(fd) { if (inject && fs.fstatSync(fd).ino === fs.statSync(store.ledgerFile).ino) { inject = false; throw Error('project commit injected failure') } return flush(fd) }
  syncBuiltinESMExports()
  try { assert.match((await call({ action: 'delete', projectId: id, reason: 'fail' })).error, /injected/) }
  finally { fs.fsyncSync = flush; syncBuiltinESMExports() }
  assert.deepEqual(fs.readFileSync(store.ledgerFile), before)
  assert.equal((await call({ action: 'get', projectId: id })).projects[0].deletedAt, null)
  ok('metadata storage failure leaves durable and visible state unchanged')

  const definitions = [], disposers = []
  for (const disposable of apply({ fs: { sandboxMode: 'workspace-write' },
    tools: { register(def) { definitions.push(def) } }, commands: { register() {} } })) {
    if (typeof disposable === 'function') disposers.push(disposable)
  }
  await assert.rejects(() => definitions.find(def => def.name === 'ff_project').execute({ action: 'list' }, ctx), /shared-local DSH filesystem provider/)
  disposers.forEach(dispose => dispose())
  ok('host rejects a provider without native mapping capabilities; real sandbox integration is tested separately')
  assert.equal((await call({ action: 'search', query: 'project a' })).projects.length, 1)
  assert.equal((await call({ action: 'list_workspaces' })).workspaces.includes(workspace), true)
  ok('project search and workspace discovery are available through the SDK tool')

  const duplicate = (await call({ action: 'create', name: 'restore conflict', reason: 'create' })).projects[0]
  await call({ action: 'delete', projectId: duplicate.id, reason: 'delete' })
  await call({ action: 'create', name: 'restore conflict', reason: 'replace' })
  assert.match((await call({ action: 'restore', projectId: duplicate.id, reason: 'restore' })).error, /another active project/)
  assert.notEqual((await call({ action: 'get', projectId: duplicate.id, includeDeleted: true })).projects[0].deletedAt, null)
  ok('restore enforces the same active root/name uniqueness as creation')

  const diff = createDiffTool()
  const immutable = await diff.execute({ batch: edited.batch, projectId: id }, ctx)
  assert.equal(immutable.items[0].node, `b${edited.batch}:n0`)
  assert.ok(immutable.items[0].diff.includes('-function A() {}'))
  assert.ok(immutable.items[0].diff.includes('+function B() {}'))
  fs.writeFileSync(f, 'external bytes\n')
  assert.deepEqual(await diff.execute({ node: `b${edited.batch}:n0`, projectId: id }, ctx), immutable)
  const diffSdk = defineTool(diff)
  runtime.createSuccessResult(ctx, diffSdk, immutable)
  assert.match((await diff.execute({ batch: edited.batch, node: `b${edited.batch}:n0` }, ctx)).error, /exactly one/)
  assert.match((await diff.execute({ batch: edited.batch, projectId: duplicate.id }, ctx)).error, /does not belong/)
  const contentMatches = await createHistoryTool().execute({ projectId: id, content: 'function B', limit: 100 }, ctx)
  assert.ok(contentMatches.items.some(item => item.batch === edited.batch))
  ok('persistent node diffs and snapshot content search ignore later disk bytes and validate SDK output')

  let current = (await call({ action: 'get', projectId: id })).projects[0]
  assert.match((await call({ action: 'report', projectId: id, revision: current.revision, status: 'accepted', conclusion: 'done', reason: 'accept' })).error, /all project tasks/)
  current = (await call({ action: 'todos', projectId: id, revision: current.revision,
    todos: [{ id: current.todos[1].id, status: 'completed' }], reason: 'finish' })).projects[0]
  current = (await call({ action: 'report', projectId: id, revision: current.revision, status: 'accepted', conclusion: 'done', reason: 'accept' })).projects[0]
  assert.equal(current.status, 'accepted')
  const revisionBefore = current.revision
  const extra = await edit.execute({ path: 'src/a.js', projectId: id, todoId, steps: [{ start: 1, text: 'function C() {}' }], reason: 'continue' }, ctx)
  current = (await call({ action: 'get', projectId: id })).projects[0]
  assert.equal(current.status, 'active'); assert.ok(current.revision > revisionBefore)
  assert.equal(current.report.conclusion, 'done')
  assert.match((await call({ action: 'report', projectId: id, revision: revisionBefore, conclusion: 'stale', reason: 'report' })).error, /revision changed/)
  const nodeRollback = await rollback.execute({ batch: String(extra.batch), node: `b${extra.batch}:n0`, reason: 'node undo', dryRun: false }, ctx)
  assert.equal(nodeRollback.status, 'applied'); assert.equal(fs.readFileSync(f, 'utf8'), 'external bytes\n')
  ok('acceptance requires completed tasks, later writes invalidate acceptance, and node rollback restores exact before bytes')

  const sealedLedger = fs.readFileSync(store.ledgerFile)
  const records = sealedLedger.toString().trimEnd().split('\n')
  const lastProjectIndex = records.findLastIndex(line => JSON.parse(line).kind === 'project')
  const corruptVariants = [
    records.map((line, index) => index === lastProjectIndex ? line.slice(0, -10) : line).join('\n') + '\n',
    records.slice(0, lastProjectIndex).concat(records[lastProjectIndex].slice(0, -10)).join('\n'),
    '{"t":"b","id":1',
  ]
  for (const corrupt of corruptVariants) {
    fs.writeFileSync(store.ledgerFile, corrupt)
    assert.match((await call({ action: 'get', projectId: id })).error, /corrupt|invalid/)
    assert.match((await call({ action: 'todos', projectId: id, revision: 1, todos: [{ content: 'overwrite' }], reason: 'refused' })).error, /corrupt|invalid/)
    assert.match((await call({ action: 'create', name: 'new after corruption', reason: 'refused' })).error, /corrupt|invalid/)
    assert.equal(fs.readFileSync(store.ledgerFile, 'utf8'), corrupt)
  }
  fs.writeFileSync(store.ledgerFile, sealedLedger)
  const readFile = fs.readFileSync
  fs.readFileSync = function(target, ...rest) { if (target === store.ledgerFile) throw Error('ledger read denied'); return readFile(target, ...rest) }
  syncBuiltinESMExports()
  try { assert.match((await call({ action: 'get', projectId: id })).error, /read denied/) }
  finally { fs.readFileSync = readFile; syncBuiltinESMExports() }
  ok('corrupt complete lines, project tails, first revisions and unreadable ledgers fail closed without replacing evidence')

  const deniedRoot = path.join(sandbox, 'denied'); fs.mkdirSync(deniedRoot)
  const deniedFile = path.join(deniedRoot, 'target.txt'); fs.writeFileSync(deniedFile, 'same\nsame\n')
  const deniedExec = { agent: { session: { header: { cwd: deniedRoot, id: 'other-world' } } } }
  const deniedTicket = await edit.execute({ path: deniedFile, steps: [{ find: 'same', replaceWith: 'changed' }], reason: 'persisted ticket' }, deniedExec)
  assert.equal(deniedTicket.status, 'ticket')
  const restrictedTools = [], restrictedDisposers = [], checkedPaths = []
  const restrictedProvider = {
    processPathFromHostPath(file) { return file.startsWith(workspace) ? file : undefined },
    processPath(target) { return target.targetKey },
    async resolve(file) { checkedPaths.push(file); if (!file.startsWith(workspace)) throw Error('provider denied target'); return { targetKey: file, displayPath: file } },
  }
  for (const disposable of apply({ fs: restrictedProvider,
    tools: { register(def) { restrictedTools.push(def) } }, commands: { register() {} } })) {
    if (typeof disposable === 'function') restrictedDisposers.push(disposable)
  }
  try {
    await assert.rejects(() => restrictedTools.find(def => def.name === 'ffresolve').execute({ ticket: deniedTicket.ticket, choice: 0 }, ctx), /provider denied/)
    await assert.rejects(() => restrictedTools.find(def => def.name === 'ffedit').execute({ path: deniedFile, steps: [{ start: 1, text: 'changed' }], reason: 'direct' }, ctx), /provider denied/)
    assert.ok(checkedPaths.includes(deniedRoot)); assert.ok(checkedPaths.includes(deniedFile))
    assert.equal(fs.readFileSync(deniedFile, 'utf8'), 'same\nsame\n')
    assert.ok(!('error' in loadTicket(deniedTicket.ticket)))
  } finally { restrictedDisposers.forEach(dispose => dispose()) }
  ok('host validates actual direct and persisted ticket targets against provider and preserves denied tickets/files')
  console.log(`${passed} project groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { pool.disposeAll(); fs.rmSync(sandbox, { recursive: true, force: true }) })
