/**
 * fftrace oracle eval — per-edge-class precision/recall (evaluation line B).
 *
 * Builds a deterministic Electron-shaped fixture whose ground truth is
 * enumerated by hand (line numbers located by unique token at generation
 * time, never hardcoded), assembles the graph through the SAME pipeline the
 * fftrace tool uses (assembleTraceGraph), and accounts true-positive /
 * missed / phantom per edge class — ipc register/push/call, globals
 * defined/used, bridge refs, dep edges, page structure — so no single total
 * score can hide a weak class (the user's B-line requirement).
 *
 * Floors are asserted: every class must reach recall=1 AND precision=1 on
 * this fixture. Floors may only be tightened over time, never relaxed.
 *
 * @module dsh-forge/tests/eval-trace
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph } from '../lib/tools-trace.js'
import { resetFactsCache } from '../lib/ast.js'

// ---------------------------------------------------------------------------
// Fixture: mini Electron workspace with known ground truth
// ---------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eval-trace-'))
const write = (rel, lines) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, lines.join('\n') + '\n')
}
/** 1-based line of the first line containing `token` (fixture drift guard). */
const mark = (lines, token) => {
  const idx = lines.findIndex((line) => line.includes(token))
  if (idx === -1) throw new Error(`fixture drift: token "${token}" not found`)
  return idx + 1
}

const registryLines = [
  "const table = {",
  "  getList: { name: 'getList', channel: 'chat:getList', kind: 'query', roles: ['chat'] },",
  "  saveSettings: { name: 'saveSettings', channel: 'chat:save', kind: 'command', roles: ['chat'] },",
  "  onMessage: { name: 'onMessage', channel: 'chat:message', kind: 'subscription', roles: ['chat'] },",
  "  getSettings: { name: 'getSettings', channel: 'chat:lonely', kind: 'query', roles: ['chat'] },",
  "}",
  "module.exports = {",
  "  ROLE_GLOBALS: { chat: 'chatAPI', utility: 'utilityAPI' },",
  "  describeApis() { return Object.values(table) },",
  "}",
]
write('preloads/core/registry.js', registryLines)
write('.dsh/trace-declarations.json', [JSON.stringify({
  roleGlobals: { chat: 'chatAPI', utility: 'utilityAPI' },
  apis: [ ['getList','chat:getList','query'], ['saveSettings','chat:save','command'],
    ['onMessage','chat:message','subscription'], ['getSettings','chat:lonely','query']
  ].map(([name,channel,kind]) => ({ name, channel, kind, roles: ['chat'] })),
})])
write('preloads/core/define.js', ['module.exports = {}'])
write('preloads/api/chat.js', ['module.exports = {}'])

const helperLines = ['module.exports = { noop() {} }']
write('main/registry-helper.js', helperLines)

const handlersLines = [
  "const { noop } = require('./registry-helper')",
  "const CHANNELS = Object.freeze({ remove: 'chat:remove' })",
  "",
  "ipcMain.handle('chat:getList', () => [])",
  "ipcMain.on(CHANNELS.remove, () => {})",
  "ipcMain.handle('chat:dual', () => 1)",
  "ipcMain.handle('chat:dual', () => 2)",
  "ipcMain.handle('chat:orphan', () => [])",
  "function forward(channel, fn) { ipcMain.handle(channel, fn) }",
  "module.exports = { forward, noop }",
]
write('main/handlers.js', handlersLines)

const pushLines = [
  "const { missing } = require('./no-such-helper')",
  "function broadcast(win, payload) {",
  "  win.webContents.send('chat:message', payload)",
  "  win.webContents.send(process.env.CHANNEL, payload)",
  "}",
  "module.exports = { broadcast }",
]
write('main/push.js', pushLines)

const compatLines = [
  "const { ipcRenderer } = require('electron')",
  "contextBridge.exposeInMainWorld('electronAPI', {",
  "  compatInvoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),",
  "})",
  "ipcRenderer.invoke('chat:getList').then(() => {})",
]
write('preloads/compat.js', compatLines)

const extraLines = ['module.exports = { help() {} }']
write('renderer/extra.js', extraLines)

const appLines = [
  "const extra = require('./extra.js')",
  "const api = window.chatAPI || window.electronAPI",
  "function runApp() {",
  "  api.getList()",
  "  window.chatAPI.saveSettings({})",
  "  window.chatAPI.mystery()",
  "  ipcRenderer.send('chat:direct', {})",
  "  extra.help()",
  "}",
]
write('renderer/app.js', appLines)

const earlyLines = [
  "function useEarly() {",
  "  if (window.VCPUI) window.VCPUI.toast('hi')",
  "}",
]
write('renderer/early.js', earlyLines)

const globalsLines = [
  "window.VCPUI = { toast(text) { console.log(text) } }",
  "const BareData = 1",
  "function BareFn() {}",
  "window.PageFlag = window.VCPUI ? 'yes' : 'no'",
]
write('renderer/globals.js', globalsLines)

const modEntryLines = [
  "import { modHelp } from './mod-dep.js'",
  "export function boot() {",
  "  window.chatAPI.getList()",
  "  modHelp()",
  "}",
]
write('renderer/mod-entry.js', modEntryLines)

const modDepLines = ['export function modHelp() { return 2 }']
write('renderer/mod-dep.js', modDepLines)

const htmlLines = [
  '<!doctype html>',
  '<html>',
  '  <head>',
  '    <script src="./early.js"></script>',
  '    <script src="globals.js"></script>',
  '    <!-- <script src="commented.js"></script> -->',
  '  </head>',
  '  <body>',
  '    <script src="./missing.js"></script>',
  '    <script src="./app.js"></script>',
  '    <script>',
  '      window.InlineFlag = true',
  '      function bootPage() { window.chatAPI.getList() }',
  "      if (window.VCPUI) window.VCPUI.toast('boot')",
  '    </script>',
  '    <script type="module">',
  "      import { modHelp } from './mod-dep.js'",
  '      const localScope = 1',
  '      window.ModFlag = 2',
  '      modHelp()',
  '    </script>',
  '    <script type="module" src="./mod-entry.js"></script>',
  '    <script src="https://cdn.example.com/x.js"></script>',
  '  </body>',
  '</html>',
]
write('renderer/index.html', htmlLines)

// Ground-truth line anchors (located, never hardcoded).
const T = {
  hGetList: mark(handlersLines, "ipcMain.handle('chat:getList'"),
  hRemove: mark(handlersLines, 'ipcMain.on(CHANNELS.remove'),
  hDual1: mark(handlersLines, "ipcMain.handle('chat:dual', () => 1)"),
  hDual2: mark(handlersLines, "ipcMain.handle('chat:dual', () => 2)"),
  hOrphan: mark(handlersLines, "ipcMain.handle('chat:orphan'"),
  hRequire: mark(handlersLines, "require('./registry-helper')"),
  pSend: mark(pushLines, "webContents.send('chat:message'"),
  pDynamic: mark(pushLines, 'process.env.CHANNEL'),
  pUnresolved: mark(pushLines, "require('./no-such-helper')"),
  cExpose: mark(compatLines, 'exposeInMainWorld'),
  cInvoke: mark(compatLines, "ipcRenderer.invoke('chat:getList')"),
  aRequire: mark(appLines, "require('./extra.js')"),
  aAlias: mark(appLines, 'const api ='),
  aGetList: mark(appLines, 'api.getList()'),
  aSave: mark(appLines, 'window.chatAPI.saveSettings'),
  aMystery: mark(appLines, 'window.chatAPI.mystery'),
  aSend: mark(appLines, "ipcRenderer.send('chat:direct'"),
  aRunApp: mark(appLines, 'function runApp'),
  eUse: mark(earlyLines, 'window.VCPUI'),
  gDef: mark(globalsLines, 'window.VCPUI ='),
  gBare: mark(globalsLines, 'const BareData'),
  gFn: mark(globalsLines, 'function BareFn'),
  gPageFlag: mark(globalsLines, 'window.PageFlag'),
  gUse: mark(globalsLines, 'window.PageFlag = window.VCPUI'),
  htmlEarly: mark(htmlLines, 'src="./early.js"'),
  htmlGlobals: mark(htmlLines, 'src="globals.js"'),
  htmlMissing: mark(htmlLines, 'src="./missing.js"'),
  htmlApp: mark(htmlLines, 'src="./app.js"'),
  htmlInline: mark(htmlLines, '<script>'),
  htmlModInline: mark(htmlLines, '<script type="module">'),
  htmlModEntry: mark(htmlLines, 'src="./mod-entry.js"'),
  htmlCdn: mark(htmlLines, 'cdn.example.com'),
  iFlag: mark(htmlLines, 'window.InlineFlag'),
  iBoot: mark(htmlLines, 'function bootPage'),
  iUse: mark(htmlLines, "window.VCPUI.toast('boot')"),
  mFlag: mark(htmlLines, 'window.ModFlag = 2'),
  meImport: mark(modEntryLines, "from './mod-dep.js'"),
  meGetList: mark(modEntryLines, 'window.chatAPI.getList()'),
}

// ---------------------------------------------------------------------------
// Assemble through the tool pipeline
// ---------------------------------------------------------------------------

resetFactsCache()
const { graph, decls } = await assembleTraceGraph(root, { declarations: '.dsh/trace-declarations.json' })
assert.equal(decls.status, 'ok', `declaration table must load: ${JSON.stringify(decls).slice(0, 200)}`)
assert.equal(decls.apis.length, 4)
assert.equal(decls.roleGlobals.chat, 'chatAPI')

// ---------------------------------------------------------------------------
// Per-class accounting: expected vs actual, keyed by stable identity
// ---------------------------------------------------------------------------

/** Items per class: Map key -> occurrence count (counts matter, e.g. dual handle). */
function count(items) {
  const m = new Map()
  for (const key of items) m.set(key, (m.get(key) ?? 0) + 1)
  return m
}

/** Multiset diff -> {tp, fn, fp, missed, phantom}. */
function account(expected, actual) {
  let tp = 0, fn = 0, fp = 0
  const missed = [], phantom = []
  for (const [key, n] of expected) {
    const got = actual.get(key) ?? 0
    if (got >= n) tp += n
    else { tp += got; fn += n - got; missed.push(key) }
  }
  for (const [key, n] of actual) {
    const want = expected.get(key) ?? 0
    if (n > want) { fp += n - want; phantom.push(key) }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  return { tp, fn, fp, precision, recall, missed, phantom }
}

const rows = []
function evaluate(label, expectedPairs, actualPairs) {
  const r = account(count(expectedPairs), count(actualPairs))
  rows.push({ label, ...r })
  return r
}

// ---- ipc.register ----------------------------------------------------------
const expectedRegisters = [
  `chat:getList main/handlers.js:${T.hGetList}`,
  `chat:remove main/handlers.js:${T.hRemove}`,
  `chat:dual main/handlers.js:${T.hDual1}`,
  `chat:dual main/handlers.js:${T.hDual2}`,
  `chat:orphan main/handlers.js:${T.hOrphan}`,
]
const actualRegisters = []
for (const [channel, items] of graph.registers) for (const i of items) actualRegisters.push(`${channel} ${i.path}:${i.line}`)
const registers = evaluate('ipc.register', expectedRegisters, actualRegisters)

// ---- ipc.push --------------------------------------------------------------
const pushes = evaluate('ipc.push', [`chat:message main/push.js:${T.pSend}`],
  [...graph.pushes].flatMap(([ch, items]) => items.map(i => `${ch} ${i.path}:${i.line}`)))

// ---- ipc.call (direct renderer/preload invocations) ------------------------
const calls = evaluate('ipc.call', [
  `chat:getList preloads/compat.js:${T.cInvoke}`,
  `chat:direct renderer/app.js:${T.aSend}`,
],
  [...graph.directCalls].flatMap(([ch, items]) => items.map(i => `${ch} ${i.path}:${i.line}`)))

// ---- global.defs -----------------------------------------------------------
const expectedDefs = [
  `VCPUI renderer/globals.js:${T.gDef} window`,
  `BareData renderer/globals.js:${T.gBare} const`,
  `BareFn renderer/globals.js:${T.gFn} function`,
  `PageFlag renderer/globals.js:${T.gPageFlag} window`,
  `InlineFlag renderer/index.html:${T.iFlag} window`,
  `bootPage renderer/index.html:${T.iBoot} function`,
  `ModFlag renderer/index.html:${T.mFlag} window`,
  `api renderer/app.js:${T.aAlias} const`,
  `extra renderer/app.js:${T.aRequire} const`,
  `runApp renderer/app.js:${T.aRunApp} function`,
  `useEarly renderer/early.js:1 function`,
]
const actualDefs = []
for (const [name, items] of graph.gdefs) for (const d of items) actualDefs.push(`${name} ${d.path}:${d.line} ${d.how}`)
const gdefs = evaluate('global.defs', expectedDefs, actualDefs)

// ---- global.uses -----------------------------------------------------------
const expectedUses = [
  `VCPUI renderer/early.js:${T.eUse}`,
  `VCPUI renderer/globals.js:${T.gUse}`,
  `VCPUI renderer/index.html:${T.iUse}`,
  // window.<bridge global> reads are global uses too (traceGlobal renders
  // every explicit window./globalThis. access — bridge refs are additional).
  `chatAPI renderer/index.html:${T.iBoot}`,
  `chatAPI renderer/app.js:${T.aAlias}`,
  `chatAPI renderer/app.js:${T.aSave}`,
  `chatAPI renderer/app.js:${T.aMystery}`,
  `chatAPI renderer/mod-entry.js:${T.meGetList}`,
  `electronAPI renderer/app.js:${T.aAlias}`,
]
const actualUses = []
for (const [name, items] of graph.guses) for (const u of items) actualUses.push(`${name} ${u.path}:${u.line}`)
const guses = evaluate('global.uses', expectedUses, actualUses)

// ---- bridge.refs (declared API access, incl. inline-body refs) -------------
const expectedBridge = [
  `getList renderer/app.js:${T.aGetList}`,
  `getList renderer/index.html:${T.iBoot}`,
  `getList renderer/mod-entry.js:${T.meGetList}`,
  `saveSettings renderer/app.js:${T.aSave}`,
]
const actualBridge = []
for (const [name, items] of graph.bridgeRefs) for (const b of items) actualBridge.push(`${name} ${b.path}:${b.line}`)
const bridge = evaluate('bridge.refs', expectedBridge, actualBridge)

// ---- bridge.unknown (undeclared API access must be visible, not dropped) ---
const unknown = evaluate('bridge.unknown', [`mystery renderer/app.js:${T.aMystery}`],
  graph.unknownBridge.map(b => `${b.name} ${b.path}:${b.line}`))

// ---- dep.edges (module graph) ----------------------------------------------
const expectedDeps = [
  `main/handlers.js main/registry-helper.js require:${T.hRequire}`,
  `renderer/app.js renderer/extra.js require:${T.aRequire}`,
  `renderer/mod-entry.js renderer/mod-dep.js import:${T.meImport}`,
]
const actualDeps = []
for (const [from, edges] of graph.deps) {
  for (const e of edges) {
    if (String(e.kind).includes('unresolved')) continue // placeholders accounted via unresolvedModules
    actualDeps.push(`${from} ${e.to} ${e.kind}:${e.line}`)
  }
}
const deps = evaluate('dep.edges', expectedDeps, actualDeps)

// ---- page.structure (script order, flags, membership, classic scope) ------
const page = graph.pages.get('renderer/index.html')
assert.ok(page, 'renderer/index.html must be a page')
const scriptTruth = [
  { index: 1, line: T.htmlEarly, rel: 'renderer/early.js', exists: true },
  { index: 2, line: T.htmlGlobals, rel: 'renderer/globals.js', exists: true },
  { index: 3, line: T.htmlMissing, rel: 'renderer/missing.js', exists: false },
  { index: 4, line: T.htmlApp, rel: 'renderer/app.js', exists: true },
  { index: 5, line: T.htmlInline, inline: true },
  { index: 6, line: T.htmlModInline, inline: true, module: true },
  { index: 7, line: T.htmlModEntry, rel: 'renderer/mod-entry.js', module: true, exists: true },
  { index: 8, line: T.htmlCdn, external: true },
]
{
  const missed = [], phantom = []
  for (const want of scriptTruth) {
    const got = page.find((s) => s.index === want.index)
    if (!got) { missed.push(`script#${want.index} (absent)`); continue }
    for (const [k, v] of Object.entries(want)) {
      if (k === 'index') continue
      if (got[k] !== v) { missed.push(`script#${want.index}.${k}=${v} (got ${JSON.stringify(got[k])})`) }
    }
  }
  for (const got of page) if (!scriptTruth.some((w) => w.index === got.index)) phantom.push(`script#${got.index} (unexpected)`)
  if (missed.length) fn_missed('page.structure', missed)
  if (phantom.length) fp_phantom('page.structure', phantom)
  rows.push({ label: 'page.structure', tp: scriptTruth.length, fn: missed.length, fp: phantom.length, precision: phantom.length ? 0 : 1, recall: missed.length ? 0 : 1, missed, phantom })
}
function fn_missed(label, items) { rows.find((r) => r.label === label)?.missed.push(...items) }
function fp_phantom(label, items) { rows.find((r) => r.label === label)?.phantom.push(...items) }

// membership: direct + closure (via module graph)
const membershipTruth = [
  'renderer/early.js direct:1',
  'renderer/globals.js direct:2',
  'renderer/app.js direct:4',
  'renderer/extra.js member:4',
  'renderer/mod-entry.js direct:7',
  'renderer/mod-dep.js member:7',
]
const membershipActual = []
for (const [rel, pages] of graph.membership) {
  const mine = pages.get('renderer/index.html')
  if (mine) membershipActual.push(`${rel} ${mine.direct ? 'direct' : 'member'}:${mine.index}`)
}
const membership = evaluate('page.membership', membershipTruth, membershipActual)

// classic scope: classic scripts + their pages
const classicTruth = [
  'renderer/early.js renderer/index.html',
  'renderer/globals.js renderer/index.html',
  'renderer/app.js renderer/index.html',
]
const classicActual = []
for (const [rel, pages] of graph.classic) for (const p of pages) classicActual.push(`${rel} ${p}`)
const classic = evaluate('page.classicScope', classicTruth, classicActual)

// ---- class-level negatives (structured expectations, not free-form) -------
assert.equal(graph.registers.has('chat:lonely'), false, 'declared-but-unregistered channel must not fake a register edge')
assert.equal([...graph.registers.get('chat:orphan') ?? []].length, 1, 'orphan handler still registers (warning is a query-level concern)')
assert.ok(graph.dynamic.some((d) => d.path === 'main/push.js' && d.line === T.pDynamic), 'dynamic push must land in the dynamic bucket')
assert.ok(
  ![...graph.registers.values(), ...graph.directCalls.values(), ...graph.pushes.values()].flat()
    .some((d) => d.path === 'main/handlers.js' && d.symbol === 'forward'),
  'wrapper definition (param passthrough) must never become a channel edge',
)
assert.ok(graph.unresolvedModules.some((u) => u.path === 'main/push.js' && u.spec === './no-such-helper'), 'unresolved relative require must be reported')
assert.equal([...graph.deps.keys()].some((k) => k.includes('electron')), false, 'package imports never enter the graph')
assert.equal(graph.gdefs.has('localScope'), false, 'module inline bare declarations are scoped, not global')
assert.equal(graph.gdefs.has('boot'), false, 'module file bare function declarations are scoped, not global')
assert.equal(graph.gdefs.has('modHelp'), false, 'module dep bare function declarations are scoped, not global')
assert.equal(graph.membership.has('renderer/missing.js'), false, 'missing scripts contribute no membership')
assert.equal(graph.pages.has('commented.js'), false, 'commented-out scripts are not pages')
assert.equal(page.some((s) => s.rel === 'renderer/commented.js'), false, 'commented-out script tags are excluded')
const cdn = page.find((s) => s.index === 8)
assert.ok(cdn && cdn.external === true && cdn.rel === undefined, 'external CDN script flagged, not resolved')
assert.equal(graph.exposes ? true : true, true) // exposes surface checked below
{
  const exposed = graph.files.get('preloads/compat.js')
  assert.ok(exposed && exposed.kind === 'js' && exposed.exposes.length === 1, 'compat preload exposes exactly one bridge')
  assert.deepEqual(exposed.exposes[0].keys, ['compatInvoke'])
  assert.equal(exposed.exposes[0].line, T.cExpose)
}

// ---------------------------------------------------------------------------
// Report + floors
// ---------------------------------------------------------------------------

const pct = (x) => `${(x * 100).toFixed(1)}%`
console.log('\n== fftrace per-edge-class oracle (evaluation line B) ==')
console.log('class             TP   FN   FP   recall   precision')
let allPass = true
for (const r of rows) {
  const pass = r.fn === 0 && r.fp === 0
  if (!pass) allPass = false
  console.log(
    `${r.label.padEnd(17)} ${String(r.tp).padStart(3)} ${String(r.fn).padStart(4)} ${String(r.fp).padStart(4)}`
    + `  ${pct(r.recall).padStart(8)} ${pct(r.precision).padStart(9)}  ${pass ? 'ok' : 'FAIL'}`,
  )
  if (r.missed.length) console.log(`  missed: ${r.missed.join('; ')}`)
  if (r.phantom.length) console.log(`  phantom: ${r.phantom.join('; ')}`)
}
const tp = rows.reduce((s, r) => s + r.tp, 0), fn = rows.reduce((s, r) => s + r.fn, 0), fp = rows.reduce((s, r) => s + r.fp, 0)
console.log(`overall           ${String(tp).padStart(3)} ${String(fn).padStart(4)} ${String(fp).padStart(4)}  ${pct(tp / (tp + fn)).padStart(8)} ${pct(tp / (tp + fp)).padStart(9)}`)

assert.ok(allPass, `per-edge-class floors failed: ${rows.filter((r) => r.fn || r.fp).map((r) => r.label).join(', ')}`)

// Cleanup (tmpdir best-effort — AV handle race tolerated)
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmp */ }
console.log(`\nall ${rows.length} edge classes passed (recall=1, precision=1)`)
