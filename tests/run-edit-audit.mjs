/**
 * The post-edit audit: does a rename leave call sites behind, and does the
 * reply say honestly whether anything was checked?
 *
 * Load-bearing behaviours (M0.2 in docs/forge-plan-m0-m1.md):
 *
 *   findings — a rename that lands in the preload but misses renderer call
 *              sites must say so, with counts, in the same reply.
 *   honest   — a cold cache, a non-bridge file, an ordinary rename-free edit
 *              and an internal error must each be distinguishable; none of
 *              them may look like "checked and clean".
 *   weak     — the check is a name match over shipped text. A stale name in a
 *              comment hides a real miss, so a completed run is `partial`,
 *              never `passed`.
 *   safe     — the write succeeds in every one of those cases; the audit is
 *              advice and is never a precondition for the batch landing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEditTool } from '../lib/tools-edit.js'
import { createFileTool } from '../lib/tools-files.js'
import { auditEdit } from '../lib/edit-audit.js'
import { assembleTraceGraph, resetTraceFactsCache } from '../lib/tools-trace.js'

// Ledger/state stay out of the developer's real forge data directory.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-audit-data-'))
process.env.DSH_FORGE_DATA_DIR = dataDir

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const PRELOAD = (member = 'togglePin', note = null) => [
  "const { contextBridge, ipcRenderer } = require('electron')",
  ...(note ? [`// ${note}`] : []),
  'contextBridge.exposeInMainWorld(\'chartAPI\', {',
  "  listCharts: () => ipcRenderer.invoke('chart:list'),",
  `  ${member}: () => ipcRenderer.invoke('chart:toggle-pin'),`,
  '  unusedThing: () => ipcRenderer.invoke(\'chart:unused\'),',
  '})',
  '',
].join('\n')

/** Isolated workspace per scenario: these cases assert exact site counts, and a
 *  shared tree would make every later number depend on the earlier edits. */
function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-audit-'))
  const put = (rel, text) => {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  for (const [rel, text] of Object.entries(files)) put(rel, text)
  return {
    root,
    put,
    read: rel => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'),
    abs: rel => path.join(root, ...rel.split('/')),
    exec: { agent: { session: { header: { cwd: root, id: 'audit' } } }, token: {} },
    tool: createEditTool({ peekMain: () => undefined }),
    close: () => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ } },
  }
}

const CHART_CONSUMERS = {
  'renderer/panel.js': [
    'window.chartAPI.listCharts()',
    'window.chartAPI.listCharts()',
    'window.chartAPI.togglePin()',
    '',
  ].join('\n'),
  'renderer/other.js': 'window.chartAPI.togglePin()\n',
  'renderer/comment.js': [
    '// window.chartAPI.togglePin() was removed here',
    'const unrelated = { togglePin() { return 0 } }',
    'export default unrelated',
    '',
  ].join('\n'),
}

/** Every result must state what was checked; `passed` is never available. */
const assertNoFalsePass = (audit, label) => {
  assert.ok(audit, `${label}: expected an audit object`)
  assert.ok(['partial', 'not_run', 'stale'].includes(audit.status), `${label}: ${audit.status}`)
  assert.equal(typeof audit.reason, 'string', `${label}: missing reason`)
  assert.ok(audit.coverage, `${label}: missing coverage`)
  assert.ok(audit.baseline, `${label}: missing baseline identity`)
  if (audit.status !== 'partial') assert.equal(typeof audit.detail, 'string', `${label}: non-partial needs a detail`)
}

// --- case 1: a rename that strands call sites ---------------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const result = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
      replaceWith: "  pinToggle: () => ipcRenderer.invoke('chart:toggle-pin'),",
      reason: 'test: rename a bridge member without touching its callers',
    }, ws.exec)
    assert.equal(result.status, 'applied')
    const audit = result.audit
    assertNoFalsePass(audit, 'stranded rename')
    assert.equal(audit.status, 'partial')
    assert.equal(audit.reason, 'ast_diff')
    assert.equal(audit.rows.length, 1, JSON.stringify(audit))
    assert.equal(audit.rows[0].member, 'togglePin')
    // Two real call sites in two files. The third mention lives in a comment and
    // in an unrelated object, and the AST-backed graph correctly ignores both.
    assert.equal(audit.rows[0].sites, 2, JSON.stringify(audit.rows[0]))
    assert.equal(audit.rows[0].files, 2, JSON.stringify(audit.rows[0]))
    assert.match(audit.verdict, /togglePin/)
    assert.doesNotMatch(audit.verdict, /calls now fail|will fail/, 'the verdict must not claim runtime failure')
    assert.equal(audit.baseline.source, 'cached-graph')
    assert.equal(audit.baseline.snapshot, 'pre-write')
    assert.ok(audit.baseline.snapshotId, 'the baseline must name the graph that answered (M0.4)')
    assert.equal(audit.baseline.strength, 'observed', 'M0 graphs are observed, not content-bound')
    assert.deepEqual(audit.coverage.requested, ['preloads/chart.js'])
    assert.ok(audit.coverage.limitations.some(item => item.reason === 'static_references_only'), 'the remaining limitation is static resolution, not name matching')
    ok('rename that strands call sites is reported with counts and an explicit partial status')
  } finally { ws.close() }
}

// --- case 2: a member with no consumers → checked, nothing stranded ----------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const result = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  unusedThing: () => ipcRenderer.invoke('chart:unused'),",
      replaceWith: "  unusedThingRenamed: () => ipcRenderer.invoke('chart:unused'),",
      reason: 'test: rename a member no consumer uses',
    }, ws.exec)
    assert.equal(result.status, 'applied')
    const audit = result.audit
    assertNoFalsePass(audit, 'clean rename')
    assert.equal(audit.status, 'partial')
    assert.equal(audit.reason, 'ast_diff')
    assert.deepEqual(audit.rows, [])
    assert.deepEqual(audit.globals, [])
    assert.match(audit.verdict, /no statically visible consumer/)
    ok('a batch that strands nothing reports a completed check, not silence')
  } finally { ws.close() }
}

// --- case 3: a whole global renamed away -------------------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const result = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "contextBridge.exposeInMainWorld('chartAPI', {",
      replaceWith: "contextBridge.exposeInMainWorld('chartsAPI', {",
      reason: 'test: rename the exposed global itself',
    }, ws.exec)
    assert.equal(result.status, 'applied')
    const audit = result.audit
    assertNoFalsePass(audit, 'global rename')
    assert.equal(audit.globals.length, 1, JSON.stringify(audit))
    assert.equal(audit.globals[0].object, 'chartAPI')
    // Every member site breaks at once: panel.js three (listCharts twice,
    // togglePin once) and other.js one.
    assert.equal(audit.globals[0].sites, 4, JSON.stringify(audit.globals[0]))
    ok('renaming the global itself reports every member site at once')
  } finally { ws.close() }
}

// --- case 4: no cached graph → not_run/no_baseline, write still succeeds -----
{
  const ws = workspace({ 'solo.js': 'const a = 1\n' })
  try {
    resetTraceFactsCache()
    const result = await ws.tool.execute({
      path: 'solo.js',
      find: 'const a = 1',
      replaceWith: 'const a = 2',
      reason: 'test: edit with no trace graph cached',
    }, ws.exec)
    assert.equal(result.status, 'applied')
    assertNoFalsePass(result.audit, 'cold cache')
    assert.equal(result.audit.status, 'not_run')
    assert.equal(result.audit.reason, 'no_baseline')
    assert.equal(result.audit.baseline.source, 'none')
    assert.equal(ws.read('solo.js').trim(), 'const a = 2')
    ok('a cold cache is reported as not run, and the write still lands')
  } finally { ws.close() }
}

// --- case 5: edits outside the bridge surface --------------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS, 'util/plain.js': 'const x = 1\n' })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const consumerEdit = await ws.tool.execute({
      path: 'renderer/other.js',
      find: 'window.chartAPI.togglePin()',
      replaceWith: 'window.chartAPI.pinToggle()',
      reason: 'test: an ordinary edit in a consumer file',
    }, ws.exec)
    assert.equal(consumerEdit.status, 'applied')
    assertNoFalsePass(consumerEdit.audit, 'consumer file')
    // This edit introduces a call to a member the provider does not offer. Since
    // M1.2 the audit resolves that from the AST instead of asking whether a name
    // disappeared from the edited text, so it is a finding — and correctly
    // attributed to this batch.
    assert.equal(consumerEdit.audit.status, 'partial')
    assert.equal(consumerEdit.audit.reason, 'ast_diff')
    assert.equal(consumerEdit.audit.rows.length, 1, JSON.stringify(consumerEdit.audit))
    assert.equal(consumerEdit.audit.rows[0].member, 'pinToggle')
    assert.match(consumerEdit.audit.rows[0].sample[0], /renderer\/other\.js/)

    // A provider edit that keeps its surface intact is a completed diff that
    // broke nothing — reported as such, not as "nothing was checked".
    const cleanEdit = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  listCharts: () => ipcRenderer.invoke('chart:list'),",
      replaceWith: "  listCharts: () => ipcRenderer.invoke('chart:list') ,",
      reason: 'test: a whitespace-only provider edit',
    }, ws.exec)
    assert.equal(cleanEdit.status, 'applied', cleanEdit.error)
    assertNoFalsePass(cleanEdit.audit, 'clean provider edit')
    assert.equal(cleanEdit.audit.reason, 'ast_diff')
    assert.deepEqual(cleanEdit.audit.rows, [])
    assert.deepEqual(cleanEdit.audit.globals, [])
    assert.match(cleanEdit.audit.verdict, /no statically visible consumer/)

    // A file with no bridge surface on either side is genuinely not applicable.
    const plainAfter = await ws.tool.execute({
      path: 'util/plain.js',
      find: 'const x = 1',
      replaceWith: 'const x = 2',
      reason: 'test: a file with no bridge surface',
    }, ws.exec)
    assert.equal(plainAfter.status, 'applied', plainAfter.error)
    assert.equal(plainAfter.audit.status, 'not_run')
    assert.equal(plainAfter.audit.reason, 'not_applicable')
    assert.match(plainAfter.audit.detail, /no bridge surface/)
    ok('consumer-side breakage is a finding; a surface-preserving edit is a completed diff; no surface is not_applicable')
  } finally { ws.close() }
}

// --- case 6: a file outside the Trace scan set --------------------------------
{
  const ws = workspace({ 'Program.cs': 'class Program { static void Main() { } }\n' })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const result = await ws.tool.execute({
      path: 'Program.cs',
      find: 'class Program',
      replaceWith: 'class Program2',
      reason: 'test: a language Trace does not scan',
    }, ws.exec)
    assert.equal(result.status, 'applied')
    assertNoFalsePass(result.audit, 'unscanned language')
    assert.equal(result.audit.status, 'not_run')
    assert.equal(result.audit.reason, 'not_applicable')
    assert.match(result.audit.detail, /outside the Trace scan set/)
    ok('a .cs edit is not_applicable rather than silently skipped')
  } finally { ws.close() }
}

// --- case 7: a file that ships a syntax error --------------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const result = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  unusedThing: () => ipcRenderer.invoke('chart:unused'),",
      replaceWith: "  unusedThingRenamed: () => ipcRenderer.invoke('chart:unused'), }}}",
      reason: 'test: rename a member and leave a syntax error behind',
    }, ws.exec)
    assert.equal(result.status, 'applied')
    assert.ok(result.syntaxWarning, 'the batch reports the syntax warning itself')
    assertNoFalsePass(result.audit, 'syntax error')
    assert.equal(result.audit.status, 'partial')
    assert.ok(result.audit.coverage.limitations.some(item => item.reason === 'shipped_text_syntax_warning'))
    ok('a shipped syntax error downgrades the audit and is recorded in coverage')
  } finally { ws.close() }
}

// --- case 8: the audit reads bytes and facts, never the requested steps ------
{
  // M1.2 replaced the text heuristic with an AST diff, so the batch's `find` /
  // `replaceWith` strings are no longer an input. That is the point: the answer
  // is derived from what the file now contains, not from what a caller claimed
  // it was changing. A step whose fields explode must therefore change nothing.
  const ws = workspace({ 'preloads/chart.js': PRELOAD() })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const poisoned = [{ get find() { throw new Error('steps must not be read') } }]
    const audit = await auditEdit(ws.root, 'preloads/chart.js', poisoned, ws.abs('preloads/chart.js'))
    assertNoFalsePass(audit, 'steps are not an input')
    assert.notEqual(audit.reason, 'audit_error', audit.detail)
    assert.equal(audit.reason, 'ast_diff')
    ok('the audit derives its answer from the file, not from the requested steps')

    // A file that vanished after commit is a stated reason, never silence and
    // never a clean bill.
    const gone = await auditEdit(ws.root, 'preloads/chart.js', [], ws.abs('preloads/missing.js'))
    assertNoFalsePass(gone, 'missing file')
    assert.equal(gone.status, 'not_run')
    assert.match(gone.detail, /no longer exists/)
    ok('an unreadable edited file is reported as not run with its reason')
  } finally { ws.close() }
}

// --- case 9: a name in a comment does not hide a real miss -------------------
{
  // Under the old text heuristic, the member name surviving in the preload's own
  // comment made the miss invisible: the check searched the shipped text for the
  // name and found it. The AST diff reads the object literal, so a comment is not
  // evidence of a provided member.
  const ws = workspace({ 'preloads/chart.js': PRELOAD('togglePin', 'togglePin note: keep the pin state across the session'), ...CHART_CONSUMERS })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const result = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
      replaceWith: "  pinned: () => ipcRenderer.invoke('chart:toggle-pin'),",
      reason: 'test: rename a member whose old name still appears in a comment',
    }, ws.exec)
    assert.equal(result.status, 'applied')
    const audit = result.audit
    assertNoFalsePass(audit, 'comment blind spot')
    assert.equal(audit.status, 'partial')
    assert.equal(audit.rows.length, 1, JSON.stringify(audit.rows))
    assert.equal(audit.rows[0].member, 'togglePin')
    assert.equal(audit.rows[0].sites, 2, JSON.stringify(audit.rows[0]))
    assert.doesNotMatch(audit.verdict, /passed|verified/, 'a diff may not claim runtime verification')
    ok('a name surviving only in a comment no longer hides the miss')
  } finally { ws.close() }
}

// --- case 10: a later writer owns the bytes → stale --------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const steps = [{ find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),", replaceWith: "  pinToggle: () => ipcRenderer.invoke('chart:toggle-pin')," }]
    const result = await ws.tool.execute({
      path: 'preloads/chart.js',
      ...steps[0],
      reason: 'test: rename, then let another writer touch the file',
    }, ws.exec)
    assert.equal(result.status, 'applied')
    // Someone else writes after the batch committed.
    fs.appendFileSync(ws.abs('preloads/chart.js'), '\n// later writer\n')
    const audit = await auditEdit(ws.root, 'preloads/chart.js', steps, ws.abs('preloads/chart.js'), { hash: result.hash })
    assertNoFalsePass(audit, 'stale bytes')
    assert.equal(audit.status, 'stale')
    assert.equal(audit.reason, 'stale')
    assert.match(audit.detail, /changed again/)
    assert.deepEqual(audit.rows, [])
    ok('bytes changed after commit are stale, not attributed to this batch')
  } finally { ws.close() }
}

// --- case 11: a ticket reply audits exactly like a direct edit ---------------
{
  // Two identical find blocks force an ambiguity ticket; answering it must not
  // change the audit story relative to the same edit sent directly.
  const PRELOAD_TWICE = [
    "const { contextBridge, ipcRenderer } = require('electron')",
    "contextBridge.exposeInMainWorld('chartAPI', {",
    "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
    "})",
    "contextBridge.exposeInMainWorld('chartAPI', {",
    "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
    '})',
    '',
  ].join('\n')
  const ws = workspace({ 'preloads/chart.js': PRELOAD_TWICE, ...CHART_CONSUMERS })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const asked = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
      replaceWith: "  pinToggle: () => ipcRenderer.invoke('chart:toggle-pin'),",
      reason: 'test: ambiguous rename becomes a ticket',
    }, ws.exec)
    assert.equal(asked.status, 'ticket')
    assert.equal(asked.audit, undefined, 'a ticket wrote nothing, so it must carry no audit')
    const answered = await ws.tool.execute({ ticket: asked.ticket, choice: 'all' }, ws.exec)
    assert.equal(answered.status, 'applied', answered.error)
    assertNoFalsePass(answered.audit, 'ticket reply')
    assert.equal(answered.audit.status, 'partial')
    assert.equal(answered.audit.reason, 'ast_diff')
    // This fixture exposes `chartAPI` twice, so the provider binding is
    // ambiguous. The diff refuses to pick one and report a guess; what it must
    // do is *say* it could not decide, and never read as a clean pass.
    assert.deepEqual(answered.audit.rows, [])
    assert.match(answered.audit.verdict, /ambiguous|无法|多个/)
    ok('a ticket reply audits identically, and an ambiguous provider is stated rather than guessed')
  } finally { ws.close() }
}

// --- case 12: no change written → no audit ----------------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const result = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  unusedThing: () => ipcRenderer.invoke('chart:unused'),",
      replaceWith: "  unusedThing: () => ipcRenderer.invoke('chart:unused'),",
      reason: 'test: replacement identical to the match',
    }, ws.exec)
    assert.equal(result.status, 'applied')
    assert.match(result.note ?? '', /content identical/)
    assert.equal(result.audit, undefined, 'nothing was written, so nothing may claim to be rechecked')
    ok('a no-change batch reports no audit instead of a clean check')
  } finally { ws.close() }
}

// --- case 13: several steps in one batch share one audit --------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS })
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const result = await ws.tool.execute({
      path: 'preloads/chart.js',
      steps: [
        { find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),", replaceWith: "  pinToggle: () => ipcRenderer.invoke('chart:toggle-pin')," },
        { find: "  unusedThing: () => ipcRenderer.invoke('chart:unused'),", replaceWith: '  spareThing: () => 0,' },
      ],
      reason: 'test: two renames in one batch',
    }, ws.exec)
    assert.equal(result.status, 'applied', result.error)
    assert.equal(result.applied, 2)
    assertNoFalsePass(result.audit, 'multi-step')
    assert.equal(result.audit.rows.length, 1, JSON.stringify(result.audit.rows))
    assert.equal(result.audit.rows[0].member, 'togglePin')
    ok('one batch produces one audit, not one per step')
  } finally { ws.close() }
}

// --- case 14: ff_file goes through the same exit ----------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS })
  const files = createFileTool()
  try {
    resetTraceFactsCache()
    await assembleTraceGraph(ws.root)
    const created = await files.execute({ action: 'create', path: 'preloads/extra.js', content: 'module.exports = 1\n', reason: 'test: create through ff_file' }, ws.exec)
    assert.equal(created.batch > 0, true, JSON.stringify(created))
    assertNoFalsePass(created.audit, 'ff_file create')
    assert.equal(created.audit.status, 'not_run')
    assert.equal(created.audit.reason, 'not_applicable')
    assert.deepEqual(created.audit.coverage.requested, ['preloads/extra.js'])
    assert.match(created.audit.detail, /create/)

    const moved = await files.execute({ action: 'move', path: 'renderer/other.js', destination: 'renderer/other-moved.js', reason: 'test: move through ff_file' }, ws.exec)
    assert.equal(moved.batch > 0, true, JSON.stringify(moved))
    assertNoFalsePass(moved.audit, 'ff_file move')
    assert.deepEqual(moved.audit.coverage.requested.sort(), ['renderer/other-moved.js', 'renderer/other.js'])
    ok('ff_file reports not_applicable for its operations instead of staying silent')
  } finally { ws.close() }
}

// --- case 15: a named snapshot gates the write ------------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), ...CHART_CONSUMERS })
  const files = createFileTool()
  try {
    resetTraceFactsCache()
    const captured = await assembleTraceGraph(ws.root, { capture: true })
    assert.equal(captured.capture?.persisted, true, captured.capture?.saveError ?? 'capture must persist')
    const id = captured.snapshot.snapshotId

    // Unchanged file: the write is allowed and says what it was checked against.
    const allowed = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  unusedThing: () => ipcRenderer.invoke('chart:unused'),",
      replaceWith: '  spareThing: () => 0,',
      reason: 'test: edit authorized by a capture baseline',
      snapshotId: id,
    }, ws.exec)
    assert.equal(allowed.status, 'applied', allowed.error)
    assert.deepEqual(allowed.beforeEvidence, { snapshotId: id, verified: true })

    // The file is not the captured file any more: the same id must now refuse,
    // and the refusal must leave the file alone.
    const drifted = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: '  spareThing: () => 0,',
      replaceWith: '  spareThing: () => 1,',
      reason: 'test: edit refused after drift',
      snapshotId: id,
    }, ws.exec)
    assert.notEqual(drifted.error, undefined, 'drift must refuse the write')
    assert.match(drifted.error, /drift/)
    assert.equal(ws.read('preloads/chart.js').includes('spareThing: () => 0,'), true, 'a refused write changes nothing')

    // A file the capture never read is not_covered — not a pass, not a block on
    // ordinary editing. `renderer/panel.js` was captured, so use a file created
    // after the capture: the baseline demonstrably predates it.
    ws.put('renderer/late.js', 'window.chartAPI.listCharts()\n')
    const uncovered = await ws.tool.execute({
      path: 'renderer/late.js',
      find: 'window.chartAPI.listCharts()',
      replaceWith: 'window.chartAPI.listCharts()',
      reason: 'test: file created after the capture',
      snapshotId: id,
    }, ws.exec)
    assert.match(uncovered.error ?? '', /not_covered/)

    // An observed-only snapshot has no per-file hash to offer.
    const observed = await assembleTraceGraph(ws.root)
    const weak = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: '  spareThing: () => 0,',
      replaceWith: '  spareThing: () => 2,',
      reason: 'test: observed-only snapshot',
      snapshotId: observed.snapshot.snapshotId,
    }, ws.exec)
    assert.match(weak.error ?? '', /observed_only/)

    // Omitting snapshotId stays an ordinary edit.
    const plain = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: '  spareThing: () => 0,',
      replaceWith: '  spareThing: () => 3,',
      reason: 'test: ordinary edit without a baseline',
    }, ws.exec)
    assert.equal(plain.status, 'applied', plain.error)
    assert.equal(plain.beforeEvidence, undefined)

    // ff_file: a create is expected to be absent, so creating a new file under
    // a baseline succeeds; overwriting a captured file as a "create" is refused.
    const created = await files.execute({ action: 'create', path: 'preloads/new.js', content: 'module.exports = 2\n', reason: 'test: create under a baseline', snapshotId: id }, ws.exec)
    assert.equal(created.batch > 0, true, JSON.stringify(created))
    const covered = await files.execute({ action: 'create', path: 'preloads/chart.js', content: 'module.exports = 3\n', overwrite: true, reason: 'test: create over a captured file', snapshotId: id }, ws.exec)
    assert.notEqual(covered.error, undefined, 'a create over a captured file must be refused')
    // Re-capture so the file is again exactly what a baseline describes; then the
    // refusal is specifically "this is an overwrite, not a create".
    const fresh = await assembleTraceGraph(ws.root, { capture: true })
    const overCaptured = await files.execute({ action: 'create', path: 'preloads/chart.js', content: 'module.exports = 3\n', overwrite: true, reason: 'test: overwrite a captured file as create', snapshotId: fresh.snapshot.snapshotId }, ws.exec)
    assert.match(overCaptured.error ?? '', /overwrite|covers/)
    assert.equal(ws.read('preloads/chart.js').includes('module.exports = 3'), false, 'the refused create wrote nothing')
    ok('a snapshotId gates the write: verified passes, drift/observed/not_covered refuse by name')
  } finally { ws.close() }
}

console.log(`\n${passed} post-edit audit groups passed`)
try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
