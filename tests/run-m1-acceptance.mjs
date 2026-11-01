/** Regression gates for the reproduced M1 evidence and attribution defects. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-m1-acceptance-'))
process.env.DSH_FORGE_DATA_DIR = path.join(temporary, 'data')
process.env.DSH_FORGE_AST_WORKERS = '0'
process.env.DSH_FORGE_INDEXER = 'off'

const { createEditTool, createHistoryTool } = await import('../lib/tools-edit.js')
const { createFileTool } = await import('../lib/tools-files.js')
const { runStaticCheck } = await import('../lib/check-static.js')
const { assembleTraceGraph, createTraceTool, resetTraceFactsCache, resetTraceSnapshots } = await import('../lib/tools-trace.js')
const { loadBaseline } = await import('../lib/trace-capture.js')
const { diffWorkspaceBridges } = await import('../lib/bridge-scan.js')
const { applicabilityOf, listRecords, aggregateChecks, appendRecord, readRevision } = await import('../lib/verification.js')
const { storeFor } = await import('../lib/ledger.js')

after(() => {
  resetTraceFactsCache()
  resetTraceSnapshots()
  const parent = path.resolve(os.tmpdir())
  assert.equal(path.dirname(path.resolve(temporary)), parent)
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function workspace(files = {}) {
  const root = fs.mkdtempSync(path.join(temporary, 'workspace-'))
  const put = (file, bytes) => {
    const absolute = path.join(root, file)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, bytes)
  }
  for (const [file, bytes] of Object.entries(files)) put(file, bytes)
  const exec = { agent: { session: { header: { cwd: root, id: 'm1-acceptance' } } }, token: {} }
  const editTool = createEditTool({ peekMain: () => undefined })
  return {
    root, put, exec,
    absolute: file => path.join(root, file),
    async edit(file, find, replaceWith) {
      const result = await editTool.execute({ path: file, find, replaceWith, reason: 'M1 regression' }, exec)
      assert.equal(result.status, 'applied', result.error ?? result.text)
      return result.batch
    },
    async remove(file) {
      const result = await createFileTool().execute({ action: 'remove', path: file, reason: 'M1 regression' }, exec)
      assert.equal(typeof result.batch, 'number', JSON.stringify(result))
      return result.batch
    },
    // The engine ffedit{verify} calls; ffcheck itself was retired.
    async check(batch, checks = ['bridge', 'syntax']) {
      const result = await runStaticCheck({ checks, batches: [batch] }, exec)
      assert.ok(!('error' in result), result.error)
      return result
    },
    record(id) {
      const found = listRecords(storeFor(root)).records.find(record => record.id === id)
      assert.ok(found, `missing archived record ${id}`)
      return found
    },
  }
}

const PRELOAD = "const { contextBridge } = require('electron')\ncontextBridge.exposeInMainWorld('api', { ping() {} })\n"

test('1: failed UTF-8 decoding cannot persist a content baseline', async () => {
  const ws = workspace({ 'good.js': 'const x = 1\n', 'bad.js': Buffer.from([0xff, 0xfe, 0xff]) })
  const capture = await assembleTraceGraph(ws.root, { capture: true })
  assert.equal(capture.parseErrors, 1)
  assert.equal(capture.snapshot.strength, 'observed')
  assert.equal(capture.capture.persisted, false)
  assert.equal(loadBaseline(ws.root, capture.snapshot.snapshotId).ok, false)
})

test('2: identical alias names in separate functions bind to separate providers', async () => {
  const ws = workspace({
    'preload.js': "contextBridge.exposeInMainWorld('apiA', { foo() {} }); contextBridge.exposeInMainWorld('apiB', { foo() {} })\n",
    'renderer.js': 'function a() { const api = window.apiA; api.foo() }\nfunction b() { const api = window.apiB; api.foo() }\n',
  })
  const before = await assembleTraceGraph(ws.root, { capture: true })
  ws.put('preload.js', "contextBridge.exposeInMainWorld('apiA', { bar() {} }); contextBridge.exposeInMainWorld('apiB', { foo() {} })\n")
  const { result, after: current } = await diffWorkspaceBridges({ workspace: ws.root, before, capture: true, checks: ['bridge'] })
  assert.equal(current.graph.bridgeByObject.get('apiA')?.length, 1)
  assert.equal(current.graph.bridgeByObject.get('apiB')?.length, 1)
  assert.equal(result.status, 'failed', result.verdict)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].expected.object, 'apiA')
  assert.equal(result.findings[0].consumer.symbol, 'a')
})

test('3: removing a provider through the ledger keeps its before facts', async () => {
  const ws = workspace({ 'preload.js': PRELOAD, 'renderer.js': 'window.api.ping()\n' })
  const batch = await ws.remove('preload.js')
  const result = await ws.check(batch, ['bridge'])
  assert.equal(result.status, 'failed', result.text)
  assert.ok(result.findings.some(f => f.kind === 'expose_global_missing' && f.attribution === 'new'))
})

test('4: deleting the sole source cannot archive syntax passed with zero checks', async () => {
  const ws = workspace({ 'only.js': 'const x = 1\n' })
  const batch = await ws.remove('only.js')
  const result = await ws.check(batch, ['syntax'])
  assert.equal(result.syntax.checked, 0)
  assert.equal(result.status, 'not_run')
  const record = ws.record(result.verification.id)
  assert.equal(record.checks[0].status, 'not_run')
  assert.notEqual(aggregateChecks(record.requiredChecks, record.checks, record.provenance).status, 'passed')
})

test('5: a consumer edited after provider verification invalidates the record', async () => {
  const ws = workspace({ 'preload.js': PRELOAD, 'renderer.js': 'window.api.ping()\n' })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const result = await ws.check(batch)
  assert.equal(result.status, 'passed', result.text)
  const record = ws.record(result.verification.id)
  ws.put('renderer.js', 'window.api.missing()\n')
  const now = applicabilityOf(record, ws.root)
  assert.equal(now.applicable, false)
  assert.equal(now.effective, 'stale')
  assert.ok(now.drifted.includes('renderer.js'))
})

test('14: consumed project metadata is part of verification applicability', async () => {
  const ws = workspace({ 'package.json': '{"type":"module"}', 'preload.js': PRELOAD, 'renderer.js': 'window.api.ping()\n' })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const checked = await ws.check(batch)
  assert.equal(checked.status, 'passed')
  ws.put('package.json', '{"type":"commonjs"}')
  const now = applicabilityOf(ws.record(checked.verification.id), ws.root)
  assert.equal(now.effective, 'stale')
  assert.ok(now.drifted.includes('package.json'))
})

test('18: legacy records keep their historical verdict but require a fresh check', async () => {
  const ws = workspace({ 'only.js': 'const x = 1\n' })
  const batch = await ws.edit('only.js', '1', '2')
  const checked = await ws.check(batch, ['syntax'])
  const record = ws.record(checked.verification.id)
  delete record.schema
  const file = path.join(storeFor(ws.root).dir, 'verification', `${record.id}.json`)
  fs.writeFileSync(file, JSON.stringify(record))
  const legacy = ws.record(record.id)
  const now = applicabilityOf(legacy, ws.root)
  assert.equal(now.verdict.status, 'passed')
  assert.equal(now.applicable, false)
  assert.equal(now.effective, 'stale')
  assert.equal(now.reason, 'evidence_schema')
  assert.equal(listRecords(storeFor(ws.root)).unreadable, 0)
})

test('21: an existing verification ID cannot be overwritten or removed', async () => {
  const ws = workspace({ 'only.js': 'const x = 1\n' })
  const batch = await ws.edit('only.js', '1', '2')
  const checked = await ws.check(batch, ['syntax'])
  const record = ws.record(checked.verification.id)
  const store = storeFor(ws.root)
  const file = path.join(store.dir, 'verification', `${record.id}.json`)
  const original = fs.readFileSync(file)
  const revision = readRevision(store).revision
  record.checks[0].status = 'failed'
  const appended = await appendRecord(store, ws.root, record)
  assert.equal(appended.ok, false)
  assert.deepEqual(fs.readFileSync(file), original)
  assert.equal(readRevision(store).revision, revision)
})

test('22: lexical shadowing, reassignment and alias chains stay isolated', async t => {
  const providers = "contextBridge.exposeInMainWorld('api', { ping() {} }); contextBridge.exposeInMainWorld('other', { ping() {} })\n"
  const cases = [
    ['block shadow', 'const alias=window.api; { const alias={ping(){}}; alias.ping() } alias.ping()'],
    ['alias chain', 'const base=window.api; const alias=base; alias.ping()'],
    ['qualified global ignores a colliding alias', 'const api=window.other; window.api.ping(); api.ping()'],
    ['unrelated reassignment', 'function a(){let alias=window.other;alias=other;alias.ping()} function b(){const alias=window.api;alias.ping()}'],
    ['parameter shadow', 'const api=window.api; function local(api){api.ping()} api.ping()'],
  ]
  for (const [name, source] of cases) await t.test(name, async () => {
    const ws = workspace({ 'preload.js': providers, 'renderer.js': `${source}\n` })
    const before = await assembleTraceGraph(ws.root, { capture: true })
    ws.put('preload.js', providers.replace("'api', { ping() {} }", "'api', { pong() {} }"))
    const { result } = await diffWorkspaceBridges({ workspace: ws.root, before, capture: true, checks: ['bridge'] })
    assert.equal(result.status, 'failed', result.verdict)
    assert.equal(result.findings.length, 1, JSON.stringify(result.findings))
    assert.equal(result.findings[0].expected.object, 'api')
  })
})

test('26: Trace displays an uncertain fallback site while formal verification stays partial', async () => {
  const ws = workspace({ 'preload.js': PRELOAD, 'renderer.js': 'const alias = window.api || window.other; alias.ping()\n' })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const graph = await assembleTraceGraph(ws.root, { capture: true })
  assert.equal(graph.graph.unboundBridge.length, 1)
  assert.equal(graph.graph.bridgeByObject.get('api')?.length ?? 0, 0)
  const trace = await createTraceTool().execute({ target: 'file:renderer.js' }, ws.exec)
  assert.equal(trace.incomplete, true)
  assert.match(trace.text, /绑定未确定的桥接站点/)
  assert.match(trace.text, /alias\.ping/)
  const page = await createTraceTool().execute({ target: 'exposes:api', limit: 1 }, ws.exec)
  assert.equal(page.incomplete, true)
  assert.equal(page.page.resultComplete, false)
  assert.ok(page.page.limitations.some(item => item.reason === 'unknown_binding'))
  assert.match(page.text, /结果：⚠️ 不完整（见口径）/)
  const checked = await ws.check(batch)
  assert.equal(checked.status, 'partial', checked.text)
  assert.ok(checked.limitations.some(item => item.code === 'unknown_binding'))
})

test('29: unrelated uncertain locals cannot make a clean bridge query incomplete', async () => {
  const ws = workspace({
    'preload.js': "contextBridge.exposeInMainWorld('knownAPI', { ping() {} })\n",
    'elsewhere.js': 'const item=window.knownAPI;const local=window.knownAPI\n',
    'renderer.js': 'function ordinary(item){item.value;item.run()} function shadow(knownAPI){knownAPI.ping()} let local={run(){}};local={run(){}};local.run();window.knownAPI.ping()\n',
  })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const checked = await ws.check(batch)
  assert.equal(checked.status, 'passed', checked.text)
  const traced = await createTraceTool().execute({target:'exposes:knownAPI',limit:1}, ws.exec)
  assert.equal(traced.incomplete, false, traced.text)
  assert.equal(traced.page.resultComplete, true)
  assert.ok(!traced.page.limitations.some(item => item.reason === 'unknown_binding'))
  assert.ok(!traced.text.includes('item.value') && !traced.text.includes('local.run'))
})

test('30: assigning a bridge to an initially local value remains unknown', async () => {
  const ws = workspace({
    'preload.js': "contextBridge.exposeInMainWorld('knownAPI', { ping() {} })\n",
    'renderer.js': 'let dynamic={ping(){}};dynamic=window.knownAPI;dynamic.ping()\n',
  })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const checked = await ws.check(batch)
  assert.equal(checked.status, 'partial', checked.text)
  assert.ok(checked.limitations.some(item => item.code === 'unknown_binding'))
  const graph = (await assembleTraceGraph(ws.root)).graph
  assert.ok(graph.unboundBridge.some(ref => ref.path === 'renderer.js' && ref.object === 'dynamic'))
})

test('31: self references and created objects or functions do not acquire a bridge identity', async () => {
  const ws = workspace({
    'preload.js': "contextBridge.exposeInMainWorld('knownAPI', { ping() {} })\n",
    'elsewhere.js': 'const curr=window.knownAPI;const holder=window.knownAPI;const factory=window.knownAPI\n',
    'renderer.js': 'let curr={ping(){}};curr=curr;curr.ping();const holder={bridge:window.knownAPI,ping(){}};holder.ping();const factory=()=>window.knownAPI;factory.name;window.knownAPI.ping()\n',
  })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const checked = await ws.check(batch)
  assert.equal(checked.status, 'passed', checked.text)
  const assembled = await assembleTraceGraph(ws.root)
  assert.equal(assembled.graph.unboundBridge.length, 0)
  assert.equal(assembled.graph.bridgeByObject.get('knownAPI').length, 1)
})

test('32: a bridge alias chain beyond the binding budget remains unknown', async () => {
  const aliases = ['const alias0=window.knownAPI', ...Array.from({length:9}, (_, index) => `const alias${index + 1}=alias${index}`), 'alias9.ping()'].join(';')
  const ws = workspace({
    'preload.js': "contextBridge.exposeInMainWorld('knownAPI', { ping() {} })\n",
    'renderer.js': `${aliases}\n`,
  })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const checked = await ws.check(batch)
  assert.equal(checked.status, 'partial', checked.text)
  assert.ok(checked.limitations.some(item => item.code === 'unknown_binding'))
})
