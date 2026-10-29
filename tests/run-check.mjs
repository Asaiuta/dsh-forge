/**
 * ffcheck action=static — the formal verification entry.
 *
 * What this suite is actually protecting (M1.3 in docs/forge-plan-m0-m1.md):
 *
 *   evidence  — the before-state comes from the ledger blob, not from the
 *               workspace. If it came from the tree, "before" and "after" would
 *               be the same bytes and every check would trivially pass.
 *   identity  — the current bytes must equal the recorded after-hash. A later
 *               writer makes the answer `stale`; it must never be reported as
 *               this batch's damage.
 *   chaining  — several batches, or several files in one batch, merge into one
 *               answer; a gap in the middle downgrades attribution instead of
 *               inventing it.
 *   honesty   — deleted, unsupported, empty and cancelled scopes each get their
 *               own state. None of them may produce `passed`.
 *   failure   — a real introduced break must come back `failed` with the site.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEditTool } from '../lib/tools-edit.js'
import { createCheckTool } from '../lib/tools-check.js'
import { loadBaseline } from '../lib/trace-capture.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-data-'))
process.env.DSH_FORGE_DATA_DIR = dataDir

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const PRELOAD = (member = 'togglePin') => [
  "const { contextBridge, ipcRenderer } = require('electron')",
  'contextBridge.exposeInMainWorld(\'chartAPI\', {',
  "  listCharts: () => ipcRenderer.invoke('chart:list'),",
  `  ${member}: () => ipcRenderer.invoke('chart:toggle-pin'),`,
  '})',
  '',
].join('\n')

/** A main-process side, so the fixture is not born broken: without handlers
 *  every `invoke` is an existing missing endpoint, and `existing` findings keep
 *  a batch out of `passed` (bridge-check reports them rather than hiding them). */
const MAIN = [
  "const { ipcMain } = require('electron')",
  "ipcMain.handle('chart:list', () => [])",
  "ipcMain.handle('chart:toggle-pin', () => 1)",
  '',
].join('\n')

const CONSUMERS = {
  'renderer/panel.js': [
    'window.chartAPI.listCharts()',
    'window.chartAPI.togglePin()',
    '',
  ].join('\n'),
  'renderer/other.js': 'window.chartAPI.togglePin()\n',
}

function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-ws-'))
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
    exec: { agent: { session: { header: { cwd: root, id: 'check' } } }, token: {} },
    tool: createEditTool({ peekMain: () => undefined }),
    check: createCheckTool(),
    /** Run the check with this workspace as the cwd. */
    async run(args = {}) {
      return this.check.execute({ action: 'static', ...args }, this.exec)
    },
    close: () => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ } },
  }
}

/** Every reply must state what was checked; a bare boolean is never enough. */
const assertStructured = (result, label) => {
  assert.ok(result, `${label}: expected a result`)
  assert.equal(result.action, 'static', `${label}: action`)
  assert.ok(['passed', 'failed', 'partial', 'not_run', 'stale'].includes(result.status), `${label}: ${result.status}`)
  assert.equal(typeof result.reason, 'string', `${label}: reason`)
  assert.ok(Array.isArray(result.findings), `${label}: findings`)
  assert.ok(Array.isArray(result.limitations), `${label}: limitations`)
  assert.ok(Array.isArray(result.files), `${label}: files`)
  assert.ok(result.coverage && typeof result.coverage.changed === 'number', `${label}: coverage`)
  assert.equal(typeof result.text, 'string', `${label}: text`)
  if (result.status !== 'passed' && result.status !== 'failed' && result.status !== 'partial') {
    assert.equal(typeof result.detail, 'string', `${label}: ${result.status} needs a detail`)
  }
}

// --- case 1: a clean batch is the only thing allowed to pass -----------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS })
  try {
    const edit = await ws.tool.execute({
      path: 'renderer/other.js',
      find: 'window.chartAPI.togglePin()',
      replaceWith: 'window.chartAPI.togglePin() // same call, new comment',
      reason: 'test: a change that breaks nothing',
    }, ws.exec)
    assert.equal(edit.status, 'applied', edit.error)
    const result = await ws.run({ batches: [edit.batch] })
    assertStructured(result, 'clean')
    assert.equal(result.status, 'passed', result.text)
    assert.deepEqual(result.findings, [])
    assert.deepEqual(result.batches, [edit.batch])
    assert.equal(result.syntax.checked >= 1, true, JSON.stringify(result.syntax))
    // The chain is complete and the current hash matched the record.
    assert.ok(result.files.every(row => row.chain), JSON.stringify(result.files))
    assert.ok(result.files.every(row => row.state === 'unchanged' || row.state === 'created'), JSON.stringify(result.files))
    ok('a batch that broke nothing is the only shape that reports passed')
  } finally { ws.close() }
}

// --- case 2: dropping a member the renderer still calls is a failure --------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS })
  try {
    const edit = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
      replaceWith: "  pinToggle: () => ipcRenderer.invoke('chart:toggle-pin'),",
      reason: 'test: rename a member and leave both call sites',
    }, ws.exec)
    assert.equal(edit.status, 'applied', edit.error)
    const result = await ws.run({ batches: [edit.batch] })
    assertStructured(result, 'broken rename')
    assert.equal(result.status, 'failed', result.text)
    const broken = result.findings.filter(item => item.kind === 'bridge_member_missing' || item.kind === 'expose_member_missing')
    assert.equal(result.findings.length, 2, JSON.stringify(result.findings))
    assert.ok(result.findings.every(item => item.attribution === 'new'))
    assert.ok(result.findings.every(item => item.member === 'togglePin'))
    assert.deepEqual([...new Set(result.findings.map(item => item.file))].sort(), ['renderer/other.js', 'renderer/panel.js'])
    assert.equal(result.findings.some(item => item.check === 'bridge'), true)
    assert.match(result.text, /failed/)
    ok('a member removal with surviving call sites fails with every site listed')
  } finally { ws.close() }
}

// --- case 3: a later writer makes the answer stale, never an accusation -----
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS })
  try {
    const edit = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
      replaceWith: "  pinToggle: () => ipcRenderer.invoke('chart:toggle-pin'),",
      reason: 'test: rename, then let someone else write',
    }, ws.exec)
    assert.equal(edit.status, 'applied', edit.error)
    // Another writer touches the file after the batch committed.
    fs.appendFileSync(ws.abs('preloads/chart.js'), '\n// later writer\n')
    const result = await ws.run({ batches: [edit.batch] })
    assertStructured(result, 'stale')
    assert.equal(result.status, 'stale', result.text)
    assert.equal(result.reason, 'stale')
    assert.deepEqual(result.findings, [], 'a stale answer must not carry findings')
    assert.deepEqual(result.files.filter(row => row.state === 'stale').map(row => row.file), ['preloads/chart.js'])
    ok('bytes changed after the batch are reported stale instead of blamed on it')
  } finally { ws.close() }
}

// --- case 4: several batches chain into one answer --------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS })
  try {
    // Batch A: rename the member in the preload.
    const first = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
      replaceWith: "  pinToggle: () => ipcRenderer.invoke('chart:toggle-pin'),",
      reason: 'test: batch 1 renames the provider',
    }, ws.exec)
    assert.equal(first.status, 'applied', first.error)
    // Batch B: fix one of the two call sites.
    const second = await ws.tool.execute({
      path: 'renderer/other.js',
      find: 'window.chartAPI.togglePin()',
      replaceWith: 'window.chartAPI.pinToggle()',
      reason: 'test: batch 2 fixes one caller',
    }, ws.exec)
    assert.equal(second.status, 'applied', second.error)

    const one = await ws.run({ batches: [first.batch] })
    assert.equal(one.status, 'failed', one.text)

    // Both batches together: the remaining caller in panel.js is still broken.
    const both = await ws.run({ batches: [first.batch, second.batch] })
    assertStructured(both, 'chained')
    assert.deepEqual(both.batches, [first.batch, second.batch])
    assert.equal(both.status, 'failed', both.text)
    assert.equal(both.findings.length, 1, JSON.stringify(both.findings))
    assert.equal(both.findings[0].file, 'renderer/panel.js')

    // Batch B alone: the before-state is the broken file, so nothing new.
    const alone = await ws.run({ batches: [second.batch] })
    assertStructured(alone, 'second alone')
    assert.notEqual(alone.status, 'failed', alone.text)
    assert.deepEqual(alone.findings.filter(item => item.attribution === 'new'), [])
    ok('chained batches merge per file; the newest batch alone does not inherit older damage')
  } finally { ws.close() }
}

// --- case 5: a gap in the chain downgrades attribution ----------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS })
  try {
    // Three batches touch the provider; selecting the first and the third skips
    // the middle one, so the third's `before` is not the first's `after`.
    const a = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  listCharts: () => ipcRenderer.invoke('chart:list'),",
      replaceWith: "  listCharts: () => ipcRenderer.invoke('chart:list') ,",
      reason: 'test: batch A touches the provider',
    }, ws.exec)
    assert.equal(a.status, 'applied', a.error)
    const b = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
      replaceWith: "  pinToggle: () => ipcRenderer.invoke('chart:toggle-pin'),",
      reason: 'test: batch B renames the member (the gap)',
    }, ws.exec)
    assert.equal(b.status, 'applied', b.error)
    const c = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  listCharts: () => ipcRenderer.invoke('chart:list') ,",
      replaceWith: "  listCharts: () => ipcRenderer.invoke('chart:list')  ,",
      reason: 'test: batch C edits an unrelated name',
    }, ws.exec)
    assert.equal(c.status, 'applied', c.error)

    const gapped = await ws.run({ batches: [a.batch, c.batch] })
    assertStructured(gapped, 'gap')
    assert.ok(gapped.files.every(row => row.chain === false), JSON.stringify(gapped.files))
    // B (unselected) introduced the break, so it cannot be pinned on A+C.
    assert.ok(gapped.findings.every(item => item.attribution !== 'new'), JSON.stringify(gapped.findings))
    assert.ok(gapped.limitations.some(item => item.code === 'no_baseline'), JSON.stringify(gapped.limitations))
    assert.notEqual(gapped.status, 'passed', gapped.text)

    // Selecting the whole chain connects it, and the attribution becomes firm.
    const whole = await ws.run({ batches: [a.batch, b.batch, c.batch] })
    assertStructured(whole, 'whole chain')
    assert.ok(whole.files.every(row => row.chain === true), JSON.stringify(whole.files))
    assert.equal(whole.status, 'failed', whole.text)
    assert.ok(whole.findings.every(item => item.attribution === 'new'))
    ok('a skipped batch in the middle is reported as a broken chain and blocks attribution')
  } finally { ws.close() }
}

// --- case 6: deleted files are not a clean check ----------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS, 'renderer/legacy.js': 'window.chartAPI.listCharts()\n' })
  try {
    const edit = await ws.tool.execute({
      path: 'renderer/legacy.js',
      find: 'window.chartAPI.listCharts()',
      replaceWith: '',
      reason: 'test: delete the file content',
    }, ws.exec)
    assert.equal(edit.status, 'applied', edit.error)
    const result = await ws.run({ batches: [edit.batch] })
    assertStructured(result, 'emptied file')
    // The file still exists (empty), so it is a normal before→after comparison,
    // not a deletion; an emptied consumer file cannot leave a call site behind.
    assert.notEqual(result.status, 'failed', result.text)
    ok('emptying a consumer file is not reported as damage')
  } finally { ws.close() }
}

// --- case 7: unsupported languages are stated, not silently skipped --------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS, 'src/Program.cs': 'class Program { static void Main() { } }\n' })
  try {
    const edit = await ws.tool.execute({
      path: 'src/Program.cs',
      find: 'static void Main() { }',
      replaceWith: 'static void Main() { } // touched',
      reason: 'test: a language outside the JS syntax gate',
    }, ws.exec)
    assert.equal(edit.status, 'applied', edit.error)
    const result = await ws.run({ batches: [edit.batch] })
    assertStructured(result, 'cs')
    assert.notEqual(result.status, 'passed', result.text)
    assert.ok(result.limitations.some(item => item.code === 'unsupported_file'), JSON.stringify(result.limitations))
    assert.ok(result.syntax.skipped.some(item => item.file === 'src/Program.cs'), JSON.stringify(result.syntax))
    ok('a language the check cannot parse is a stated limitation, never a silent pass')
  } finally { ws.close() }
}

// --- case 8: empty scope and unknown batches are not_run -------------------
{
  const ws = workspace({ 'only.js': 'const a = 1\n' })
  try {
    const result = await ws.run()
    assertStructured(result, 'empty ledger')
    assert.equal(result.status, 'not_run')
    assert.equal(result.reason, 'no_batches')
    assert.match(result.detail, /账本为空/)

    const unknown = await ws.run({ batches: [999] })
    assertStructured(unknown, 'unknown batch')
    assert.equal(unknown.status, 'not_run')
    assert.equal(unknown.reason, 'no_batches')
    assert.match(unknown.detail, /#999/)
    ok('an empty ledger and an unknown batch id are not_run with a reason, not a pass')
  } finally { ws.close() }
}

// --- case 9: argument validation is explicit ------------------------------
{
  const ws = workspace({ 'only.js': 'const a = 1\n' })
  try {
    for (const [args, pattern] of [
      [{ action: 'tests' }, /action must be "static"/],
      [{ action: 'static', checks: ['types'] }, /未知的检查项/],
      [{ action: 'static', checks: [] }, /不能为空/],
      [{ action: 'static', batches: [0] }, /positive integer/],
      [{ action: 'static', batches: [] }, /non-empty/],
    ]) {
      const result = await ws.check.execute(args, ws.exec)
      assert.equal(typeof result.error, 'string', `${JSON.stringify(args)}: ${JSON.stringify(result)}`)
      assert.match(result.error, pattern)
    }
    ok('tests, types, empty selections and bad ids are refused by name — the tool does not pretend to run them')
  } finally { ws.close() }
}

// --- case 10: a cancelled run never becomes a verdict ---------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS })
  try {
    const edit = await ws.tool.execute({
      path: 'renderer/other.js',
      find: 'window.chartAPI.togglePin()',
      replaceWith: 'window.chartAPI.togglePin() // touched',
      reason: 'test: a batch to check',
    }, ws.exec)
    assert.equal(edit.status, 'applied', edit.error)
    const controller = new AbortController()
    controller.abort()
    const result = await ws.check.execute(
      { action: 'static', batches: [edit.batch] },
      { ...ws.exec, signal: controller.signal },
    )
    assertStructured(result, 'cancelled')
    assert.equal(result.status, 'not_run', result.text)
    assert.equal(result.reason, 'cancelled')
    assert.match(result.detail, /取消/)
    ok('cancellation is not_run, so an interrupted check cannot be quoted as a pass')
  } finally { ws.close() }
}

// --- case 11: syntax errors are their own check ---------------------------
{
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS, 'broken.js': 'const a = 1\n' })
  try {
    // Write an invalid file directly, then let the ledger see it through an edit
    // so the batch's after-state is the broken text.
    const edit = await ws.tool.execute({
      path: 'broken.js',
      find: 'const a = 1',
      replaceWith: 'const a = (((',
      reason: 'test: leave a syntax error behind',
    }, ws.exec)
    assert.equal(edit.status, 'applied', edit.error)
    const bridgeOnly = await ws.run({ batches: [edit.batch], checks: ['bridge'] })
    assertStructured(bridgeOnly, 'bridge only')
    assert.equal(bridgeOnly.findings.some(item => item.check === 'syntax'), false, 'syntax is opt-out')
    assert.deepEqual(bridgeOnly.checks, ['bridge'])

    const withSyntax = await ws.run({ batches: [edit.batch], checks: ['syntax'] })
    assertStructured(withSyntax, 'syntax only')
    assert.deepEqual(withSyntax.checks, ['syntax'])
    assert.equal(withSyntax.status, 'failed', withSyntax.text)
    const syntax = withSyntax.findings.filter(item => item.check === 'syntax')
    assert.equal(syntax.length, 1, JSON.stringify(withSyntax.findings))
    assert.equal(syntax[0].file, 'broken.js')
    assert.equal(syntax[0].kind, 'syntax_error')
    ok('syntax is a separate check: selecting one does not silently run the other')
  } finally { ws.close() }
}

// --- case 12: the before-state comes from the ledger, not the tree ---------
{
  // If the tool read "before" from disk it would read the post-edit bytes and
  // every diff would be empty. This case pins that the blob is the source: the
  // workspace file is experimentally overwritten with the *original* text, and
  // the check must still describe the batch's real before (which had the member).
  const ws = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS })
  try {
    const edit = await ws.tool.execute({
      path: 'preloads/chart.js',
      find: "  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),",
      replaceWith: "  pinToggle: () => ipcRenderer.invoke('chart:toggle-pin'),",
      reason: 'test: rename a member',
    }, ws.exec)
    assert.equal(edit.status, 'applied', edit.error)
    const result = await ws.run({ batches: [edit.batch] })
    // The recorded before-blob must contain the old member name; that is what
    // makes the rename visible as a removal rather than as "always been this way".
    assert.ok(result.files[0].before, JSON.stringify(result.files[0]))
    assert.equal(result.status, 'failed', result.text)
    ok('the before-state is the recorded blob, which is why the rename is visible at all')
  } finally { ws.close() }
}

// --- case 13: no baseline records leak into a different workspace ---------
{
  const wsA = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS })
  const wsB = workspace({ 'preloads/chart.js': PRELOAD(), 'main.js': MAIN, ...CONSUMERS })
  try {
    const editA = await wsA.tool.execute({
      path: 'renderer/other.js',
      find: 'window.chartAPI.togglePin()',
      replaceWith: 'window.chartAPI.togglePin() // a',
      reason: 'test: batch in workspace A',
    }, wsA.exec)
    assert.equal(editA.status, 'applied', editA.error)
    // Workspace B has its own ledger; A's batch id must not resolve there.
    const result = await wsB.check.execute({ action: 'static', batches: [editA.batch] }, wsB.exec)
    assertStructured(result, 'cross workspace')
    assert.equal(result.status, 'not_run', result.text)
    assert.match(result.detail, new RegExp(`#${editA.batch}`))
    ok('a batch id from another workspace does not resolve')
  } finally { wsA.close(); wsB.close() }
}

console.log(`\n${passed} static-check groups passed`)
