/**
 * M1.5 — verification records, in history and on cards.
 *
 * The claim this suite defends: **a recorded verdict and its present
 * applicability are two facts, and neither may overwrite the other.**
 *
 *   immutability — a later failure does not erase an earlier pass, and a later
 *                  pass does not upgrade an earlier failure. The record on disk
 *                  never changes.
 *   applicability— recomputed from CONTENT hashes on every read. A same-size
 *                  edit that restores the mtime is exactly the case where a
 *                  stale pass would otherwise be reused, so it is tested
 *                  directly.
 *   honesty      — a missing required check, a skipped check, an unavailable
 *                  run and an external report all fail to demonstrate a pass.
 *   durability   — a storage failure does not undo the write and is not reported
 *                  as archived.
 *   isolation    — credentials and environment values never reach a record.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-data-'))
process.env.DSH_FORGE_DATA_DIR = dataDir

const { aggregateChecks, applicabilityOf, appendRecord, listRecords, readRevision, newRecordId, VERIFICATION_SCHEMA } =
  await import('../lib/verification.js')
const { storeFor } = await import('../lib/ledger.js')

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

function workspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-ws-'))
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

const result = (id, kind, status, extra = {}) => ({ id, kind, status, coverage: { files: 1 }, findings: [], ...extra })

function record(overrides = {}) {
  return {
    schema: VERIFICATION_SCHEMA,
    id: newRecordId(),
    workspaceId: 'ws',
    batchIds: [1],
    afterHashes: [],
    checks: [],
    requiredChecks: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    provenance: 'internal-static',
    ...overrides,
  }
}

// --- aggregate: nothing stands in for a pass ------------------------------
{
  const verdict = aggregateChecks(['bridge', 'syntax'], [result('bridge', 'bridge', 'passed')], 'internal-static')
  assert.equal(verdict.status, 'partial')
  assert.deepEqual(verdict.missing, ['syntax'])
  ok('a missing required check is partial, never passed')
}
{
  const verdict = aggregateChecks(['bridge'], [result('bridge', 'bridge', 'not_run', { reason: 'cancelled' })], 'internal-static')
  assert.equal(verdict.status, 'not_run')
  assert.deepEqual(verdict.notPassed, ['bridge'])
  ok('a skipped or cancelled check does not demonstrate a pass')
}
{
  const verdict = aggregateChecks(['bridge'], [result('bridge', 'bridge', 'unavailable')], 'internal-static')
  assert.notEqual(verdict.status, 'passed')
  ok('an unavailable backend does not demonstrate a pass')
}
{
  const verdict = aggregateChecks(['bridge'], [result('bridge', 'bridge', 'stale')], 'internal-static')
  assert.notEqual(verdict.status, 'passed')
  ok('a stale check does not demonstrate a pass')
}
{
  const verdict = aggregateChecks(['bridge', 'syntax'], [
    result('bridge', 'bridge', 'passed'),
    result('syntax', 'syntax', 'failed', { findings: [{ code: 'syntax_error', message: 'bad' }] }),
  ], 'internal-static')
  assert.equal(verdict.status, 'failed')
  assert.equal(verdict.failures.length, 1)
  ok('a failure wins over every other consideration')
}
{
  const verdict = aggregateChecks([], [result('process', 'process', 'passed')], 'host-execution')
  assert.equal(verdict.status, 'not_run')
  assert.match(verdict.reason, /declared no required check/)
  ok('a record that required nothing accepts nothing, even when a process exited 0')
}
{
  const verdict = aggregateChecks(['tests'], [result('tests', 'tests', 'passed')], 'external-report')
  assert.equal(verdict.status, 'not_run')
  assert.ok(verdict.missing.includes('tests'))
  ok('an external report never counts toward the automatic set, even when it claims passed')
}
{
  const verdict = aggregateChecks(['bridge'], [result('bridge', 'bridge', 'passed')], 'internal-static')
  assert.equal(verdict.status, 'passed')
  assert.equal(verdict.failures.length, 0)
  ok('only a present, passing, required, non-external check yields passed')
}

// --- immutability and revision -------------------------------------------
{
  const ws = workspace()
  const store = storeFor(ws)
  assert.deepEqual(readRevision(store), { revision: 0, records: 0 })

  const first = record({ checks: [result('bridge', 'bridge', 'passed')], requiredChecks: ['bridge'] })
  const a = await appendRecord(store, ws, first)
  assert.equal(a.ok, true)
  assert.equal(a.revision, 1)

  const before = fs.readFileSync(path.join(store.dir, 'verification', `${first.id}.json`), 'utf8')
  // A later failure is a NEW record; the earlier file must be byte-identical.
  const second = record({ checks: [result('bridge', 'bridge', 'failed', { findings: [{ code: 'x', message: 'broke' }] })], requiredChecks: ['bridge'] })
  await appendRecord(store, ws, second)
  const after = fs.readFileSync(path.join(store.dir, 'verification', `${first.id}.json`), 'utf8')
  assert.equal(after, before, 'an earlier record must never be rewritten')

  const listed = listRecords(store)
  assert.equal(listed.records.length, 2)
  assert.equal(readRevision(store).revision, 2)
  assert.equal(readRevision(store).records, 2)
  ok('records are append-only and the revision advances once per committed record')
}
{
  const ws = workspace()
  const store = storeFor(ws)
  await appendRecord(store, ws, record())
  // A leftover temp file is not a record and must not advance anything.
  fs.writeFileSync(path.join(store.dir, 'verification', `${newRecordId()}.json.forge-999-x.tmp`), '{"half":')
  const listed = listRecords(store)
  assert.equal(listed.records.length, 1, 'a half-written temp file must not be listed as a record')
  assert.equal(listed.unreadable, 0)
  assert.equal(readRevision(store).records, 1)
  ok('a leftover temporary file is not mistaken for a committed record')
}
{
  const ws = workspace()
  const store = storeFor(ws)
  await appendRecord(store, ws, record())
  fs.writeFileSync(path.join(store.dir, 'verification', 'broken.json'), '{not json')
  const listed = listRecords(store)
  assert.equal(listed.records.length, 1)
  assert.equal(listed.unreadable, 1)
  ok('an unreadable record is counted as unreadable rather than silently dropped')
}
{
  const ws = workspace()
  const store = storeFor(ws)
  const revBefore = readRevision(store).revision
  // Make the record path unusable: a directory where the file must go.
  fs.mkdirSync(path.join(store.dir, 'verification'), { recursive: true })
  const doomed = record()
  fs.mkdirSync(path.join(store.dir, 'verification', `${doomed.id}.json`))
  const appended = await appendRecord(store, ws, doomed)
  assert.equal(appended.ok, false)
  assert.match(appended.detail, /not persisted/)
  assert.equal(readRevision(store).revision, revBefore, 'a failed append must not advance the revision')
  ok('a storage failure leaves the revision untouched and reports not-persisted')
}

// --- applicability is content, not size+mtime -----------------------------
{
  const ws = workspace({ 'src/a.js': 'AAAA\n' })
  const store = storeFor(ws)
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ws, f))).digest('hex')
  const rec = record({ afterHashes: [{ file: 'src/a.js', hash: hash('src/a.js') }] })
  await appendRecord(store, ws, rec)
  const statBefore = fs.statSync(path.join(ws, 'src/a.js'))
  assert.equal(applicabilityOf(rec, ws).applicable, true)

  // Same length, mtime restored: the card anchor's size+mtime digest would not
  // move here. Applicability must still go stale.
  fs.writeFileSync(path.join(ws, 'src/a.js'), 'BBBB\n')
  fs.utimesSync(path.join(ws, 'src/a.js'), statBefore.atime, statBefore.mtime)
  const after = fs.statSync(path.join(ws, 'src/a.js'))
  assert.equal(after.size, statBefore.size, 'the test must exercise an unchanged size')
  assert.equal(Math.round(after.mtimeMs), Math.round(statBefore.mtimeMs), 'and an unchanged mtime')

  const now = applicabilityOf(rec, ws)
  assert.equal(now.applicable, false)
  assert.deepEqual(now.drifted, ['src/a.js'])
  ok('a same-size edit with a restored mtime still makes the record inapplicable')
}
{
  const ws = workspace({ 'src/a.js': 'x\n' })
  const crypto = await import('node:crypto')
  const hash = crypto.createHash('sha256').update('x\n').digest('hex')
  const rec = record({
    afterHashes: [{ file: 'src/a.js', hash }],
    checks: [result('bridge', 'bridge', 'passed')],
    requiredChecks: ['bridge'],
  })
  assert.equal(applicabilityOf(rec, ws).effective, 'passed')
  fs.writeFileSync(path.join(ws, 'src/a.js'), 'changed\n')
  const stale = applicabilityOf(rec, ws)
  assert.equal(stale.verdict.status, 'passed', 'the recorded verdict is history and never changes')
  assert.equal(stale.effective, 'stale', 'the current applicability is separate')
  ok('the recorded verdict stays passed while the effective verdict becomes stale')
}
{
  const ws = workspace()
  const rec = record({
    afterHashes: [{ file: 'src/deleted.js', hash: null }],
    checks: [result('bridge', 'bridge', 'passed')],
    requiredChecks: ['bridge'],
  })
  assert.equal(applicabilityOf(rec, ws).applicable, true, 'a file recorded as absent and still absent is consistent')
  ok('a recorded deletion stays applicable while the file is still absent')
}

// --- credentials never enter a record ------------------------------------
{
  const ws = workspace()
  const store = storeFor(ws)
  // The adapter only ever persists ids and paths; prove no environment value or
  // token-shaped string can arrive through the documented fields.
  const rec = record({
    provenance: 'host-execution',
    hostCallId: 'call-1',
    recipeId: 'unit',
    exitCode: 0,
    outputRef: 'spill:/tmp/out.log',
    checks: [result('unit', 'process', 'passed', { reason: 'exit 0 only — no test or type semantics were interpreted' })],
  })
  await appendRecord(store, ws, rec)
  const raw = fs.readFileSync(path.join(store.dir, 'verification', `${rec.id}.json`), 'utf8')
  assert.ok(!/process\.env|DEEPSEEK_API_KEY|Bearer/i.test(raw))
  for (const value of Object.values(process.env)) {
    if (typeof value === 'string' && value.length >= 16) {
      assert.ok(!raw.includes(value), 'no environment value may be persisted in a record')
    }
  }
  ok('a record contains ids, paths and verdicts — never environment values')
}

// --- filtering ------------------------------------------------------------
{
  const ws = workspace()
  const store = storeFor(ws)
  await appendRecord(store, ws, record({ batchIds: [1] }))
  await appendRecord(store, ws, record({ batchIds: [2] }))
  const onlyTwo = listRecords(store, { batchIds: [2] })
  assert.equal(onlyTwo.records.length, 1)
  assert.deepEqual(onlyTwo.records[0].batchIds, [2])
  ok('records are selected by the batches they describe')
}

console.log(`${passed} verification groups passed`)
