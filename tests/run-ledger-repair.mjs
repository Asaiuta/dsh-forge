import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(path.join(fileURLToPath(new URL('..', import.meta.url)), '.tmp-ledger-repair-'))
process.env.DSH_FORGE_DATA_DIR = path.join(root, 'data')
const { storeFor, putBlob, recordBatch } = await import('../src/ledger.ts')
const { ledgerList } = await import('../src/ledger-api.ts')
const { createLedgerHandler, createProjectsHandler, apply } = await import('../src/http-plugin.ts')
let count = 0
async function test(name, run) { await run(); console.log(`ok ${++count} - ${name}`) }
const workspace = path.join(root, 'workspace')
mkdirSync(workspace)
const file = path.join(workspace, 'a.txt')
const store = storeFor(workspace)
function batch(reason = 'repair', actor = 'alice', kind = 'edit', filename = 'a.txt') {
  const before = putBlob(store, Buffer.from('before\n')).id
  const after = putBlob(store, Buffer.from('after\n')).id
  return recordBatch(store, { reason, actor, kind, nodes: [{ file: filename, op: 'update', before, after, bytes: 6, eol: 'LF', bom: false }] })
}
const guard = async exec => ({ ...exec, authorizeNativePaths: async () => {}, withNativeWrite: async (_files, op) => op() })
const handler = createLedgerHandler({ guard })
async function call(body, options = {}) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  request.method = body === undefined ? 'GET' : 'POST'
  request.url = options.url ?? '/forge-ledger'
  request.headers = { host: '127.0.0.1:20014', origin: 'http://127.0.0.1:20014', 'content-type': 'application/json', ...options.headers }
  request.socket = { localAddress: '127.0.0.1', localPort: 20014 }
  const out = {}
  await (options.handler ?? handler)(request, { writeHead(status) { out.status = status }, end(value) { out.body = JSON.parse(value) } })
  return out
}
const previewBody = () => ({ action: 'preview', workspace, selection: { batch: 1 }, reason: 'undo repair' })
try {
  batch('repair alpha'); batch('other', 'bob', 'external', 'b.txt'); batch('repair beta')
  writeFileSync(file, 'after\n')
  await test('legacy numeric list and composable filters', () => {
    assert.equal(ledgerList(workspace, 1).batches.length, 1)
    assert.equal(ledgerList(workspace, 1).total, 3)
    assert.equal(ledgerList(workspace, 1).returned, 1)
    const view = ledgerList(workspace, { keyword: 'REPAIR', pathContains: 'a.txt', actor: 'alice', kind: 'edit' })
    assert.deepEqual(view.batches.map(b => b.id), [3, 1])
  })
  await test('stable cursor excludes newly inserted batches', () => {
    const first = ledgerList(workspace, { limit: 1 })
    assert.equal(typeof first.nextCursor, 'string')
    batch('new')
    const second = ledgerList(workspace, { limit: 1, cursor: first.nextCursor })
    assert.deepEqual(second.batches.map(b => b.id), [2])
    assert.equal(first.total, 3)
    assert.equal(second.total, 3)
    assert.equal(first.returned, 1)
    assert.equal(second.returned, 1)
    const third = ledgerList(workspace, { limit: 1, cursor: second.nextCursor })
    assert.deepEqual(third.batches.map(b => b.id), [1])
    assert.equal(third.total, 3)
    assert.equal(third.nextCursor, undefined)
    assert.equal(ledgerList(workspace, 1).total, 4)
    const filtered = ledgerList(workspace, { limit: 1, keyword: 'repair' })
    assert.equal(filtered.total, 2)
    assert.equal(ledgerList(workspace, { limit: 1, keyword: 'repair', cursor: filtered.nextCursor }).total, 2)
    assert.throws(() => ledgerList(workspace, { limit: 1, cursor: first.nextCursor, actor: 'bob' }), /cursor/i)
    assert.throws(() => ledgerList(root, { limit: 1, cursor: first.nextCursor }), /cursor/i)
    assert.throws(() => ledgerList(workspace, { cursor: 'bogus' }), /cursor/i)
  })
  await test('HTTP GET passes filters and rejects invalid limits', async () => {
    const query = `/forge-ledger?workspace=${encodeURIComponent(workspace)}&actor=bob&kind=external`
    const reply = await call(undefined, { url: query })
    assert.equal(reply.status, 200); assert.deepEqual(reply.body.batches.map(b => b.id), [2])
    assert.equal((await call(undefined, { url: `${query}&limit=nope` })).status, 400)
  })
  await test('POST without a real host guard fails closed', async () => {
    assert.equal((await call(previewBody(), { handler: createLedgerHandler() })).status, 503)
  })
  await test('origin, host, JSON media type and reason are mandatory', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: undefined }, { host: 'evil.example' }, { 'content-type': 'text/plain' }]) {
      assert.equal((await call(previewBody(), { headers })).status, 400)
    }
    assert.equal((await call({ ...previewBody(), reason: '' })).status, 400)
  })
  await test('preview provides plan and token but does not alter file or ledger', async () => {
    const old = readFileSync(store.ledgerFile)
    const response = await call(previewBody())
    assert.equal(response.status, 200, response.body.error)
    assert.equal(response.body.preview.status, 'plan'); assert.equal(response.body.preview.dryRun, true)
    assert.equal(typeof response.body.token, 'string'); assert.equal(typeof response.body.expiresAt, 'string')
    assert.deepEqual(readFileSync(store.ledgerFile), old); assert.equal(readFileSync(file, 'utf8'), 'after\n')
  })
  await test('file drift rejects confirm without writing any bytes', async () => {
    const response = await call(previewBody())
    writeFileSync(file, 'external change\n')
    const old = readFileSync(store.ledgerFile)
    const confirmed = await call({ action: 'confirm', workspace, token: response.body.token, reason: 'undo repair' })
    assert.equal(confirmed.status, 409, confirmed.body.error)
    assert.equal(readFileSync(file, 'utf8'), 'external change\n'); assert.deepEqual(readFileSync(store.ledgerFile), old)
    writeFileSync(file, 'after\n')
  })
  await test('ledger drift and wrong workspace invalidate confirmation', async () => {
    let response = await call(previewBody())
    batch('concurrent')
    const old = readFileSync(store.ledgerFile)
    assert.equal((await call({ action: 'confirm', workspace, token: response.body.token, reason: 'undo repair' })).status, 409)
    assert.deepEqual(readFileSync(store.ledgerFile), old)
    response = await call(previewBody())
    assert.equal((await call({ action: 'confirm', workspace: root, token: response.body.token, reason: 'undo repair' })).status, 409)
  })
  await test('confirmation uses rollback pipeline and consumes token once', async () => {
    const response = await call(previewBody())
    const body = { action: 'confirm', workspace, token: response.body.token, reason: 'undo repair' }
    const confirmed = await call(body)
    assert.equal(confirmed.status, 200, confirmed.body.error); assert.equal(confirmed.body.result.status, 'applied')
    assert.equal(readFileSync(file, 'utf8'), 'before\n')
    assert.equal(ledgerList(workspace, 1).batches[0].kind, 'rollback')
    assert.equal((await call(body)).status, 409)
  })
  await test('guard-time races are revalidated inside actual mutation fence', async () => {
    writeFileSync(file, 'after\n')
    let race = false
    const racing = createLedgerHandler({ guard: async exec => ({ ...exec, authorizeNativePaths: async () => {}, withNativeWrite: async (_files, op) => { if (race) writeFileSync(file, 'racing\n'); return op() } }) })
    const response = await call(previewBody(), { handler: racing })
    race = true
    const old = readFileSync(store.ledgerFile)
    const confirmed = await call({ action: 'confirm', workspace, token: response.body.token, reason: 'undo repair' }, { handler: racing })
    assert.equal(confirmed.status, 409, confirmed.body.error)
    assert.equal(readFileSync(file, 'utf8'), 'racing\n'); assert.deepEqual(readFileSync(store.ledgerFile), old)
  })
  await test('preview never authorizes transaction recovery writes', async () => {
    const journal = path.join(store.dir, 'transaction.json')
    writeFileSync(journal, '{}')
    const old = readFileSync(store.ledgerFile)
    const response = await call(previewBody())
    assert.equal(response.status, 409, response.body.error)
    assert.deepEqual(readFileSync(store.ledgerFile), old); assert.equal(readFileSync(journal, 'utf8'), '{}')
    rmSync(journal)
  })
  await test('expired rollback tokens and malformed selectors are rejected', async () => {
    const expiring = createLedgerHandler({ guard, ttlMs: 1, now: () => clock })
    let clock = 1000
    const response = await call(previewBody(), { handler: expiring })
    clock = 1002
    assert.equal((await call({ action: 'confirm', workspace, token: response.body.token, reason: 'undo repair' }, { handler: expiring })).status, 409)
    for (const selection of [{ batch: '1' }, { batch: 1, latest: true }, { throughBatch: -1 }, { latest: true, node: 'b1:n0' }]) {
      assert.equal((await call({ ...previewBody(), selection })).status, 400)
    }
  })
  await test('project HTTP list/create/overview and revision conflict envelopes', async () => {
    const projects = createProjectsHandler()
    const url = `/forge-projects?workspace=${encodeURIComponent(workspace)}`
    let response = await call(undefined, { handler: projects, url })
    assert.equal(response.status, 200); assert.deepEqual(response.body.projects, [])
    response = await call({ action: 'create', workspace, name: 'HTTP project' }, { handler: projects })
    assert.equal(response.status, 200, response.body.error)
    const project = response.body.project
    assert.equal(project.revision, 1)
    response = await call(undefined, { handler: projects, url: `${url}&projectId=${project.id}` })
    assert.equal(response.status, 200); assert.equal(response.body.project.id, project.id); assert.equal(typeof response.body.overview, 'object')
    response = await call({ action: 'update', workspace, projectId: project.id, revision: 2, name: 'bad' }, { handler: projects })
    assert.equal(response.status, 409)
    assert.equal((await call({ action: 'create', workspace, name: '' }, { handler: projects })).status, 400)
    assert.equal((await call({ action: 'create', workspace, name: 'CSRF' }, { handler: projects, headers: { origin: 'http://evil.example' } })).status, 400)
  })
  await test('cursor expires and changed page size is rejected', () => {
    const first = ledgerList(workspace, { limit: 1 })
    assert.throws(() => ledgerList(workspace, { limit: 2, cursor: first.nextCursor }), /cursor/i)
    const realNow = Date.now
    try {
      const sampled = realNow()
      Date.now = () => sampled + 11 * 60_000
      assert.throws(() => ledgerList(workspace, { limit: 1, cursor: first.nextCursor }), /cursor/i)
    } finally { Date.now = realNow }
  })
  await test('mounted HTTP obtains real fs/policy services and honors read-only fence', async () => {
    let mode = 'read-only'
    let checks = 0
    const reads = []
    const routes = new Map()
    const provider = {
      sandboxMode: 'read-only',
      resolve: async file => ({ targetKey: file, displayPath: file }),
      processPath: target => target.displayPath,
      processPathFromHostPath: file => file,
      withLock: async (_key, operation) => operation(),
      checkedTarget: async (target, policy) => { checks++; if (policy.mode === 'read-only') throw new Error('sandbox denied read-only'); return target },
    }
    apply({
      configEditor: { entries: () => [] },
      get: name => { reads.push(name); return name === 'fs' ? provider : name === 'sandboxPolicy' ? { resolve: () => ({ mode, workspaceRoot: workspace }) } : undefined },
      webServer: { register: route => { routes.set(route.path, route.handler); return () => {} } },
      effect: setup => { for (const _dispose of setup()) {} },
    })
    assert.equal(routes.has('/forge-projects'), true)
    const mounted = routes.get('/forge-ledger')
    writeFileSync(file, 'after\n')
    let response = await call(previewBody(), { handler: mounted })
    assert.equal(response.status, 200, response.body.error)
    let confirmed = await call({ action: 'confirm', workspace, token: response.body.token, reason: 'undo repair' }, { handler: mounted })
    assert.equal(confirmed.status, 409); assert.equal(readFileSync(file, 'utf8'), 'after\n'); assert.ok(checks > 0)
    assert.ok(reads.includes('fs')); assert.ok(reads.includes('sandboxPolicy'))
    mode = 'workspace-write'
    response = await call(previewBody(), { handler: mounted })
    confirmed = await call({ action: 'confirm', workspace, token: response.body.token, reason: 'undo repair' }, { handler: mounted })
    assert.equal(confirmed.status, 200, confirmed.body.error); assert.equal(readFileSync(file, 'utf8'), 'before\n')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
  delete process.env.DSH_FORGE_DATA_DIR
}
console.log(`${count} checks passed`)
