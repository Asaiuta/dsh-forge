/** Regression gates for the reproduced M1 evidence and attribution defects. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, after } from 'node:test'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-m1-acceptance-'))
process.env.DSH_FORGE_DATA_DIR = path.join(temporary, 'data')
process.env.DSH_FORGE_AST_WORKERS = '0'
process.env.DSH_FORGE_INDEXER = 'off'

const { createEditTool, createHistoryTool } = await import('../lib/tools-edit.js')
const { createFileTool } = await import('../lib/tools-files.js')
const { createCheckTool } = await import('../lib/tools-check.js')
const { assembleTraceGraph, createTraceTool, resetTraceFactsCache, resetTraceSnapshots } = await import('../lib/tools-trace.js')
const { loadBaseline } = await import('../lib/trace-capture.js')
const { diffWorkspaceBridges } = await import('../lib/bridge-scan.js')
const { applicabilityOf, listRecords, aggregateChecks, appendRecord, readRevision } = await import('../lib/verification.js')
const { storeFor } = await import('../lib/ledger.js')
const { ensureCards, cardsStatusFor, storePolished, readPolished } = await import('../lib/cards.js')
const { loadPlan, planId } = await import('../lib/check-plan.js')
const { parseTap, interpretTestReport, crossCheckReport } = await import('../lib/tap.js')

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
    async check(batch, checks = ['bridge', 'syntax']) {
      return createCheckTool().execute({ action: 'static', batches: [batch], checks }, exec)
    },
    record(id) {
      const found = listRecords(storeFor(root)).records.find(record => record.id === id)
      assert.ok(found, `missing archived record ${id}`)
      return found
    },
  }
}

const PRELOAD = "const { contextBridge } = require('electron')\ncontextBridge.exposeInMainWorld('api', { ping() {} })\n"
const TAP_PASS = 'TAP version 13\nok 1 - actual test\n1..1\n# tests 1\n# pass 1\n# fail 0\n'

function host({ stdout = '', stderr = '', lossy = false, stderrLossy = false, spillPath, onSpawn, onApproval, exitCode = 0, signal = null } = {}) {
  const calls = { spawns: 0, approvals: 0, stdoutReads: 0, stderrReads: 0 }
  const services = { get(name) {
    if (name === 'approval') return { async request() { calls.approvals++; onApproval?.(); return 'allowed-once' } }
    if (name !== 'subprocess') return undefined
    return { spawn() {
      calls.spawns++
      onSpawn?.()
      return {
        done: Promise.resolve({ exitCode, signal }),
        collected: {
          stdout: { readFrom() {
            calls.stdoutReads++
            return { text: stdout, nextOffset: Buffer.byteLength(stdout), lossy, ...(spillPath === undefined ? {} : { spillPath }) }
          } },
          stderr: { readFrom() {
            calls.stderrReads++
            return { text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: stderrLossy }
          } },
        },
      }
    } }
  } }
  return { services, calls }
}

async function planAndRun(ws, seam, recipe, options = {}) {
  const tool = createCheckTool(seam.services)
  const planned = await tool.execute({ action: 'plan', recipes: [recipe], ...options }, ws.exec)
  assert.ok(planned.checkPlanId, planned.error)
  const raw = { agent: ws.exec.agent, callId: 'm1-approved-call', signal: new AbortController().signal }
  return tool.execute({ action: 'run', checkPlanId: planned.checkPlanId }, ws.exec, raw)
}

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

test('6: card cache checks content before returning an old pass or polished draft', async () => {
  const ws = workspace({ 'preload.js': PRELOAD, 'renderer.js': 'window.api.ping()\n' })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const result = await ws.check(batch)
  assert.equal(result.status, 'passed', result.text)
  fs.utimesSync(ws.absolute('preload.js'), 1_700_000_000, 1_700_000_000)
  const cards = await ensureCards(ws.root)
  storePolished(cards.dir, 'overview', cards.anchor, 'cached polished body', 'test')
  const stat = fs.statSync(ws.absolute('preload.js'))
  const original = fs.readFileSync(ws.absolute('preload.js'), 'utf8')
  ws.put('preload.js', original.replace('ping()', 'gone()'))
  fs.utimesSync(ws.absolute('preload.js'), stat.atime, stat.mtime)
  assert.equal(applicabilityOf(ws.record(result.verification.id), ws.root).effective, 'stale')
  assert.equal(cardsStatusFor(ws.root).fresh, false)
  const refreshed = await ensureCards(ws.root)
  assert.equal(refreshed.regenerated.length, 4)
  assert.equal(readPolished(cards.dir, 'overview', refreshed.anchor), null)
  const overview = fs.readFileSync(path.join(cards.dir, 'overview.md'), 'utf8')
  assert.match(overview, /\| passed \| stale \|/)
})

test('7: scope is frozen in the plan identity and edits are refused before approval', async () => {
  const ws = workspace({ 'none.mjs': '' })
  const recipe = { id: 'unit', kind: 'tests', program: process.execPath, argv: ['--test', '--test-reporter=tap', 'none.mjs'], cwd: ws.root, scope: ['none.mjs'] }
  assert.notEqual(planId([recipe], []), planId([{ ...recipe, scope: [] }], []))
  const seam = host()
  const tool = createCheckTool(seam.services)
  const planned = await tool.execute({ action: 'plan', recipes: [recipe] }, ws.exec)
  const file = path.join(storeFor(ws.root).dir, 'checks', `${planned.checkPlanId}.json`)
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'))
  plan.recipes[0].scope = []
  fs.writeFileSync(file, JSON.stringify(plan))
  assert.equal(loadPlan(ws.root, planned.checkPlanId).ok, false)
  const run = await tool.execute({ action: 'run', checkPlanId: planned.checkPlanId }, ws.exec, { agent: ws.exec.agent, callId: 'tampered' })
  assert.equal(run.status, 'not_run')
  assert.equal(seam.calls.approvals, 0)
})

test('8a: a missing spill file does not erase lossy evidence', async () => {
  const ws = workspace()
  const seam = host({ lossy: true, spillPath: ws.absolute('missing-spill.log') })
  const run = await planAndRun(ws, seam, { id: 'types', kind: 'types', program: 'tsc', argv: ['--noEmit'] })
  assert.equal(run.status, 'partial', run.text)
  assert.equal(run.runs[0].verdict, 'unverifiable')
})

test('8b: stderr diagnostics are read even when stdout is empty and exit is zero', async () => {
  const ws = workspace()
  const seam = host({ stderr: 'file.ts(1,1): error TS2322: Type mismatch.\n' })
  const run = await planAndRun(ws, seam, { id: 'types', kind: 'types', program: 'tsc', argv: ['--noEmit'] })
  assert.equal(run.status, 'failed', run.text)
  assert.equal(seam.calls.stderrReads, 1)
})

test('8c: loss on stderr prevents a semantic pass even with complete stdout', async () => {
  const ws = workspace()
  const run = await planAndRun(ws, host({ stdout: TAP_PASS, stderrLossy: true }), { id: 'unit', kind: 'tests', program: 'node', argv: ['--test'] })
  assert.equal(run.status, 'partial')
  assert.equal(run.runs[0].verdict, 'unverifiable')
})

test('9: partial TAP and contradictory summaries cannot claim a pass', () => {
  const reports = [
    'TAP version 13\nok 1 - truncated\n',
    'TAP version 13\nok 1 - a\n1..1\n# tests 1\n# pass 1\n# fail 1\n',
  ]
  for (const text of reports) {
    const report = parseTap(text)
    assert.equal(crossCheckReport(report).ok, false)
    const verdict = interpretTestReport(report, { callId: 'call', expectedCallId: 'call', truncated: false })
    assert.notEqual(verdict.status, 'passed')
  }
})

test('10a: host execution archives required recipe IDs and the selected batch', async () => {
  const ws = workspace({ 'input.js': 'const x = 1\n' })
  const batch = await ws.edit('input.js', '1', '2')
  const run = await planAndRun(ws, host({ stdout: TAP_PASS }), { id: 'unit', kind: 'tests', program: 'node', argv: ['--test', '--test-reporter=tap'] }, { batches: [batch], inputs: ['input.js'] })
  assert.equal(run.status, 'completed', run.text)
  assert.deepEqual(run.batches, [batch])
  const records = listRecords(storeFor(ws.root), { batchIds: [batch] }).records
  const record = records.find(record => record.id === run.verification.id)
  assert.ok(record)
  assert.ok(record.requiredChecks.includes('unit'))
  assert.equal(applicabilityOf(record, ws.root).effective, 'passed')
})

test('10b: input drift during execution remains stale in the archived verdict', async () => {
  const ws = workspace({ 'input.js': 'const x = 1\n' })
  const batch = await ws.edit('input.js', '1', '2')
  const seam = host({ stdout: TAP_PASS, onSpawn: () => ws.put('input.js', 'const x = 3\n') })
  const run = await planAndRun(ws, seam, { id: 'unit', kind: 'tests', program: 'node', argv: ['--test', '--test-reporter=tap'] }, { batches: [batch], inputs: ['input.js'] })
  assert.equal(run.status, 'stale')
  const record = ws.record(run.verification.id)
  const now = applicabilityOf(record, ws.root)
  assert.equal(now.verdict.status, 'stale')
  assert.equal(now.effective, 'stale')
})

test('11: batch detail with checks=true returns both diffs and archived checks', async () => {
  const ws = workspace({ 'only.js': 'const x = 1\n' })
  const batch = await ws.edit('only.js', '1', '2')
  const result = await ws.check(batch, ['syntax'])
  const history = await createHistoryTool().execute({ batch, checks: true }, ws.exec)
  assert.equal(history.items.length, 1)
  assert.equal(history.items[0].diffs.length, 1)
  assert.ok(history.items[0].checks.some(check => result.verification.id.startsWith(check.id)))
})

test('12a: adding an IPC caller with no handler is new rather than existing', async () => {
  const ws = workspace({ 'renderer.js': "const { ipcRenderer } = require('electron')\n" })
  const before = await assembleTraceGraph(ws.root, { capture: true })
  ws.put('renderer.js', "const { ipcRenderer } = require('electron')\nipcRenderer.invoke('missing')\n")
  const { result } = await diffWorkspaceBridges({ workspace: ws.root, before, capture: true, checks: ['ipc'] })
  assert.equal(result.status, 'failed')
  assert.equal(result.findings[0].attribution, 'new')
})

test('12b: an IPC mismatch already in the baseline stays existing after a line move', async () => {
  const source = "const { ipcRenderer } = require('electron')\nipcRenderer.invoke('ping')\n"
  const ws = workspace({ 'renderer.js': source, 'main.js': "const { ipcMain } = require('electron')\nipcMain.on('ping', () => {})\n" })
  const before = await assembleTraceGraph(ws.root, { capture: true })
  ws.put('renderer.js', `\n${source}`)
  const { result } = await diffWorkspaceBridges({ workspace: ws.root, before, capture: true, checks: ['ipc'] })
  assert.equal(result.status, 'partial', result.verdict)
  assert.equal(result.findings[0].attribution, 'existing')
})

test('13: a newly discovered consumer invalidates an archived bridge pass', async () => {
  const ws = workspace({ 'preload.js': PRELOAD, 'renderer.js': 'window.api.ping()\n' })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const checked = await ws.check(batch)
  assert.equal(checked.status, 'passed')
  ws.put('new-renderer.js', 'window.api.missing()\n')
  const now = applicabilityOf(ws.record(checked.verification.id), ws.root)
  assert.equal(now.effective, 'stale')
  assert.ok(now.drifted.includes('new-renderer.js'))
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

test('15: source drift while approval is pending starts zero processes', async () => {
  const ws = workspace({ 'input.mjs': 'const input = 1\n' })
  const seam = host({ stdout: TAP_PASS, onApproval: () => ws.put('input.mjs', 'const input = 2\n') })
  const run = await planAndRun(ws, seam, { id: 'unit', kind: 'tests', program: 'node', argv: ['--test'], scope: ['input.mjs'] })
  assert.equal(run.status, 'stale')
  assert.equal(seam.calls.approvals, 1)
  assert.equal(seam.calls.spawns, 0)
  assert.equal(applicabilityOf(ws.record(run.verification.id), ws.root).effective, 'stale')
})

test('16: a clean host test does not hide the plan\'s failed static check', async () => {
  const ws = workspace({ 'preload.js': PRELOAD, 'renderer.js': 'window.api.ping()\n' })
  const batch = await ws.edit('preload.js', 'ping() {}', 'pong() {}')
  const run = await planAndRun(ws, host({ stdout: TAP_PASS }), { id: 'unit', kind: 'tests', program: 'node', argv: ['--test'] }, { batches: [batch] })
  assert.equal(run.runs[0].verdict, 'passed')
  assert.equal(run.status, 'failed', run.text)
  assert.ok(run.findings.some(finding => finding.kind === 'expose_member_missing'))
  assert.equal(run.staticVerification.persisted, true)
  const records = listRecords(storeFor(ws.root), { batchIds: [batch] }).records
  assert.equal(records.length, 2)
  assert.ok(records.every(record => record.checkPlanId === run.checkPlanId))
  assert.deepEqual(new Set(records.map(record => record.provenance)), new Set(['internal-static', 'host-execution']))
  assert.equal(applicabilityOf(ws.record(run.staticVerification.id), ws.root).effective, 'failed')
  assert.equal(applicabilityOf(ws.record(run.verification.id), ws.root).effective, 'passed')
})

test('17: an uncertain static binding keeps a successful test plan partial', async () => {
  const ws = workspace({ 'preload.js': PRELOAD, 'renderer.js': 'const api = window.api; api.ping()\n' })
  const batch = await ws.edit('renderer.js', 'const api = window.api;', 'let api = window.api; api = other;')
  const run = await planAndRun(ws, host({ stdout: TAP_PASS }), { id: 'unit', kind: 'tests', program: 'node', argv: ['--test'] }, { batches: [batch] })
  assert.equal(run.runs[0].verdict, 'passed')
  assert.equal(run.status, 'partial', run.text)
  assert.ok(run.limitations.some(limitation => limitation.code === 'unknown_binding'))
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

test('19: missing or inconsistent nested TAP plans cannot be accepted', () => {
  const report = fs.readFileSync(new URL('./fixtures/tap/nested.tap', import.meta.url), 'utf8')
  const damaged = [report.replace('    1..2', '    1..5'), report.replace('    1..2', '')]
  for (const text of damaged) {
    assert.equal(crossCheckReport(parseTap(text)).ok, false)
    assert.notEqual(interpretTestReport(parseTap(text), { callId: 'call', expectedCallId: 'call', truncated: false }).status, 'passed')
  }
})

test('20: full static dependencies are frozen before host approval', async () => {
  const ws = workspace({ 'preload.js': PRELOAD, 'renderer.js': 'window.api.ping()\n' })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const seam = host({ stdout: TAP_PASS, onApproval: () => ws.put('renderer.js', 'window.api.missing()\n') })
  const run = await planAndRun(ws, seam, { id: 'unit', kind: 'tests', program: 'node', argv: ['--test'] }, { batches: [batch] })
  assert.equal(run.status, 'stale', run.text)
  assert.equal(seam.calls.spawns, 0)
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

test('23: an added dependency during approval invalidates the frozen discovery set', async () => {
  const ws = workspace({ 'preload.js': PRELOAD, 'renderer.js': 'window.api.ping()\n' })
  const batch = await ws.edit('preload.js', 'ping() {}', 'ping() { return 1 }')
  const seam = host({ stdout: TAP_PASS, onApproval: () => ws.put('added.js', 'window.api.missing()\n') })
  const run = await planAndRun(ws, seam, { id: 'unit', kind: 'tests', program: 'node', argv: ['--test'] }, { batches: [batch] })
  assert.equal(run.status, 'stale', run.text)
  assert.equal(seam.calls.spawns, 0)
})

test('24: real Node suite output checks nested plans without counting suites as tests', () => {
  const ws = workspace({ 'suite.mjs': "import { describe, it } from 'node:test'; describe('suite', () => { it('one', () => {}); it('two', () => {}) })\n" })
  const executed = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'suite.mjs'], { cwd: ws.root, encoding: 'utf8', timeout: 10_000 })
  assert.equal(executed.status, 0, executed.stderr)
  const report = parseTap(executed.stdout)
  assert.equal(crossCheckReport(report).ok, true, JSON.stringify(report))
  assert.equal(report.summary.suites, 1)
  const verdict = interpretTestReport(report, { callId: 'real-suite', expectedCallId: 'real-suite', truncated: false })
  assert.equal(verdict.status, 'passed')
  assert.equal(verdict.executed, 2)
  const requiredSuite = interpretTestReport(report, { callId: 'real-suite', expectedCallId: 'real-suite', truncated: false, requiredTests: ['suite'] })
  assert.equal(requiredSuite.status, 'unverifiable')
  assert.equal(requiredSuite.reason, 'required_test_not_executed')
})

test('25: a real aborted nested test cannot support a pass', () => {
  const ws = workspace({ 'cancelled.mjs': "import test from 'node:test'; test('parent', async t => { const abort = new AbortController(); const pending = t.test('unfinished', {signal: abort.signal}, () => new Promise(() => {})); setTimeout(() => abort.abort(), 10); await pending })\n" })
  const executed = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=1000', 'cancelled.mjs'], { cwd: ws.root, encoding: 'utf8', timeout: 10_000 })
  assert.equal(executed.status, 1, JSON.stringify({ error: executed.error?.message, stdout: executed.stdout, stderr: executed.stderr }))
  const report = parseTap(executed.stdout)
  assert.equal(crossCheckReport(report).ok, true, JSON.stringify(report))
  assert.ok(report.summary.fail > 0, executed.stdout)
  assert.notEqual(interpretTestReport(report, { callId: 'real-cancel', expectedCallId: 'real-cancel', truncated: false }).status, 'passed')
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

test('27: a real suite hook failure stays failed when every child is cancelled', () => {
  const ws = workspace({ 'hook.mjs': "import { describe, before, it } from 'node:test'; describe('broken setup', () => { before(() => { throw new Error('setup failed') }); it('blocked', () => {}) })\n" })
  const executed = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'hook.mjs'], { cwd: ws.root, encoding: 'utf8', timeout: 10_000 })
  assert.equal(executed.status, 1, executed.stderr)
  const report = parseTap(executed.stdout)
  assert.equal(crossCheckReport(report).ok, true, JSON.stringify(report))
  assert.ok(report.summary.cancelled > 0, executed.stdout)
  const verdict = interpretTestReport(report, { callId: 'real-hook', expectedCallId: 'real-hook', truncated: false })
  assert.equal(verdict.status, 'failed')
  assert.equal(verdict.executed, 0)
  assert.ok(verdict.failures.some(point => point.name === 'broken setup' && point.error === 'setup failed'))
})

test('28: a signal termination cannot be displayed as exit zero', async () => {
  const ws = workspace({ 'input.js': 'const x = 1\n' })
  const result = await planAndRun(ws, host({ exitCode: null, signal: 'SIGTERM' }), { id: 'stopped', kind: 'process', program: 'node', argv: [] }, { inputs: ['input.js'], checks: [] })
  assert.equal(result.status, 'failed')
  assert.equal(result.runs[0].exitCode, null)
  assert.equal(result.runs[0].verdict, 'process_failed')
  assert.equal(ws.record(result.verification.id).checks[0].execution.exitCode, null)
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
