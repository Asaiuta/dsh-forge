import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyLiteralEdits } from '../src/edit-literal.ts'
import { createEditTool, createHistoryTool, createRollbackTool } from '../src/tools-edit.ts'
import { FinderPool } from '../src/core.ts'
import { readLedgerTail, storeFor } from '../src/ledger.ts'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-literal-batch-'))
const previous = process.env.DSH_FORGE_DATA_DIR
process.env.DSH_FORGE_DATA_DIR = path.join(root, 'ledger')
const pool = new FinderPool(), edit = createEditTool(pool), history = createHistoryTool(), rollback = createRollbackTool(pool)
const exec = { agent: { session: { header: { cwd: root, id: 'literal-batch' } } } }
const raw = '\uFEFFone\r\ntwo\nthree\rfour'
const steps = [{ find: 'four', replaceWith: 'four\nlast' }, { find: 'one', replaceWith: 'first\r\nextra' }, { find: 'three', replaceWith: '$&' }]
const expected = '\uFEFFfirst\r\nextra\r\ntwo\n$&\rfour\nlast'
let count = 0
const ok = label => console.log(`PASS ${++count} ${label}`)
try {
  const result = applyLiteralEdits(raw, steps)
  assert.equal(result.ok, true); assert.equal(result.text, expected)
  assert.deepEqual(result.reports.map(r => r.index), [0, 1, 2])
  assert.deepEqual(result.reports[0].newRange, { start: 5, end: 6 })
  assert.deepEqual(result.reports[2].newRange, { start: 4, end: 4 })
  ok('unsorted steps use original positions and report shifted final lines; BOM/mixed EOL/dollar text preserved')
  for (const [text, changes, reason] of [
    ['abc', [{ find: 'ab', replaceWith: 'x' }, { find: 'bc', replaceWith: 'y' }], /overlap/],
    ['abc', [{ find: 'a', replaceWith: 'new' }, { find: 'new', replaceWith: 'x' }], /original snapshot/],
    ['aa aa', [{ find: 'aa', replaceWith: 'b' }], /more than once/],
    ['abc', [{ find: 'a', replaceWith: 'a' }], /must differ/],
    ['abc', [{ find: '', replaceWith: 'a' }], /nonempty/],
    ['abc', [{ find: 'a' }], /explicit/],
    ['abc', [{ find: 'a', replaceWith: 'x'.repeat(8 * 1024 * 1024) }], /8MB/],
  ]) { const refused = applyLiteralEdits(text, changes); assert.equal(refused.ok, false); assert.match(refused.reason, reason) }
  assert.equal(applyLiteralEdits('ab', [{ find: 'a', replaceWith: '' }, { find: 'b', replaceWith: 'B' }]).text, 'B')
  ok('overlap, cascades, ambiguity, no-op, missing fields and byte cap reject; adjacent deletion works')
  const file = path.join(root, 'mixed.txt'); fs.writeFileSync(file, raw)
  const value = await edit.execute({ path: file, steps, match: 'literal', reason: 'three edits', receipt: 'diff' }, exec)
  assert.equal(value.applied, 3); assert.equal(value.skipped ?? 0, 0); assert.ok(value.batch)
  assert.equal(fs.readFileSync(file, 'utf8'), expected)
  assert.equal(readLedgerTail(storeFor(root)).length, 1)
  assert.equal(value.diff.complete, true)
  await rollback.execute({ batch: value.batch, dryRun: false, reason: 'restore original bytes' }, exec)
  assert.deepEqual(fs.readFileSync(file), Buffer.from(raw))
  const frozen = await history.execute({ batch: value.batch }, exec)
  assert.ok(JSON.stringify(frozen).includes('last'))
  ok('one commit for three changes; complete diff remains historical after byte-exact rollback')
  const before = readLedgerTail(storeFor(root)).length
  for (const args of [
    { steps: [{ find: 'one', replaceWith: 'x' }, { find: 'missing', replaceWith: 'y' }] },
    { steps: [{ find: 'one', replaceWith: 'x', start: 1 }] },
    { steps: [{ op: 'replace', find: 'one', replaceWith: 'x' }] },
    { steps: [{ find: 'one', replaceWith: 'x' }], replaceAll: true },
    { steps: [{ find: 'one', replaceWith: 'x' }], find: 'two', replaceWith: 'y' },
  ]) {
    const refused = await edit.execute({ path: file, match: 'literal', reason: 'refuse batch', ...args }, exec)
    assert.ok(refused.error, JSON.stringify(refused)); assert.deepEqual(fs.readFileSync(file), Buffer.from(raw))
    assert.equal(readLedgerTail(storeFor(root)).length, before)
  }
  ok('tool failures never partially commit or add ledger batches')
  console.log(`${count} literal batch groups passed`)
} finally {
  pool.disposeAll(); edit.dispose()
  if (previous === undefined) delete process.env.DSH_FORGE_DATA_DIR; else process.env.DSH_FORGE_DATA_DIR = previous
  fs.rmSync(root, { recursive: true, force: true })
}
