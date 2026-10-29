/**
 * Bridge diffing (M1.2): does a change break a consumer, and is the answer
 * attributable?
 *
 * Every case below is a way a text search gets this wrong: a name in a comment,
 * a same-named decoy object, an alias, a spread, a dynamic member, two calls on
 * one line, two preloads exposing one global, an error that predates the change.
 *
 * The last case of each group is the honesty one: a run that could not decide
 * must be `partial`, never `passed`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_FORGE_AST_WORKERS = '0'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bridge-data-'))
process.env.DSH_FORGE_DATA_DIR = dataDir

const { assembleTraceGraph, resetTraceFactsCache, resetTraceSnapshots } = await import('../lib/tools-trace.js')
const { bridgeModel, diffBridges } = await import('../lib/bridge-check.js')
const { diffWorkspaceBridges } = await import('../lib/bridge-scan.js')

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

/** Main-process handlers for the channels PRELOAD() calls. Without them every
 *  scenario would open with a set of IPC findings that have nothing to do with
 *  the case under test — and a baseline that is not clean cannot show what a
 *  change broke. */
const HANDLERS = [
  "const { ipcMain } = require('electron')",
  "ipcMain.handle('chart:list', () => [])",
  "ipcMain.handle('chart:toggle-pin', () => 1)",
  '',
].join('\n')

/** Each scenario gets its own tree: these assert exact site counts. */
async function scenario(files) {
  files = { 'main.js': HANDLERS, ...files }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bridge-'))
  const put = (rel, text) => {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  for (const [rel, text] of Object.entries(files)) put(rel, text)
  resetTraceFactsCache()
  resetTraceSnapshots()
  const before = await assembleTraceGraph(root, { capture: true })
  return {
    root, put, beforeGraph: before,
    before: bridgeModel({ workspace: root, files: before.graph.files }),
    beforeSnapshot: before.snapshot.snapshotId,
    /** Re-scan the current tree and diff it against the capture. */
    async after(checks) {
      resetTraceFactsCache()
      resetTraceSnapshots()
      const { result } = await diffWorkspaceBridges({ workspace: root, before, capture: true, changed: [], ...(checks ? { checks } : {}) })
      return result
    },
    /** Diff without a baseline: everything must be `unknown`, never `new`. */
    async afterWithoutBaseline(checks) {
      resetTraceFactsCache()
      resetTraceSnapshots()
      const { result } = await diffWorkspaceBridges({ workspace: root, before: null, changed: [], ...(checks ? { checks } : {}) })
      return result
    },
    close() { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmp */ } },
  }
}

try {
  // --- 1. two consumers, one renamed member -------------------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': 'window.chartAPI.togglePin()\n',
      'b.js': 'const api = window.chartAPI\napi.togglePin()\n',
    })
    try {
      // Baseline is clean.
      const clean = await ws.after()
      assert.equal(clean.findings.length, 0, JSON.stringify(clean.findings))
      assert.equal(clean.status, 'passed', clean.verdict)
      assert.equal(clean.coverage.boundConsumers, 2, 'both consumers bind to the single provider')

      ws.put('preloads/main.js', PRELOAD('pinToggle'))
      const broken = await ws.after()
      assert.equal(broken.status, 'failed', broken.verdict)
      assert.equal(broken.findings.length, 2, JSON.stringify(broken.findings.map(f => f.consumer.file)))
      assert.deepEqual(broken.findings.map(f => f.consumer.file).sort(), ['a.js', 'b.js'])
      assert.ok(broken.findings.every(f => f.attribution === 'new'))
      assert.ok(broken.findings.every(f => f.kind === 'expose_member_missing'))
      assert.ok(broken.findings.every(f => f.expected.member === 'togglePin'))
      assert.ok(broken.findings.every(f => f.provider.file === 'preloads/main.js'))
      ok('a renamed member with two consumers reports both as new, with the provider file')
    } finally { ws.close() }
  }

  // --- 2. a local alias is resolved to its root object -------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'b.js': 'const api = window.chartAPI\napi.togglePin()\n',
    })
    try {
      ws.put('preloads/main.js', PRELOAD('pinToggle'))
      const result = await ws.after()
      assert.equal(result.findings.length, 1)
      assert.equal(result.findings[0].consumer.file, 'b.js')
      // via an alias: still the same provider, still one finding
      assert.equal(result.findings[0].attribution, 'new')
      ok('an aliased consumer is bound through the alias, not dropped as unknown')
    } finally { ws.close() }
  }

  // --- 3. a same-named decoy object is not a consumer --------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': 'window.chartAPI.togglePin()\n',
      'decoy.js': 'const other = { togglePin() { return 0 } }\nother.togglePin()\n',
    })
    try {
      ws.put('preloads/main.js', PRELOAD('pinToggle'))
      const result = await ws.after()
      assert.equal(result.findings.length, 1, JSON.stringify(result.findings.map(f => f.consumer.file)))
      assert.equal(result.findings[0].consumer.file, 'a.js')
      // The decoy is a local object, not a bridge root, so it never enters the model.
      assert.equal(ws.before.consumers.some(c => c.file === 'decoy.js'), false)
      ok('an unrelated object with the same method name is never counted as a consumer')
    } finally { ws.close() }
  }

  // --- 4. a commented-out call is not a consumer -------------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': 'window.chartAPI.togglePin()\n// window.chartAPI.togglePin()\n',
    })
    try {
      const consumers = ws.before.consumers.filter(c => c.file === 'a.js')
      assert.equal(consumers.length, 1, 'the comment is not a site')
      ws.put('preloads/main.js', PRELOAD('pinToggle'))
      const result = await ws.after()
      assert.equal(result.findings.length, 1, 'one real call, one finding')
      ok('a name surviving only in a comment does not hide the miss (and does not invent one)')
    } finally { ws.close() }
  }

  // --- 5. a spread makes the surface a lower bound -----------------------
  {
    const ws = await scenario({
      'preloads/main.js': [
        "const { contextBridge } = require('electron')",
        'const extra = { togglePin() { return 1 } }',
        "contextBridge.exposeInMainWorld('chartAPI', { ...extra, listCharts() { return [] } })",
        '',
      ].join('\n'),
      'a.js': 'window.chartAPI.togglePin()\n',
    })
    try {
      ws.put('preloads/main.js', [
        "const { contextBridge } = require('electron')",
        'const extra = { pinToggle() { return 1 } }',
        "contextBridge.exposeInMainWorld('chartAPI', { ...extra, listCharts() { return [] } })",
        '',
      ].join('\n'))
      const result = await ws.after()
      // The surface is not enumerable, so the module must not claim a finding it
      // cannot prove — it must say it could not tell.
      assert.equal(result.findings.length, 0, JSON.stringify(result.findings))
      assert.equal(result.status, 'partial', result.verdict)
      assert.ok(result.limitations.some(l => l.code === 'dynamic_member'))
      ok('a spread object downgrades the run to partial instead of guessing members')
    } finally { ws.close() }
  }

  // --- 6. dynamic member name and dynamic global name --------------------
  {
    const ws = await scenario({
      'preloads/main.js': [
        "const { contextBridge } = require('electron')",
        "const name = 'chartAPI'",
        'const api = { togglePin() { return 1 } }',
        'contextBridge.exposeInMainWorld(name, api)',
        '',
      ].join('\n'),
      'a.js': 'window.chartAPI.togglePin()\n',
    })
    try {
      const result = await ws.after()
      // A dynamic global name cannot be bound to any consumer.
      assert.ok(result.limitations.some(l => l.code === 'ambiguous_provider'))
      assert.notEqual(result.status, 'passed')
      ok('a dynamic exposeInMainWorld name is reported as unbindable, not silently matched')
    } finally { ws.close() }
  }

  // --- 7. a reassigned member expression ---------------------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': 'let api = window.chartAPI\napi = window.other\napi.togglePin()\n',
    })
    try {
      ws.put('preloads/main.js', PRELOAD('pinToggle'))
      const result = await ws.after()
      const forA = result.findings.filter(f => f.consumer.file === 'a.js')
      // `api` is reassigned, so the module cannot prove which object the call
      // reaches; it must not report a confident finding either way.
      assert.ok(forA.length === 0 || forA.every(f => f.attribution !== 'new'), JSON.stringify(forA))
      assert.notEqual(result.status, 'passed', 'an unresolvable receiver keeps the run out of passed')
      ok('a reassigned alias cannot produce a confident finding')
    } finally { ws.close() }
  }

  // --- 8. two calls on one line are two sites ----------------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': 'window.chartAPI.togglePin(); window.chartAPI.listCharts()\n',
    })
    try {
      const sites = ws.before.consumers.filter(c => c.file === 'a.js')
      assert.equal(sites.length, 2, 'both calls on the line are recorded')
      assert.equal(new Set(sites.map(site => site.site ? JSON.stringify(site.site) : site.line)).size, 2, 'and they have distinct site identity')
      ws.put('a.js', 'window.chartAPI.pinToggle(); window.chartAPI.listCharts()\n')
      const result = await ws.after()
      // The existing member stays resolvable; only the renamed call is a finding.
      assert.equal(result.findings.length, 1, JSON.stringify(result.findings))
      assert.equal(result.findings[0].consumer.member, 'pinToggle')
      ok('two calls on one line keep separate identity, so only the broken one is reported')
    } finally { ws.close() }
  }

  // --- 9. two preloads exposing the same global are ambiguous ------------
  {
    const ws = await scenario({
      'preloads/one.js': PRELOAD(),
      'preloads/two.js': PRELOAD('otherThing'),
      'a.js': 'window.chartAPI.togglePin()\n',
    })
    try {
      const result = await ws.after()
      assert.ok(result.limitations.some(l => l.code === 'ambiguous_provider'), JSON.stringify(result.limitations))
      assert.equal(result.coverage.boundConsumers, 0, 'no consumer may claim a provider')
      assert.equal(result.findings.length, 0, 'an ambiguous binding produces no finding')
      assert.notEqual(result.status, 'passed')
      ok('two providers for one global are ambiguous: no finding, no pass')
    } finally { ws.close() }
  }

  // --- 10. a pre-existing error survives a line move ---------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': '\n\n\nwindow.chartAPI.missingAlready()\n',
    })
    try {
      // Baseline already has the broken call.
      const baselineRun = await ws.after()
      assert.equal(baselineRun.findings.length, 1)
      assert.equal(baselineRun.findings[0].attribution, 'existing', 'a member the baseline never offered is not new')
      assert.equal(baselineRun.status, 'partial', 'existing damage does not fail this change')

      // Move it down by three lines and rename something else in the provider.
      ws.put('a.js', '\n\n\n\n\n\nwindow.chartAPI.missingAlready()\n')
      const moved = await ws.after()
      assert.equal(moved.findings.length, 1)
      assert.equal(moved.findings[0].attribution, 'existing', 'a moved line is not a new defect')
      assert.equal(moved.findings[0].consumer.line, 7, 'and it reports where it actually is now')
      ok('attribution follows member identity, not line numbers: a moved defect stays existing')
    } finally { ws.close() }
  }

  // --- 11. deleting the provider file -----------------------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': 'window.chartAPI.togglePin()\n',
    })
    try {
      fs.rmSync(path.join(ws.root, 'preloads', 'main.js'))
      const result = await ws.after()
      assert.equal(result.findings.length, 1, JSON.stringify(result.findings))
      assert.equal(result.findings[0].kind, 'expose_global_missing')
      assert.equal(result.findings[0].attribution, 'new')
      assert.match(result.findings[0].detail, /preloads\/main\.js/)
      ok('removing the provider entirely reports the orphaned global as new')
    } finally { ws.close() }
  }

  // --- 12. IPC: invoke with only `on`, page mismatch, dynamic, deletion --
  {
    const ws = await scenario({
      'preloads/main.js': [
        "const { contextBridge, ipcRenderer } = require('electron')",
        "contextBridge.exposeInMainWorld('chartAPI', { list: () => ipcRenderer.invoke('chart:list') })",
        '',
      ].join('\n'),
      'main.js': [
        "const { ipcMain } = require('electron')",
        "ipcMain.handle('chart:list', () => [])",
        '',
      ].join('\n'),
      'a.js': "window.chartAPI.list()\nrequire('electron').ipcRenderer.invoke('chart:list')\n",
    })
    try {
      const clean = await ws.after()
      assert.equal(clean.findings.filter(f => f.channel).length, 0, JSON.stringify(clean.findings))

      // delete the handler but leave a same-channel `on` registration
      ws.put('main.js', [
        "const { ipcMain } = require('electron')",
        "ipcMain.on('chart:list', () => {})",
        '',
      ].join('\n'))
      const mismatch = await ws.after(['ipc'])
      const ipcFindings = mismatch.findings.filter(f => f.channel)
      assert.equal(ipcFindings.length, 1, JSON.stringify(ipcFindings))
      assert.equal(ipcFindings[0].kind, 'ipc_method_mismatch')
      assert.match(ipcFindings[0].detail, /handle/)
      ok('invoke answered only by `on` is a method mismatch, not a match')
    } finally { ws.close() }
  }

  {
    const ws = await scenario({
      'preloads/main.js': [
        "const { contextBridge, ipcRenderer } = require('electron')",
        "contextBridge.exposeInMainWorld('chartAPI', { ping: (ch) => ipcRenderer.invoke(ch) })",
        '',
      ].join('\n'),
      'main.js': "const { ipcMain } = require('electron')\nipcMain.handle('chart:ping', () => 1)\n",
      'a.js': "window.chartAPI.ping('chart:ping')\n",
    })
    try {
      ws.put('main.js', "const { ipcMain } = require('electron')\n")
      const result = await ws.after(['ipc'])
      // The channel only exists at the bridge member's call site, and the fact
      // model does not follow that into an object-literal method. Reporting a
      // confident finding here would be a guess, so the run must degrade.
      assert.equal(result.findings.filter(f => f.kind === 'ipc_endpoint_missing').length, 0, JSON.stringify(result.findings))
      assert.ok(result.limitations.some(l => l.code === 'dynamic_channel' && l.file === 'preloads/main.js'), JSON.stringify(result.limitations))
      assert.notEqual(result.status, 'passed')
      ok('a wrapper-parameter channel stays dynamic: the deletion is a stated gap, not a guess')
    } finally { ws.close() }
  }

  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': "const { ipcRenderer } = require('electron')\nipcRenderer.invoke('chart:toggle-pin')\n",
    })
    try {
      const clean = await ws.after(['ipc'])
      assert.equal(clean.findings.filter(f => f.channel).length, 0, JSON.stringify(clean.findings))
      // Delete exactly the handler that answers this literal channel.
      ws.put('main.js', [
        "const { ipcMain } = require('electron')",
        "ipcMain.handle('chart:list', () => [])",
        '',
      ].join('\n'))
      const result = await ws.after(['ipc'])
      const missing = result.findings.filter(f => f.kind === 'ipc_endpoint_missing')
      // Both the preload's own wrapper body and the renderer call site invoke the
      // channel, so both are real callers of the handler that just vanished.
      assert.deepEqual(missing.map(f => f.consumer.file).sort(), ['a.js', 'preloads/main.js'], JSON.stringify(result.findings))
      assert.ok(missing.every(f => f.attribution === 'new'))
      assert.ok(missing.every(f => f.channel === 'chart:toggle-pin'))
      ok('a deleted handler for a literal channel is a new missing endpoint')
    } finally { ws.close() }
  }

  {
    const ws = await scenario({
      'preloads/main.js': [
        "const { contextBridge, ipcRenderer } = require('electron')",
        "contextBridge.exposeInMainWorld('chartAPI', { any: (ch) => ipcRenderer.invoke(ch) })",
        '',
      ].join('\n'),
      'main.js': "const { ipcMain } = require('electron')\nipcMain.handle('known:channel', () => 1)\n",
      'a.js': "window.chartAPI.any('known:channel')\nwindow.chartAPI.any(dynamicName)\n",
    })
    try {
      const result = await ws.after(['ipc'])
      // The dynamic call cannot be matched, and must not be reported as broken.
      assert.ok(result.limitations.some(l => l.code === 'dynamic_channel'), JSON.stringify(result.limitations))
      assert.equal(result.findings.filter(f => f.channel && f.attribution === 'new').length, 0, JSON.stringify(result.findings))
      assert.notEqual(result.status, 'passed')
      ok('a dynamic channel is a stated limitation, never a confident finding')
    } finally { ws.close() }
  }

  // --- 13. no baseline: nothing may be called new -----------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': 'window.chartAPI.missingAlready()\n',
    })
    try {
      const result = await ws.afterWithoutBaseline()
      assert.equal(result.findings.length, 1)
      assert.equal(result.findings[0].attribution, 'unknown', 'without a baseline nothing can be "new"')
      assert.equal(result.status, 'partial')
      assert.ok(result.limitations.some(l => l.code === 'no_baseline'))
      assert.equal(result.coverage.baseline, false)
      ok('without a baseline every finding is unknown, so the run cannot fail the change')
    } finally { ws.close() }
  }

  // --- 14. the check kinds are independent ------------------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': 'window.chartAPI.togglePin()\n',
    })
    try {
      ws.put('preloads/main.js', PRELOAD('pinToggle'))
      const bridgeOnly = await ws.after(['bridge'])
      assert.deepEqual(bridgeOnly.checks, ['bridge'])
      assert.equal(bridgeOnly.findings.length, 1)
      const ipcOnly = await ws.after(['ipc'])
      assert.deepEqual(ipcOnly.checks, ['ipc'])
      assert.equal(ipcOnly.findings.length, 0)
      ok('bridge and ipc checks run independently and report which ran')
    } finally { ws.close() }
  }

  // --- 15. range identity is not silently assumed -----------------------
  {
    const ws = await scenario({
      'preloads/main.js': PRELOAD(),
      'a.js': 'window.chartAPI.togglePin()\n',
    })
    try {
      const clean = await ws.after()
      assert.equal(clean.coverage.ranged, true, 'the WASM extractor emits spans')
      // Strip spans from the after model: the run must degrade, not stay green.
      const stripped = {
        ...ws.before,
        consumers: ws.before.consumers.map(({ site, ...rest }) => ({ ...rest, site: undefined })),
        unsourcedSites: ws.before.consumers.length,
      }
      const degraded = diffBridges({ workspace: ws.root, before: stripped, after: { ...stripped }, changed: [] })
      assert.equal(degraded.coverage.ranged, false)
      assert.ok(degraded.limitations.some(l => l.code === 'no_spans'))
      assert.notEqual(degraded.status, 'passed', 'without spans the line-only comparison cannot pass')
      ok('facts without spans downgrade the run instead of comparing lines as sites')
    } finally { ws.close() }
  }
} finally {
  resetTraceSnapshots()
  resetTraceFactsCache()
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmp */ }
}

console.log(`\n${passed} bridge-check groups passed`)
