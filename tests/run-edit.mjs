/**
 * Stage 3 unit tests — pure Node on built lib/ (build first).
 * Covers: engine step semantics (ops, inference, expect drift, anchors,
 * prefixes, indent shift, overlap/assembly), ledger (blobs, batches, state,
 * external tripwire, rollback/redo), tickets (issue/resolve/expire), and the
 * tool paths (ffedit/ffresolve/ffhistory/ffrollback) end-to-end on temp dirs.
 *
 * Allows natural shutdown so native handles finish their cleanup on Windows.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyEditSteps } from '../lib/edit-engine.js'
import { getBlob, putBlob, readKnownState, readLedgerTail, storeFor, workspaceForFile, detectEncoding, encodeText, looksBinary } from '../lib/ledger.js'
import { createTicket, loadTicket } from '../lib/tickets.js'
import { createEditTool, createResolveTool, createHistoryTool, createRollbackTool } from '../lib/tools-edit.js'
import { createReadSymbolTool } from '../lib/tools-symbol.js'
import { FinderPool } from '../lib/core.js'

process.env.DSH_FORGE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'forge-edit-data-'))
const WORK = mkdtempSync(path.join(tmpdir(), 'forge-edit-work-'))
const pool = new FinderPool()
const exec = { agent: { session: { header: { cwd: WORK, id: 'sess_test_actor' } } } }
const edit = createEditTool(pool)
const resolveTool = createResolveTool(pool)
const history = createHistoryTool()
const rollback = createRollbackTool(pool)

let passed = 0
function ok(label) {
  passed++
  console.log(`  ok ${passed} - ${label}`)
}

const file = (name) => path.join(WORK, name)
function writeFile(name, text) {
  writeFileSync(file(name), text)
  return name
}
function readFile(name) {
  return readFileSync(file(name), 'utf8')
}

async function main() {
  // --- engine: replace / delete / insert ------------------------------------
  {
    const r = applyEditSteps('a\nb\nc\n', [
      { op: 'replace', start: 2, text: 'B' },
      { op: 'delete', start: 1 },
      { op: 'insert', after: 0, text: 'top' },
    ])
    assert.ok(r.ok, 'basic batch ok')
    assert.equal(r.text, 'top\nB\nc\n', `replace+delete+insert assembled, got ${JSON.stringify(r.text)}`)
    ok('engine: replace/delete/insert on original-snapshot coordinates')
  }
  {
    // op inference: find→target, after→insert, start+text→replace, start→delete
    const r = applyEditSteps('x\ny\nz\n', [{ start: 1, text: 'X' }, { after: 3, text: 'w' }])
    assert.ok(r.ok && r.text === 'X\ny\nz\nw\n', `inference, got ${JSON.stringify(r.text)}`)
    ok('engine: op inference from fields')
  }
  {
    const r = applyEditSteps('a\nb\nc\n', [{ op: 'replace', start: 2, end: 99, text: 'x' }])
    assert.ok(!r.ok && /outside file/.test(r.reason), 'out-of-range rejected')
    ok('engine: out-of-range step rejected')
  }
  {
    const r = applyEditSteps('a\nb\nc\n', [{ op: 'replace', start: 1, end: 2, text: 'x' }, { op: 'delete', start: 2 }])
    assert.ok(!r.ok && /overlap/.test(r.reason), 'overlap rejected')
    ok('engine: overlapping ranges rejected (no guessing)')
  }
  {
    const r = applyEditSteps('a\nb\nc\n', [{ op: 'insert', after: 1, text: 'i1' }, { op: 'insert', after: 1, text: 'i2' }])
    assert.ok(!r.ok && /same boundary/.test(r.reason), 'duplicate insert boundary rejected')
    ok('engine: duplicate insert boundary rejected')
  }

  // --- engine: expect drift ---------------------------------------------------
  {
    const text = 'one\ntwo\nthree\nfour\nfive\n'
    const r = applyEditSteps(text, [{ op: 'replace', start: 1, expect: 'three', text: 'THREE' }])
    assert.ok(r.ok && r.reports[0].drift === 2 && r.text === 'one\ntwo\nTHREE\nfour\nfive\n', `drift +2, got ${JSON.stringify(r.reports[0])}`)
    ok('engine: expect drift correction downward with report')
  }
  {
    const r = applyEditSteps('a\nb\nc\n', [{ op: 'replace', start: 2, expect: 'not-present-anywhere', text: 'x' }])
    assert.ok(!r.ok && /expect anchor not found/.test(r.reason), 'unresolvable expect fails atomically')
    ok('engine: unresolvable expect aborts (atomic)')
  }
  {
    // insert anchors on `after` too
    const r = applyEditSteps('a\nb\n', [{ op: 'insert', after: 2, expect: 'a', text: 'afterA' }])
    assert.ok(r.ok && r.text === 'a\nafterA\nb\n', `insert drifted to after line 1, got ${JSON.stringify(r.text)}`)
    ok('engine: insert expect anchor drift')
  }

  // --- engine: first/last anchoring + prefixes + indent -----------------------
  {
    const text = 'function f() {\n  old1\n  old2\n}\n'
    const r = applyEditSteps(text, [{ op: 'replace', start: 1, end: 4, text: 'function f() {\n  new1\n}' }])
    assert.ok(r.ok && r.reports[0].anchorsPreserved === true, 'anchors recognized')
    assert.equal(r.text, 'function f() {\n  new1\n}\n', `interior replaced once, got ${JSON.stringify(r.text)}`)
    ok('engine: first/last anchor recognition (no boundary duplication)')
  }
  {
    const r = applyEditSteps('a\nb\n', [{ op: 'insert', after: 0, text: '1 | x\n2 | y' }])
    assert.ok(r.ok && r.text === 'x\ny\na\nb\n', `prefix stripped, got ${JSON.stringify(r.text)}`)
    ok('engine: N | prefixes stripped when all lines carry them')
  }
  {
    const r = applyEditSteps('| a | b |\n| c | d |\n', [{ op: 'insert', after: 0, text: '1 | headed\nplain tail' }])
    assert.ok(r.ok && r.text === '1 | headed\nplain tail\n| a | b |\n| c | d |\n', 'partial prefix lines preserved (markdown table safe)')
    ok('engine: prefixes kept when not universal (markdown safety)')
  }
  {
    // target with shifted indent: match is indented deeper than the probe
    const text = 'class C {\n    deepMatchedLine\n}\n'
    const r = applyEditSteps(text, [{ op: 'target', find: 'deepMatchedLine', replaceWith: 'replacedLine\nsecondLine' }])
    assert.ok(r.ok && r.reports[0].indentShifted === true, 'indent shift flagged')
    assert.equal(r.text, 'class C {\n    replacedLine\n    secondLine\n}\n', `re-indented, got ${JSON.stringify(r.text)}`)
    ok('engine: trim-tolerant target with replacement re-indentation')
  }

  // --- engine: target ambiguity + suggestions + modes -------------------------
  {
    const text = 'dup()\nother\ndup()\n'
    const r = applyEditSteps(text, [{ op: 'target', find: 'dup()', replaceWith: 'x()' }])
    assert.ok(!r.ok && r.ambiguity && r.ambiguity.candidates.length === 2, 'ambiguity surfaced with candidates')
    ok('engine: multi-match target returns candidates (atomic)')
  }
  {
    const r = applyEditSteps('alpha\nbeta\n', [{ op: 'target', find: 'betaa', replaceWith: 'x' }])
    assert.ok(!r.ok && r.reports[0].suggestions?.length >= 1 && r.reports[0].suggestions[0].line === 2, 'suggestions returned on miss')
    ok('engine: miss returns similar-line suggestions')
  }
  {
    const r = applyEditSteps('a\nzz\nb\n', [{ op: 'replace', start: 1, expect: 'zz', text: 'y' }, { op: 'replace', start: 2, expect: 'missing-anchor', text: 'x' }], { mode: 'bestEffort' })
    assert.ok(r.ok && r.text === 'a\ny\nb\n' && r.reports[1].status === 'skipped', `bestEffort skips failures, got ${JSON.stringify(r.text)}`)
    ok('engine: bestEffort skips failed steps and reports')
  }
  {
    // bestEffort ambiguity skip
    const r = applyEditSteps('dup()\ndup()\n', [{ op: 'target', find: 'dup()', replaceWith: 'x' }], { mode: 'bestEffort' })
    assert.ok(r.ok && r.reports[0].status === 'skipped', 'bestEffort skips ambiguous target')
    ok('engine: bestEffort skips ambiguous target')
  }

  // --- ledger: encoding, blobs, state -----------------------------------------
  {
    const enc = detectEncoding('a\r\nb\r\n')
    assert.equal(enc.eol, 'CRLF')
    const enc2 = detectEncoding('\uFEFFa\nb')
    assert.ok(enc2.bom && enc2.eol === 'LF')
    assert.equal(encodeText('x\ny', enc), 'x\r\ny')
    ok('ledger: EOL/BOM detect + re-encode round trip')
  }
  {
    assert.ok(looksBinary('ok\u0000binary'))
    assert.ok(!looksBinary('plain text'))
    ok('ledger: binary detection')
  }
  {
    const store = storeFor(WORK)
    const { id, bytes } = putBlob(store, Buffer.from('hello snapshot', 'utf8'))
    assert.equal(id.length, 64, 'blob id is sha256 hex')
    assert.equal(getBlob(store, id)?.toString('utf8'), 'hello snapshot')
    assert.equal(bytes, 14)
    const again = putBlob(store, Buffer.from('hello snapshot', 'utf8'))
    assert.equal(again.id, id, 'content addressing dedups')
    ok('ledger: content-addressed gzip blobs round trip + dedup')
  }
  {
    assert.equal(workspaceForFile(file('src/a.ts'), WORK), WORK, 'file under workdir → workdir store')
    const outside = path.join(path.dirname(WORK), 'outside.ts')
    assert.equal(workspaceForFile(outside, WORK), WORK, 'out-of-root file → session store')
    ok('ledger: workspace scoping for files inside/outside the session root')
  }

  // --- ffedit: reason gate + create + full governance flow ---------------------
  {
    const r = await edit.execute({ path: 'new.ts', steps: [{ op: 'insert', after: 0, text: 'export const x = 1' }], mode: 'atomic' }, exec)
    assert.ok(r.error && /reason is required/.test(r.error) && /"reason"/.test(r.error), 'missing reason rejected with copyable shape')
    ok('ffedit: reason mandatory with copy-paste error format')
  }
  {
    const r = await edit.execute({ path: 'new.ts', steps: [{ op: 'insert', after: 0, text: 'export const x = 1\n' }], reason: 'create: seed module' }, exec)
    assert.ok(!r.error, `create: ${r.error}`)
    assert.equal(r.status, 'applied')
    assert.equal(r.created, true)
    assert.equal(readFile('new.ts'), 'export const x = 1\n')
    assert.ok(r.batch >= 1, 'batch recorded')
    ok('ffedit: file creation via insert step, recorded in ledger')
  }
  {
    writeFile('store.js', 'class Store {\n  put() {}\n  get() {}\n}\n')
    const r = await edit.execute({
      path: 'store.js',
      steps: [
        { op: 'target', find: 'put() {}', replaceWith: 'put(v) {\n    this.m.set(k, v)\n  }' },
        { op: 'insert', after: 4, text: '  size() { return 0 }' },
      ],
      reason: 'feat: parameterize store write path',
    }, exec)
    assert.ok(!r.error, `edit: ${r.error}`)
    assert.equal(r.status, 'applied')
    const out = readFile('store.js')
    assert.match(out, /put\(v\) \{[\s\S]*this\.m\.set/, 'target applied')
    assert.match(out, /size\(\) \{ return 0 \}/, 'insert applied')
    assert.equal(r.reports.find((x) => x.op === 'target').symbol, 'Store.put', 'innermost enclosing symbol annotated (stage-2 weld)')
    ok('ffedit: multi-step batch with enclosing-symbol annotation')
  }
  {
    // CRLF preservation
    writeFile('crlf.txt', 'a\r\nb\r\n')
    const r = await edit.execute({ path: 'crlf.txt', steps: [{ op: 'replace', start: 1, text: 'A' }], reason: 'chore: bump' }, exec)
    assert.ok(!r.error)
    const buf = readFileSync(file('crlf.txt'), 'utf8')
    assert.equal(buf, 'A\r\nb\r\n', 'CRLF preserved byte-exact')
    ok('ffedit: CRLF preservation through edit cycle')
  }
  {
    // external modification tripwire
    writeFile('ext.txt', 'v1\n')
    await edit.execute({ path: 'ext.txt', steps: [{ op: 'replace', start: 1, text: 'v2' }], reason: 'first write' }, exec)
    // simulate an out-of-band change
    writeFileSync(file('ext.txt'), 'user-touched\n')
    const r = await edit.execute({ path: 'ext.txt', steps: [{ op: 'replace', start: 1, text: 'v3' }], reason: 'second write' }, exec)
    assert.ok(!r.error, `ext edit ok: ${r.error}`)
    assert.ok(r.externalBatch >= 1, 'external batch snapshotted before edit')
    const store = storeFor(WORK)
    const extBatch = readLedgerTail(store).find((b) => b.kind === 'external')
    assert.ok(extBatch, 'external batch in ledger')
    ok('ffedit: external-modification tripwire records an external batch')
  }
  {
    // binary refusal
    writeFileSync(file('blob.bin'), Buffer.from([0x41, 0x00, 0x42]))
    const r = await edit.execute({ path: 'blob.bin', steps: [{ op: 'insert', after: 0, text: 'x' }], reason: 'nope' }, exec)
    assert.ok(r.error && /binary/.test(r.error), 'binary refused')
    ok('ffedit: binary content refused')
  }

  // --- tickets: ambiguity → ffresolve ------------------------------------------
  let ticketId = null
  {
    writeFile('dup.js', 'function dup() {}\nmarker\nfunction dup() {}\n')
    const r = await edit.execute({ path: 'dup.js', steps: [{ op: 'target', find: 'function dup() {}', replaceWith: 'function unique() {}' }], reason: 'refactor: rename dup' }, exec)
    assert.equal(r.status, 'ticket', 'ticket signed')
    assert.equal(r.candidates.length, 2)
    assert.ok(r.candidates[0].symbol === 'dup' || r.candidates[0].symbol === null, 'candidate symbol annotated')
    ticketId = r.ticket
    const stored = loadTicket(ticketId)
    assert.ok(!('error' in stored), 'ticket persisted to disk')
    ok('ffedit: ambiguity signs a persisted ticket with annotated candidates')
  }
  {
    const bad = await resolveTool.execute({ ticket: ticketId, choice: 5 }, exec)
    assert.ok(bad.error && /choice must be/.test(bad.error), 'out-of-range choice rejected')
    const r = await resolveTool.execute({ ticket: ticketId, choice: 1 }, exec)
    assert.equal(r.status, 'applied', `resolve applied: ${JSON.stringify(r).slice(0, 200)}`)
    const out = readFile('dup.js')
    assert.equal(out.split('function unique() {}').length - 1, 1, 'exactly the chosen occurrence replaced')
    assert.ok(!existsSync(path.join(process.env.DSH_FORGE_DATA_DIR, 'tickets', `${ticketId}.json`)), 'ticket consumed on success')
    ok('ffresolve: chosen candidate applied, ticket consumed')
  }
  {
    // ticket invalidation: the chosen candidate moves away but the target
    // still exists elsewhere → invalidate + re-issue with fresh candidates
    writeFile('moved.js', 'target1\nfiller\ntarget1\n')
    const r = await edit.execute({ path: 'moved.js', steps: [{ op: 'target', find: 'target1', replaceWith: 'CHANGED' }], reason: 'rename both' }, exec)
    assert.equal(r.status, 'ticket')
    assert.deepEqual(r.candidates.map((c) => c.start), [1, 3])
    // move the file under us: candidate L1 is gone, target now lives at L2/L3
    writeFileSync(file('moved.js'), 'other\ntarget1\ntarget1\n')
    const res = await resolveTool.execute({ ticket: r.ticket, choice: 0 }, exec)
    assert.equal(res.status, 'ticket', 'invalidated ticket re-issued with fresh candidates')
    assert.deepEqual(res.candidates.map((c) => c.start), [2, 3], 'fresh candidates reflect new content')
    const fin = await resolveTool.execute({ ticket: res.ticket, choice: 1 }, exec)
    assert.equal(fin.status, 'applied')
    assert.equal(readFile('moved.js'), 'other\ntarget1\nCHANGED\n')
    ok('ffresolve: moved candidate invalidates and re-issues (forge contract)')
  }
  {
    // target gone entirely → clean error, no write
    writeFile('gone.js', 'ab\ncd\n')
    const r = await edit.execute({ path: 'gone.js', steps: [{ op: 'target', find: 'ab', replaceWith: 'x' }], reason: 'will be invalidated' }, exec)
    assert.equal(r.status, 'applied')
    writeFileSync(file('gone.js'), 'cd\nax\n')
    const r2 = await edit.execute({ path: 'gone.js', steps: [{ op: 'target', find: 'ab', replaceWith: 'y' }], reason: 'missing target' }, exec)
    assert.ok(r2.error && /not found/.test(r2.error) && /did you mean/.test(r2.error) && /L2/.test(r2.error), `miss reports suggestions: ${r2.error}`)
    ok('ffedit: vanished target errors with suggestions, nothing written')
  }

  // --- history + rollback -------------------------------------------------------
  {
    const r = await history.execute({ keyword: 'store write path' }, exec)
    assert.ok(r.items.length >= 1 && r.items[0].reason.includes('parameterize'), 'history keyword search')
    const byActor = await history.execute({ actor: 'sess_test_actor' }, exec)
    assert.ok(byActor.items.length >= 4, 'actor filter (session attribution)')
    ok('ffhistory: keyword + actor search over ledger')
  }
  {
    const batches = readLedgerTail(storeFor(WORK))
    const storeBatch = batches.find((b) => b.nodes.some((n) => n.file === 'store.js' && n.op === 'update'))
    const before = readFile('store.js')
    const plan = await rollback.execute({ batch: String(storeBatch.id), reason: 'revert: wrong direction' }, exec)
    assert.equal(plan.status, 'plan', 'dryRun is the default')
    const applied = await rollback.execute({ batch: String(storeBatch.id), dryRun: false, reason: 'revert: wrong direction' }, exec)
    assert.equal(applied.status, 'applied')
    assert.equal(readFile('store.js'), 'class Store {\n  put() {}\n  get() {}\n}\n', 'restored pre-batch content')
    assert.notEqual(before, readFile('store.js'), 'content actually changed')
    // redo by rolling back the rollback batch
    const redo = await rollback.execute({ batch: 'last', dryRun: false, reason: 'redo: direction was right after all' }, exec)
    assert.equal(redo.status, 'applied')
    assert.match(readFile('store.js'), /put\(v\)/, 'rollback-of-rollback is a redo')
    ok('ffrollback: restore + redo chain, dryRun default')
  }
  {
    // rollback of a creation deletes the file
    const r = await edit.execute({ path: 'temp-created.ts', steps: [{ op: 'insert', after: 0, text: 'x\n' }], reason: 'create temp' }, exec)
    const batches = readLedgerTail(storeFor(WORK))
    const createBatch = batches.find((b) => b.id === r.batch)
    assert.ok(createBatch, 'create batch found')
    const back = await rollback.execute({ batch: String(createBatch.id), dryRun: false, reason: 'cleanup temp' }, exec)
    assert.equal(back.status, 'applied')
    assert.ok(!existsSync(file('temp-created.ts')), 'created file removed by rollback')
    ok('ffrollback: creation rollback deletes the created file')
  }
  {
    // path-filtered rollback
    const r = await edit.execute({
      path: 'store.js',
      steps: [{ op: 'insert', after: 0, text: '// header' }],
      reason: 'add header',
    }, exec)
    writeFile('other.js', 'one\ntwo\n')
    await edit.execute({ path: 'other.js', steps: [{ op: 'insert', after: 0, text: '// other header' }], reason: 'add other header' }, exec)
    const combined = readLedgerTail(storeFor(WORK)).slice(-2)
    const multi = await rollback.execute({ batch: 'last', path: 'other.js', dryRun: false, reason: 'selective revert' }, exec)
    assert.equal(multi.status, 'applied')
    assert.equal(readFile('other.js'), 'one\ntwo\n', 'filtered file rolled back')
    assert.match(readFile('store.js'), /put\(v\)/, 'unfiltered file untouched by path-filtered rollback')
    ok('ffrollback: path filter restricts restoration')
  }

  // --- frecency feedback wiring ---------------------------------------------------
  {
    const { noteQueryHit, takeQueryFor } = await import('../lib/core.js')
    noteQueryHit(file('store.js'), 'putBlob')
    assert.equal(takeQueryFor(file('store.js')), 'putBlob')
    assert.equal(takeQueryFor(file('absent.js')), null)
    ok('core: query→file memory round trip (trackQuery feed)')
  }

  // --- status command: ledger section + prune ---------------------------------------
  {
    const { createStatusCommand } = await import('../lib/tools.js')
    const status = createStatusCommand(pool)
    const noIdx = await status.handler({ rawInput: '' })
    assert.ok(noIdx.text.includes('施工台账') && noIdx.text.includes('歧义票据'), 'ledger section even without finders')
    const pruned = await status.handler({ rawInput: 'prune' })
    assert.ok(pruned.text.includes('prune'), 'prune path runs')
    ok('/forge-status: ledger stats + tickets + prune')
  }

  // --- identity perturbation: same-name reorder vs content anchors (A.1) ----
  {
    const readSymbol = createReadSymbolTool()
    writeFile('twins.js', 'function resolve() {\n  return "first";\n}\n\nfunction resolve() {\n  return "second";\n}\n')
    const read1 = await readSymbol.execute({ path: 'twins.js', symbol: 'resolve', occurrence: 1 }, exec)
    assert.match(read1.text, /"first"/, 'occurrence=1 reads the first declaration')
    // Another actor reorders the declarations.
    writeFile('twins.js', 'function resolve() {\n  return "second";\n}\n\nfunction resolve() {\n  return "first";\n}\n')
    // The identity layer EXPOSES the flip instead of hiding it: occurrence=1
    // now carries different content, so the agent can react.
    const read1After = await readSymbol.execute({ path: 'twins.js', symbol: 'resolve', occurrence: 1 }, exec)
    assert.match(read1After.text, /"second"/)
    // Content-anchor safety: an edit composed from the PRE-reorder occurrence=1
    // body still lands on the same CONTENT wherever it now lives — never on
    // the wrong content.
    const editMoved = await edit.execute({ path: 'twins.js', steps: [{ find: 'return "first";', replaceWith: 'return "first-v2";' }], reason: 'identity-perturb' }, exec)
    assert.equal(editMoved.status, 'applied')
    const afterEdit = readFileSync(file('twins.js'), 'utf8')
    assert.match(afterEdit, /"first-v2"/)
    assert.doesNotMatch(afterEdit, /"second-v2"/)
    rmSync(file('twins.js'), { force: true })
    ok('identity perturbation: reorder flips occurrence; content anchor edits the right content, never the twin')
  }
  {
    // Stale content is refused outright — no drift window wide enough to
    // misapply an anchor whose content no longer exists.
    writeFile('stale.js', 'function solo() {\n  return 1;\n}\n')
    writeFile('stale.js', 'function solo() {\n  return 999;\n}\n')
    const refused = await edit.execute({ path: 'stale.js', steps: [{ find: 'return 1;', replaceWith: 'return 2;' }], reason: 'stale-anchor' }, exec)
    assert.ok(refused.error, `stale anchor must refuse: ${JSON.stringify(refused).slice(0, 120)}`)
    assert.doesNotMatch(readFileSync(file('stale.js'), 'utf8'), /return 2;/)
    rmSync(file('stale.js'), { force: true })
    ok('identity perturbation: stale content anchor refused, file untouched')
  }
  {
    // Identical twins (same body, same name): a matching block is genuinely
    // ambiguous — ticket, never a silent guess.
    writeFile('same.js', 'function pick() {\n  return "x";\n}\n\nfunction pick() {\n  return "x";\n}\n')
    const amb = await edit.execute({ path: 'same.js', steps: [{ find: 'return "x";', replaceWith: 'return "y";' }], reason: 'ambiguous-twins' }, exec)
    assert.equal(amb.status, 'ticket', `expected ticket: ${JSON.stringify(amb).slice(0, 120)}`)
    assert.ok(amb.ticket)
    assert.doesNotMatch(readFileSync(file('same.js'), 'utf8'), /"y"/)
    rmSync(file('same.js'), { force: true })
    ok('identity perturbation: identical twins ticket the edit instead of guessing')
  }

  await cleanup()
  console.log(`\n${passed} groups passed`)
  process.exitCode = 0
}

async function cleanup() {
  pool.disposeAll()
  try {
    rmSync(WORK, { recursive: true, force: true })
    rmSync(process.env.DSH_FORGE_DATA_DIR, { recursive: true, force: true })
  } catch {
    // temp cleanup best-effort
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
