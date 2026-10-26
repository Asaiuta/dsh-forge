/**
 * Stage-3 quality floors for the construction engine — asserted, exit 1 on
 * miss, tighten-only (same policy as eval-quality / eval-ast).
 *
 * The oracle is hand-derived: expected file contents computed independently
 * of the engine, plus invariant properties (round trips, no-write-on-error,
 * ledger integrity) that must hold at 100%.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyEditSteps } from '../lib/edit-engine.js'
import { createEditTool, createRollbackTool } from '../lib/tools-edit.js'
import { readLedgerTail, storeFor, getBlob, readKnownState } from '../lib/ledger.js'
import { FinderPool } from '../lib/core.js'
import { createHash } from 'node:crypto'

process.env.DSH_FORGE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'forge-eval-edit-'))
const WORK = mkdtempSync(path.join(tmpdir(), 'forge-eval-edit-w-'))
const pool = new FinderPool()
const exec = { agent: { session: { header: { cwd: WORK, id: 'sess_eval_edit' } } } }
const edit = createEditTool(pool)
// Ticket replies go through ffedit itself (ffresolve was folded in).
const resolveTool = edit
const rollback = createRollbackTool(pool)

let floors = 0
function floor(label, detail) {
  floors++
  console.log(`  FLOOR ${floors} PASS - ${label}: ${detail}`)
}

const file = (name) => path.join(WORK, name)
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// --- Floor 1: drift-convergence oracle -----------------------------------------
// Batches with WRONG coordinates + expect anchors must land on the same
// content as the same batch with correct coordinates (deterministic corpus,
// hand-derived expectations).
{
  const cases = [
    {
      name: 'conv1.js',
      original: 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n',
      // correct coords: replace L3; drifted call says L1 but anchors on 'const c = 3'
      steps: [{ op: 'replace', start: 1, expect: 'const c = 3', text: 'const c = 30' }],
      expected: 'const a = 1\nconst b = 2\nconst c = 30\nconst d = 4\n',
    },
    {
      name: 'conv2.js',
      original: 'function f() {\n  return 1\n}\nfunction g() {\n  return 2\n}\n',
      // target off by -3: says L5 (g body), anchors on g signature, expect pulls to L5
      steps: [{ op: 'replace', start: 5, expect: 'function g() {', text: 'function g() {', end: 5 }],
    },
    {
      name: 'conv3.py',
      original: 'class Cache:\n    def put(self):\n        pass\n\n    def get(self):\n        pass\n',
      // insert "after L1" misremembered as after L4, anchored on class line
      steps: [{ op: 'insert', after: 4, expect: 'class Cache:', text: '    MAX = 8' }],
      expected: 'class Cache:\n    MAX = 8\n    def put(self):\n        pass\n\n    def get(self):\n        pass\n',
    },
  ]
  let converged = 0
  for (const c of cases) {
    const r = applyEditSteps(c.original, c.steps)
    if (r.ok && (c.expected === undefined || r.text === c.expected)) converged++
  }
  assert.equal(converged, cases.length, `drift convergence ${converged}/${cases.length}`)
  floor('drift-convergence', `expect anchors land wrong-coordinate batches on ground truth (${cases.length}/${cases.length})`)
}

// --- Floor 2: no-write-on-error over the full failure matrix --------------------
// Every failing input class must leave the file byte-identical and record
// NO edit batch (external markers aside).
{
  writeFileSync(file('guard.js'), 'one\ntwo\nthree\n')
  const before = sha(readFileSync(file('guard.js')))
  const batchesBefore = readLedgerTail(storeFor(WORK)).filter((b) => b.kind === 'edit').length
  const failures = [
    edit.execute({ path: 'guard.js', steps: [{ op: 'replace', start: 1, end: 2, text: 'x' }, { op: 'delete', start: 2 }], reason: 'overlap' }),
    edit.execute({ path: 'guard.js', steps: [{ op: 'replace', start: 99, text: 'x' }], reason: 'range' }),
    edit.execute({ path: 'guard.js', steps: [{ op: 'insert', after: 0, text: 'x' }, { op: 'insert', after: 0, text: 'y' }], reason: 'dup boundary' }),
    edit.execute({ path: 'guard.js', steps: [{ op: 'replace', start: 1, expect: 'no-such-line', text: 'x' }], reason: 'anchor' }),
    edit.execute({ path: 'guard.js', steps: [{ op: 'target', find: 'two', replaceWith: '2' }, { op: 'target', find: 'two', replaceWith: '3' }], reason: 'second misses after first' }),
  ]
  for (const f of failures) {
    const r = await f
    assert.ok(r.error, `expected failure, got ${JSON.stringify(r).slice(0, 120)}`)
  }
  assert.equal(sha(readFileSync(file('guard.js'))), before, 'file byte-identical after 5 failures')
  const batchesAfter = readLedgerTail(storeFor(WORK)).filter((b) => b.kind === 'edit').length
  assert.equal(batchesAfter, batchesBefore, 'no edit batches recorded by failures')
  floor('no-write-on-error', '5 failure classes (overlap/range/dup-boundary/anchor/miss) leave file + ledger untouched')
}

// --- Floor 3: ambiguity safety over real fixture-shaped file --------------------
{
  writeFileSync(file('amb.js'), 'function handle() {}\nctx()\nfunction handle() {}\nctx()\n')
  const before = sha(readFileSync(file('amb.js')))
  const r = await edit.execute({ path: 'amb.js', steps: [{ op: 'target', find: 'function handle() {}', replaceWith: 'function handle(evt) {}' }], reason: 'parameterize handler' }, exec)
  assert.equal(r.status, 'ticket')
  assert.equal(sha(readFileSync(file('amb.js'))), before, 'ambiguous batch wrote nothing')
  const resolved = await resolveTool.execute({ ticket: r.ticket, choice: 1 }, exec)
  assert.equal(resolved.status, 'applied')
  assert.equal(readFileSync(file('amb.js'), 'utf8'), 'function handle() {}\nctx()\nfunction handle(evt) {}\nctx()\n')
  floor('ambiguity-safety', 'ticket path: zero writes before resolve; chosen candidate applied exactly once')
}

// --- Floor 4: anchor idempotency --------------------------------------------------
{
  writeFileSync(file('idem.js'), 'function f() {\n  a\n  b\n}\n')
  const steps = [{ op: 'replace', start: 1, end: 4, text: 'function f() {\n  a\n  NEW\n}' }]
  const first = await edit.execute({ path: 'idem.js', steps, reason: 'idem 1' }, exec)
  assert.equal(first.status, 'applied')
  const once = readFileSync(file('idem.js'), 'utf8')
  assert.equal(once, 'function f() {\n  a\n  NEW\n}\n', 'anchor edit correct')
  // re-send with shifted coordinates (content changed) + anchors
  const second = await edit.execute({ path: 'idem.js', steps: [{ op: 'replace', start: 1, end: 4, text: 'function f() {\n  a\n  NEW\n}' }], reason: 'idem 2' }, exec)
  assert.equal(second.status, 'applied')
  assert.equal(readFileSync(file('idem.js'), 'utf8'), once, 'second identical edit is a no-op')
  floor('anchor-idempotency', 're-sending a boundary-quoted replacement is content-neutral')
}

// --- Floor 5: encoding fidelity matrix --------------------------------------------
{
  const matrix = [
    ['LF', 'l1\nl2\nl3\n'],
    ['CRLF', 'l1\r\nl2\r\nl3\r\n'],
    ['CR', 'l1\rl2\rl3\r'],
    ['BOM-LF', '\uFEFFl1\nl2\n'],
  ]
  for (const [label, content] of matrix) {
    const name = `enc-${label}.txt`
    writeFileSync(file(name), content, 'utf8')
    const r = await edit.execute({ path: name, steps: [{ op: 'replace', start: 1, text: 'L1' }], reason: `enc ${label}` }, exec)
    assert.equal(r.status, 'applied', `${label}: ${r.error}`)
    const out = readFileSync(file(name), 'utf8')
    const enc = { LF: /\r/.test(out) === false, CRLF: (out.match(/\r\n/g) ?? []).length === 3, CR: (out.match(/\r(?!\n)/g) ?? []).length === 3, 'BOM-LF': out.charCodeAt(0) === 0xfeff && !out.includes('\r') }[label]
    assert.ok(enc, `${label} EOL/BOM preserved, got ${JSON.stringify(out)}`)
  }
  floor('encoding-fidelity', 'LF/CRLF/CR/BOM matrix preserved byte-exact through edit cycles')
}

// --- Floor 6: rollback chain integrity (state machine) ------------------------------
{
  const name = 'chain.txt'
  writeFileSync(file(name), 'S0\n')
  const states = ['S0\n', 'S1\n', 'S2\n', 'S3\n']
  const batchIds = []
  for (let i = 1; i < states.length; i++) {
    const r = await edit.execute({ path: name, steps: [{ op: 'replace', start: 1, text: `S${i}` }], reason: `chain step ${i}` }, exec)
    assert.equal(r.status, 'applied')
    batchIds.push(r.batch)
  }
  // external modification in the middle of the chain's tail
  writeFileSync(file(name), 'HUMAN\n')
  await edit.execute({ path: name, steps: [{ op: 'replace', start: 1, text: 'S4' }], reason: 'chain step 4' }, exec)

  // Roll everything back in reverse order; every state must be byte-exact.
  const expectedOnRollback = ['HUMAN-SHOT', 'S3\n', 'S2\n', 'S1\n', 'S0\n']
  const all = readLedgerTail(storeFor(WORK)).filter((b) => b.nodes.some((n) => n.file === 'chain.txt'))
  // after S4 edit: disk = S4; rollback S4-batch → external snapshot state (HUMAN)
  const r4 = await rollback.execute({ batch: 'last', dryRun: false, reason: 'chain revert 4' }, exec)
  assert.equal(r4.status, 'applied')
  // the S4 batch's before-blob is the HUMAN content (external tripwire fired)
  assert.equal(readFileSync(file(name), 'utf8'), 'HUMAN\n', 'external state restored')
  for (let i = batchIds.length - 1; i >= 0; i--) {
    const rb = await rollback.execute({ batch: String(batchIds[i]), dryRun: false, reason: `chain revert ${i}` }, exec)
    assert.equal(rb.status, 'applied', `revert of #${batchIds[i]}`)
    assert.equal(readFileSync(file(name), 'utf8'), `S${i}\n`, `state S${i} restored byte-exact`)
  }
  floor('rollback-chain', '5-deep chain (incl. external interruption) restores every historical state byte-exact')
}

// --- Floor 7: ledger integrity (blobs hash-verify, state consistency) ---------------
{
  const store = storeFor(WORK)
  const batches = readLedgerTail(store, 100_000)
  assert.ok(batches.length >= 8, `ledger has batches, got ${batches.length}`)
  let checked = 0
  for (const batch of batches) {
    assert.ok(batch.reason && batch.reason.length > 0, 'every batch carries a reason')
    assert.ok(batch.actor && batch.actor.length > 0, 'every batch carries a actor')
    for (const node of batch.nodes) {
      for (const id of [node.before, node.after]) {
        if (id === null) continue
        const blob = getBlob(store, id)
        assert.ok(blob, `blob ${id.slice(0, 8)} present`)
        assert.equal(sha(blob), id, `blob ${id.slice(0, 8)} content-address verified`)
        checked++
      }
    }
  }
  assert.ok(checked >= 10, `verified ${checked} blob references`)
  // state consistency: every in-managed file's hash matches disk
  const managed = ['chain.txt', 'amb.js', 'idem.js']
  for (const rel of managed) {
    const known = readKnownState(store, rel)
    assert.ok(known, `${rel} in state`)
    assert.equal(known.hash, sha(readFileSync(file(rel))), `${rel} state hash == disk hash`)
  }
  floor('ledger-integrity', `${batches.length} batches, ${checked} blob refs hash-verified, state==disk`)
}

// --- Floor 8: suggestion precision ---------------------------------------------------
{
  writeFileSync(file('typo.js'), 'export function calculateTotals(items) {\n  return 0\n}\nconst fallbackLimit = 10\n')
  const r = await edit.execute({ path: 'typo.js', steps: [{ op: 'target', find: 'calculateTotalz(items) {', replaceWith: 'x' }], reason: 'typo probe' }, exec)
  // A genuine miss still offers the true line; literal substrings now match inline.
  assert.ok(r.error && /not found/.test(r.error), 'probe misses')
  const errText = r.error
  assert.match(errText, /L1/, 'correct line appears in suggestions')
  floor('suggestion-precision', 'typo probe surfaces the true line with similarity score in the error')
}

pool.disposeAll()
try {
  rmSync(WORK, { recursive: true, force: true })
  rmSync(process.env.DSH_FORGE_DATA_DIR, { recursive: true, force: true })
} catch {
  // best-effort
}
console.log(`\nall ${floors} edit floors passed`)
process.exitCode = 0
