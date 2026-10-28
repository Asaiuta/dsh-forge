// fftrace end-to-end: fixture mini-VCPChat workspace (preload registry, IPC
// handlers with wrapper/const/dynamic channels, bridge aliases, HTML page,
// window globals) — mounts the real tool factory and drives all four trace
// kinds plus the warning set. Natural exit (no process.exit — WASM handles).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTraceTool } from '../lib/tools-trace.js'
import { resetFactsCache } from '../lib/ast.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-'))
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const rmRoot = () => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* AV handle race — tmpdir cleans itself */ } }

const exec = { agent: { session: { header: { cwd: root, id: 'trace' } } }, token: {} }
const tool = createTraceTool()
const run = async (target) => {
  const value = await tool.execute({ target, declarations: '.dsh/trace-declarations.json' }, exec)
  return value
}

// ---- fixture --------------------------------------------------------------

write('.gitignore', 'dist/\n')
write('dist/junk.js', '// excluded by .gitignore\n')

write('preloads/core/registry.js', `// mini registry: describeApis + ROLE_GLOBALS (VCPChat shape)
const table = {
  getList: { name: 'getList', channel: 'chat:getList', kind: 'query', roles: ['chat'], domain: 'chat' },
  saveSettings: { name: 'saveSettings', channel: 'chat:save', kind: 'command', roles: ['chat'], domain: 'settings' },
  onMessage: { name: 'onMessage', channel: 'chat:message', kind: 'subscription', roles: ['chat'], domain: 'chat' },
  brokenQuery: { name: 'brokenQuery', channel: 'chat:broken', kind: 'query', roles: ['chat'], domain: 'chat' },
  getSettings: { name: 'getSettings', channel: 'chat:lonely', kind: 'query', roles: ['chat'], domain: 'settings' },
  staleApi: { name: 'staleApi', channel: 'chat:stale', kind: 'query', roles: ['chat'], domain: 'chat' },
  remote: { name: 'remote', channel: 'chat:remote', kind: 'query', roles: ['chat'], domain: 'chat' },
  chatOnly: { name: 'chatOnly', channel: 'chat:chatonly', kind: 'query', roles: ['chat'], domain: 'chat' },
}
module.exports = {
  ROLE_GLOBALS: { chat: 'chatAPI', utility: 'utilityAPI', desktop: 'desktopAPI' },
  describeApis() { return Object.values(table) },
}
`)
write('preloads/core/define.js', 'module.exports = {}\n')
write('.dsh/trace-declarations.json', JSON.stringify({
  roleGlobals: { chat: 'chatAPI', utility: 'utilityAPI', desktop: 'desktopAPI' },
  apis: [
    ['getList','chat:getList','query','chat'], ['saveSettings','chat:save','command','settings'],
    ['onMessage','chat:message','subscription','chat'], ['brokenQuery','chat:broken','query','chat'],
    ['getSettings','chat:lonely','query','settings'], ['staleApi','chat:stale','query','chat'],
    ['remote','chat:remote','query','chat'], ['chatOnly','chat:chatonly','query','chat'],
  ].map(([name,channel,kind,domain]) => ({ name, channel, kind, domain, roles: ['chat'] })),
}))
write('preloads/api/chat.js', 'module.exports = {}\n')

write('main/handlers.js', `const { registerHandler } = require('./registry-helper')
const CHANNELS = Object.freeze({ remove: 'chat:remove' })

function registerHandler(channel, handler) { ipcMain.handle(channel, handler) }

ipcMain.handle('chat:getList', async () => [])
registerHandler('chat:save', async () => {})
ipcMain.on(CHANNELS.remove, () => {})
ipcMain.handle('chat:dual', () => {})
ipcMain.handle('chat:dual', () => {})
ipcMain.handle('chat:dead', () => {})
ipcMain.on('chat:broken', () => {})
ipcMain.handle('chat:remote', () => {})
ipcMain.handle(process.env.CHANNEL, () => {})
function unregistered(ch, fn) { ipcMain.on(ch, fn) }
unregistered(someChannel, () => {})
`)
write('main/registry-helper.js', 'module.exports = {}\n')
write('main/push.js', `function broadcast(win, payload) { win.webContents.send('chat:message', payload) }
module.exports = { broadcast }
`)

write('preloads/compat.js', `const { ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('electronAPI', {
  direct: () => {},
  compatInvoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
})
ipcRenderer.invoke('chat:direct').then(() => {})
`)

write('preloads/chart.js', `const { contextBridge, ipcRenderer } = require('electron')
const chartAPI = Object.freeze({
  listCharts: () => ipcRenderer.invoke('chart:list'),
  togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),
  onChartChanged: callback => ipcRenderer.on('chart:changed', callback),
})
contextBridge.exposeInMainWorld('chartAPI', chartAPI)
contextBridge.exposeInMainWorld('api', { ping: () => {} })
`)

write('preloads/core/expose.js', `const { ROLE_GLOBALS } = require('./registry')
function exposeRole(role) {
  const globalName = ROLE_GLOBALS[role]
  contextBridge.exposeInMainWorld(globalName, {})
}
module.exports = { exposeRole }
`)

write('renderer/chart-users.js', `;(function () {
  const api = window.chartAPI
  api.listCharts()
  api.listCharts()
  api.onChartChanged(() => {})
})()
`)

write('renderer/a.js', `function escapeHtml(value) { return String(value) }
module.exports = { escapeHtml }
`)
write('renderer/b.js', `const escapeHtml = (value) => String(value)
module.exports = { escapeHtml }
`)


write('renderer/app.js', `const api = window.chatAPI || window.electronAPI
const helper = require('./helper.js')
async function boot() {
  const list = await api.getList()
  window.chatAPI.saveSettings({})
  window.chatAPI.brokenQuery()
  window.chatAPI.getSettings()
  window.utilityAPI.chatOnly()
  window.chatAPI.mystery()
  ipcRenderer.send('chat:direct')
  const lazy = await import('./lazy.js')
  return { list, lazy, helper }
}
module.exports = { boot }
`)
write('renderer/helper.js', 'module.exports = { help() {} }\n')
write('renderer/lazy.js', 'module.exports = {}\n')

write('renderer/early.js', `function useEarly() { window.VCPUI.toast('hi') }
useEarly()
`)
write('renderer/globals.js', `window.VCPUI = { toast(text) { console.log(text) } }
function legacyGlobal() {}
`)
write('renderer/usesLegacy.js', `function crossFile() { api.remote() }
window.VCPUI.toast('again')
crossFile()
`)

write('renderer/mod-entry.js', `import { modValue } from './mod-dep.js'
const moduleScoped = modValue
window.Mody = moduleScoped
module.exports = {}
`)
write('renderer/mod-dep.js', 'export const modValue = 1\n')

write('renderer/index.html', `<!doctype html>
<html>
<head>
  <script src="./early.js"></script>
  <script src="globals.js"></script>
  <!-- <script src="commented.js"></script> -->
</head>
<body>
  <script src="./app.js"></script>
  <script src="usesLegacy.js"></script>
  <script type="module" src="./mod-entry.js"></script>
  <script src="missing.js"></script>
  <script>window.InlineThing = 42</script>
  <script src="https://cdn.example.com/x.js"></script>
</body>
</html>
`)

resetFactsCache()

// ---- ipc: literal / wrapper / const / direct / warnings -------------------

{
  const r = await run('ipc:chat:getList')
  assert.equal(r.found, true)
  assert.equal(r.decls, 'ok')
  assert.ok(r.text.includes('## Trace ipc:chat:getList'))
  assert.ok(r.text.includes('ipcMain.handle（literal）'), r.text)
  assert.ok(r.text.includes('`getList` · query · 角色 chat（declared）'))
  assert.ok(r.text.includes('via `api（= chatAPI）`'), r.text)
  assert.ok(r.text.includes('renderer/app.js'))
  ok('ipc: literal handler + declared api + alias caller wired into one edge')
}
{
  const r = await run('api:getList')
  assert.ok(r.text.includes('是 preload API 名，对应通道 `chat:getList`'), r.text)
  ok('api: name resolves to its channel with a note')
}
{
  const r = await run('ipc:chat:save')
  assert.ok(r.text.includes('ipcMain.handle（wrapper）'), r.text)
  assert.ok(r.text.includes('`saveSettings` · command'), r.text)
  assert.ok(r.text.includes('via `chatAPI`'), r.text)
  ok('ipc: same-file wrapper call site recorded with wrapper confidence')
}
{
  const r = await run('ipc:chat:remove')
  assert.ok(r.text.includes('ipcMain.on（const）'), r.text)
  ok('ipc: Object.freeze const table resolves to const confidence')
}
{
  const r = await run('ipc:chat:dual')
  assert.ok(r.text.includes('同一通道有 2 处 handle 注册'), r.text)
  ok('ipc: double handle registration warned')
}
{
  const r = await run('ipc:chat:dead')
  assert.ok(r.text.includes('未找到任何渲染端调用方'), r.text)
  ok('ipc: dead handler flagged')
}
{
  const r = await run('ipc:chat:broken')
  assert.ok(r.text.includes('invoke 会一直等不到返回'), r.text)
  ok('ipc: invoke-vs-on mismatch flagged')
}
{
  const r = await run('ipc:chat:lonely')
  assert.ok(r.text.includes('有调用方但未找到 `ipcMain` 注册'), r.text)
  ok('ipc: caller without handler flagged')
}
{
  const r = await run('ipc:chat:stale')
  assert.ok(r.text.includes('疑似遗留声明'), r.text)
  ok('ipc: stale declaration flagged')
}
{
  const r = await run('ipc:chat:message')
  assert.ok(r.text.includes('推送方 webContents.send（1）'), r.text)
  assert.ok(r.text.includes('main/push.js'))
  assert.ok(r.text.includes('`onMessage` · subscription'), r.text)
  ok('ipc: subscription wired to its webContents.push source')
}
{
  const r = await run('ipc:chat:chatonly')
  assert.ok(r.text.includes('属于 utility 角色'), r.text)
  ok('ipc: role-invisible bridge call flagged')
}
{
  const r = await run('ipc:chat:direct')
  assert.ok(r.text.includes('直接 ipcRenderer 调用（2）'), r.text)
  assert.ok(r.text.includes('有调用方但未找到 `ipcMain` 注册'), r.text)
  ok('ipc: literal renderer calls kept as direct edges')
}
{
  const r = await run('ipc:chat:remote')
  assert.ok(r.text.includes('via `api（= chatAPI）`'), r.text)
  assert.ok(r.text.includes('renderer/usesLegacy.js'), r.text)
  ok('ipc: cross-file same-page alias adoption (second-pass bridge extension)')
}
{
  const r = await run('ipc:totally-absent')
  assert.equal(r.found, false)
  assert.ok(r.text.includes('未找到该通道或 API'))
  assert.ok(r.text.includes('动态通道参数'), r.text)
  ok('ipc: unknown channel reports suggestions + dynamic budget')
}

// ---- global ---------------------------------------------------------------

{
  const r = await run('global:VCPUI')
  assert.equal(r.found, true)
  assert.ok(r.text.includes('window.VCPUI ='), r.text)
  assert.ok(r.text.includes('renderer/globals.js'), r.text)
  assert.ok(r.text.includes('定义于第 2 个脚本'), r.text)
  assert.ok(r.text.includes('早于定义脚本（第 2 个）'), r.text)
  ok('global: defs/uses + per-page load-order warning')
}
{
  const r = await run('global:legacyGlobal')
  assert.ok(r.text.includes('顶层 function'), r.text)
  ok('global: classic-script top-level function counted as definition')
}
{
  const r = await run('global:moduleScoped')
  assert.equal(r.found, false)
  ok('global: module-scoped const correctly not a window global')
}

// ---- page -----------------------------------------------------------------

{
  const r = await run('page:index.html')
  assert.equal(r.found, true)
  assert.ok(r.text.includes('脚本加载顺序（8）'), r.text)
  assert.ok(r.text.includes('renderer/app.js` · L'), r.text)
  assert.ok(r.text.includes('⚠️ 文件不存在'), r.text)
  assert.ok(r.text.includes('外部资源'), r.text)
  assert.ok(r.text.includes('内联'), r.text)
  assert.ok(!r.text.includes('commented.js'), r.text)
  assert.ok(r.text.includes('页面共加载'), r.text)
  // Injected globals are grouped under the script that defines them, so the
  // path and the load position are named once per script instead of once per
  // global. What must stay true: VCPUI is reported against the 2nd script.
  assert.ok(/^- `renderer\/globals\.js` · 第 2 个脚本（\d+）$/m.test(r.text), r.text)
  assert.ok(/^  - `VCPUI` L\d+$/m.test(r.text), r.text)
  assert.ok(!r.text.includes('`moduleScoped`'), r.text)
  assert.ok(r.text.includes('`chatAPI`：'), r.text)
  assert.ok(r.text.includes('调用了声明表中不存在的 API'), r.text)
  ok('page: script order + closure membership + injected globals + unknown bridge')
}
{
  const r = await run('page:no-such-page.html')
  assert.equal(r.found, false)
  ok('page: missing page reports not-found')
}

// ---- file -----------------------------------------------------------------

{
  const r = await run('file:renderer/app.js')
  assert.equal(r.found, true)
  assert.ok(r.text.includes('被页面加载（1）'), r.text)
  assert.ok(r.text.includes('个脚本（直接）'), r.text)
  assert.ok(r.text.includes('→ `renderer/helper.js`'), r.text)
  assert.ok(r.text.includes('dynamic_import'), r.text)
  assert.ok(r.text.includes('ipcRenderer.send'), r.text)
  assert.ok(r.text.includes('`api.getList`'), r.text)
  assert.ok(r.text.includes('→ `chat:getList` · query'), r.text)
  assert.ok(r.text.includes('`chatAPI.mystery`') && r.text.includes('声明表中不存在'), r.text)
  ok('file: membership + deps + dynamic import + bridge tails + unknown api')
}
{
  const r = await run(`file:${path.join(root, 'main', 'handlers.js')}`)
  assert.ok(r.text.includes('IPC 注册（11）'), r.text)
  assert.ok(r.text.includes('（dynamic）'), r.text)
  assert.ok(r.text.includes('（param）'), 'file view shows the raw passthrough row (PF parity)')
  ok('file: absolute path relativized; dynamic shown; passthrough visible as fact row')
  const graph = await run('ipc:channel')
  assert.equal(graph.found, false)
  ok('graph: wrapper passthrough never becomes a channel edge')
}
{
  const r = await run('file:preloads/compat.js')
  assert.ok(r.text.includes('exposeInMainWorld'), r.text)
  assert.ok(r.text.includes('`electronAPI` · '), r.text)
  assert.ok(r.text.includes('direct'), r.text)
  // The file view reports the bridge's key surface as counts plus the consumer
  // that exercises it, and defers per-key coordinates to exposes:/detail.
  assert.ok(/electronAPI` · L2 · 键 2 · 已用 \d+ · 站点 1 · 消费者 1 文件：`renderer\/app\.js` ×1/.test(r.text), r.text)
  assert.ok(r.text.includes('逐键消费者：`exposes:preloads/compat.js`'), r.text)
  ok('file: exposeInMainWorld key surface + consumer, per-key detail deferred to exposes:')
}
{
  // Per-key coordinates live in the exposes: view now; the file view reports the
  // key surface and points here. Same facts, one view, asserted where they are.
  const r = await run('exposes:preloads/chart.js')
  assert.ok(/`chartAPI` · L\d+ · 键：listCharts、togglePin、onChartChanged/.test(r.text), r.text)
  assert.ok(/`listCharts` ×2：`renderer\/chart-users\.js:\d+`、`renderer\/chart-users\.js:\d+`/.test(r.text), r.text)
  assert.ok(/`onChartChanged` ×1：/.test(r.text), r.text)
  assert.ok(/未被使用（1）：togglePin/.test(r.text), r.text)
  ok('exposes:: non-literal exposed object keys resolved + per-key usage grouped')
}
{
  const all = await run('exposes:')
  assert.equal(all.found, true)
  assert.ok(all.text.startsWith('## Trace exposes:all'), all.text)
  assert.ok(all.text.includes('`electronAPI`') && all.text.includes('`chartAPI`'), all.text)
  assert.ok(all.text.includes('动态名') && all.text.includes('可能为：chatAPI、utilityAPI、desktopAPI'), all.text)
  const one = await run('exposes:chartAPI')
  assert.ok(one.found && one.text.includes('`chartAPI`') && !one.text.includes('`electronAPI`'), one.text)
  const byFile = await run('exposes:preloads/chart.js')
  assert.ok(byFile.found && byFile.text.includes('preloads/chart.js') && !byFile.text.includes('preloads/compat.js'), byFile.text)
  const missing = await run('exposes:nope')
  assert.equal(missing.found, false)
  ok('exposes: aggregate, global filter, file filter, dynamic role-global name')
}
{
  const r = await run('symbol:escapeHtml')
  assert.equal(r.found, true)
  assert.ok(r.text.includes('renderer/a.js') && r.text.includes('renderer/b.js'), r.text)
  assert.ok(/定义 2 处 · 2 个文件/.test(r.text), r.text)
  assert.ok(r.text.includes('view=body'), r.text)
  const none = await run('symbol:definitelyMissing')
  assert.equal(none.found, false)
  ok('symbol: one call lists every definition across files')
}

// ---- failure modes --------------------------------------------------------

{
  const bad = await tool.execute({ target: 'wat:foo' }, exec)
  assert.ok(bad.error && /target like/.test(bad.error) && /ffi:/.test(bad.error))
  const empty = await tool.execute({ target: 'ipc:' }, exec)
  assert.ok(empty.error)
  ok('bad targets rejected with usage message')
}

// ---- literal-only workspace (no preload registry) -------------------------

const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace2-'))
fs.writeFileSync(path.join(root2, 'solo.js'), "const { ipcMain } = require('electron')\nipcMain.handle('solo:go', () => {})\n")
fs.writeFileSync(path.join(root2, 'caller.js'), "const { ipcRenderer } = require('electron')\nipcRenderer.invoke('solo:go')\n")
const exec2 = { agent: { session: { header: { cwd: root2, id: 'trace2' } } }, token: {} }
{
  const r = await tool.execute({ target: 'ipc:solo:go' }, exec2)
  assert.equal(r.decls, 'absent')
  assert.ok(r.text.includes('无 preload 声明表（只有字面量边）'), r.text)
  assert.ok(r.text.includes('ipcMain.handle（literal）'), r.text)
  assert.ok(r.text.includes('caller.js'), r.text)
  ok('literal-only workspace: graph still works, decls marked absent')
}

// ---- cross-file wrapper (preload DSL in one module, calls in another) -----
// The shape VCPChat uses: `invoke()` lives in core/define.js, every api/*.js
// file destructures it. Before the cross-file pass these calls produced no
// edges at all, so every renderer-side channel looked callerless.

const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace3-'))
const write3 = (rel, text) => {
  const abs = path.join(root3, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
write3('preloads/core/define.js', `const { ipcRenderer } = require('electron')
function invoke(channel, ...argSpec) {
  return (...args) => ipcRenderer.invoke(channel, ...args)
}
function send(channel, ...argSpec) {
  return (...args) => ipcRenderer.send(channel, ...args)
}
module.exports = { invoke, send }
`)
write3('preloads/api/desktop.js', `const { invoke, send } = require('../core/define')
contextBridge.exposeInMainWorld('electronAPI', {
  openDesktopWindow: invoke('desktop:open').roles('chat'),
  closeWindow: send('desktop:close'),
  local: invoke('desktop:local'),
})
function helper(ch) { return invoke(ch) }
module.exports = {}
`)
write3('main/handlers.js', `ipcMain.handle('desktop:open', async () => {})
ipcMain.on('desktop:close', () => {})
ipcMain.handle('desktop:local', async () => {})
`)
const exec3 = { agent: { session: { header: { cwd: root3, id: 'trace3' } } }, token: {} }
{
  const r = await tool.execute({ target: 'ipc:desktop:open' }, exec3)
  assert.equal(r.found, true)
  assert.ok(r.text.includes('preloads/api/desktop.js'), r.text)
  assert.ok(r.text.includes('（wrapper）'), r.text)
  assert.ok(r.text.includes('### preload 暴露（1）'), r.text)
  assert.ok(r.text.includes('`openDesktopWindow`'), r.text)
  ok('cross-file wrapper: imported invoke() resolves to a caller edge + named entry')
}
{
  const r = await tool.execute({ target: 'ipc:desktop:close' }, exec3)
  assert.ok(r.text.includes('（wrapper）'), r.text)
  assert.ok(r.text.includes('`closeWindow`'), r.text)
  assert.ok(r.text.includes('ipcMain.on（literal）'), r.text)
  ok('cross-file wrapper: send() carries command side through the module boundary')
}
{
  const r = await tool.execute({ target: 'api:openDesktopWindow' }, exec3)
  assert.equal(r.found, true)
  assert.ok(r.text.includes('静态推导'), r.text)
  assert.ok(r.text.includes('Trace ipc:desktop:open'), r.text)
  ok('api: resolves a preload object key without a declaration file')
}
{
  // A parameterised wrapper must stay unresolved — no phantom channel edges.
  const r = await tool.execute({ target: 'ipc:desktop:ghost' }, exec3)
  assert.equal(r.found, false)
  ok('cross-file wrapper: dynamic parameter never becomes a channel')
}
{
  const r = await tool.execute({ target: 'file:preloads/api/desktop.js' }, exec3)
  assert.ok(r.text.includes('外部包装调用（3）'), r.text)
  assert.ok(r.text.includes("invoke('desktop:open')"), r.text)
  assert.ok(r.text.includes('是否 IPC 取决于 ../core/define'), r.text)
  ok('file view: imported-wrapper calls are listed even before resolution')
}

// ---- Vue/Svelte single-file components ------------------------------------

{
  const root4 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-cmp-'))
  const exec4 = { agent: { session: { header: { cwd: root4, id: 'cmp' } } }, token: {} }
  const w = (rel, text) => {
    const abs = path.join(root4, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  w('cmp/dep.ts', 'export const v = 1\n')
  w('cmp/helper.ts', 'export const h = 1\n')
  w('cmp/helper.js', 'export const h = 1\n')
  // lang="ts" makes the script resolve with TS source substitution.
  w('cmp/panel.vue', `<template><div/></template>\n<script lang="ts">\nimport { v } from './dep'\nimport { h } from './helper'\n</script>\n`)
  // Vue external script declaration — a dependency edge on the component.
  w('cmp/external.vue', `<script src="./logic.ts"></script>\n`)
  w('cmp/logic.ts', 'export const l = 1\n')
  // Svelte module script in plain JS: require keeps JS extension order.
  w('cmp/anchor.svelte', `<script context="module">\nimport { v } from './dep'\nconst c = require('./helper')\n</script>\n<div/>\n`)
  const deps = async (target) => {
    const r = await tool.execute({ target }, exec4)
    assert.equal(r.found, true, target)
    return [...r.text.matchAll(/- → `([^`]+)`/g)].map(m => m[1])
  }
  assert.deepEqual(await deps('file:cmp/panel.vue'), ['cmp/dep.ts', 'cmp/helper.ts'])
  assert.deepEqual(await deps('file:cmp/external.vue'), ['cmp/logic.ts'])
  assert.deepEqual(await deps('file:cmp/anchor.svelte'), ['cmp/helper.js', 'cmp/dep.ts'])
  const view = await tool.execute({ target: 'file:cmp/panel.vue' }, exec4)
  assert.ok(view.text.includes('### 依赖 / 被依赖（2）'), view.text)
  // A section that is empty by construction is folded into the "无：" line
  // rather than printed as a header plus "- 无".
  assert.ok(/^- 无：.*IPC 注册/m.test(view.text), view.text)
  assert.doesNotMatch(view.text, /### IPC 注册（0）/, view.text)
  const impact = await tool.execute({ target: 'impact:cmp/dep.ts' }, exec4)
  assert.ok(impact.text.includes('cmp/panel.vue'), impact.text)
  assert.ok(impact.text.includes('cmp/anchor.svelte'), impact.text)
  ok('vue/svelte scripts expose dependency edges only; ts scripts prefer TS substitution, js keeps JS order')
  try { fs.rmSync(root4, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmp */ }
}

// ---- impact/file evidence carries imported names ---------------------------

{
  const root5 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-imp-'))
  const exec5 = { agent: { session: { header: { cwd: root5, id: 'imp' } } }, token: {} }
  const w = (rel, text) => {
    const abs = path.join(root5, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  w('lib/util.js', 'export const a = 1\nexport const b = 2\n')
  w('app.js', "import { a, b } from './lib/util.js'\nconst m = require('./lib/util.js')\nconsole.log(a, b, m)\n")
  const impact = await tool.execute({ target: 'impact:lib/util.js' }, exec5)
  assert.equal(impact.found, true)
  assert.ok(impact.text.includes('导入 {a, b'), impact.text)
  assert.ok(impact.analysis.edges[0].imports?.includes('a'), JSON.stringify(impact.analysis.edges[0]))
  const view = await tool.execute({ target: 'file:app.js' }, exec5)
  assert.ok(view.text.includes('导入 {a, b'), view.text)
  ok('impact/file rows carry the importer\'s bound names, answering which exports are used')
  try { fs.rmSync(root5, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmp */ }
}

// ---- Electron preload wiring + diagnostic hygiene --------------------------

{
  const root6 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-pre-'))
  const exec6 = { agent: { session: { header: { cwd: root6, id: 'pre' } } }, token: {} }
  const w = (rel, text) => {
    const abs = path.join(root6, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  for (const p of ['lit.js', 'join.js', 'chart.js']) w(`preloads/${p}`, 'window.x = 1\n')
  w('main.js', `const path = require('path')
const PRELOAD_ROLES = Object.freeze({ CHART: 'chart' })
const resolveProjectPreload = (root, role) => path.join(root, 'preloads', role + '.js')
const w1 = { webPreferences: { preload: 'preloads/lit.js' } }
const w2 = { webPreferences: { preload: path.join(__dirname, 'preloads', 'join.js') } }
const w3 = { webPreferences: { preload: resolveProjectPreload(__dirname, PRELOAD_ROLES.CHART) } }
const w4 = { webPreferences: { preload: PRELOAD_ROLES.CHART } }
const w5 = { webPreferences: { preload: 'ready' } }
module.exports = { w1, w2, w3, w4, w5 }
`)
  w('noise.js', "require('left-pad')\nexport const n = 1\n")
  // Cross-file const: main2.js destructures the table, so its own const
  // resolution fails and the link graph must retry via preloadPaths' export.
  w('preloadPaths.js', `const PRELOAD_ROLES = Object.freeze({ CHART: 'chart' })
module.exports = { PRELOAD_ROLES }
`)
  w('main2.js', "const { PRELOAD_ROLES } = require('./preloadPaths')\nconst w = { webPreferences: { preload: PRELOAD_ROLES.CHART } }\nmodule.exports = { w }\n")
  w('.workbuddy/_dsh/asar-out/broken.js', 'const const const broken(((\n')
  w('.hostcache/_dsh/dump.js', 'const const const broken(((\n')
  // Same-reason floods in an ordinary dot-directory collapse to two header rows.
  w('.vendor/gen/min1.js', 'const const const broken(((\n')
  w('.vendor/gen/min2.js', 'const const const broken(((\n')
  w('.vendor/gen/min3.js', 'const const const broken(((\n')
  const deps = async (target) => {
    const r = await tool.execute({ target }, exec6)
    assert.equal(r.found, true, target)
    return r
  }
  const lit = await deps('impact:preloads/lit.js')
  assert.ok(lit.text.includes('main.js'), lit.text)
  assert.ok(lit.analysis.edges.some(e => e.from === 'main.js' && e.kind === 'preload' && e.evidence.confidence === 'certain'), JSON.stringify(lit.analysis.edges))
  const chart = await deps('impact:preloads/chart.js')
  assert.ok(chart.analysis.edges.some(e => e.from === 'main.js' && e.kind === 'preload' && e.evidence.confidence === 'candidate'), JSON.stringify(chart.analysis.edges))
  const join = await deps('impact:preloads/join.js')
  assert.ok(join.analysis.edges.some(e => e.from === 'main.js' && e.evidence.confidence === 'certain'), JSON.stringify(join.analysis.edges))
  assert.equal(chart.partialFiles, 3, 'only .vendor/gen partials count; _dsh-marked containers stay outside the scan')
  assert.ok(chart.scanned <= 10, `scanned=${chart.scanned}`)
  assert.ok(/另有 \d+ 项外部包/.test(chart.text), chart.text)
  assert.ok(chart.text.includes('已折叠') && chart.text.includes('同目录另有 2 个'), chart.text)
  const certain = await tool.execute({ target: 'impact:preloads/chart.js', edgeMode: 'certain' }, exec6)
  assert.equal(certain.analysis.totalFiles, 0, 'role-resolved preload wiring is a candidate, not certain')
  const cross = await deps('impact:preloads/chart.js')
  assert.ok(cross.analysis.edges.some(e => e.from === 'main2.js' && e.kind === 'preload' && e.evidence.confidence === 'candidate'), JSON.stringify(cross.analysis.edges))
  ok('preload wiring closes the impact gap for preloads/ (literal/join/const/role); .workbuddy noise and external-package counts stay out of per-query diagnostics')
  try { fs.rmSync(root6, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmp */ }
}

rmRoot()
try { fs.rmSync(root2, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmp */ }
try { fs.rmSync(root3, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmp */ }

console.log(`\n${passed} trace groups passed`)
