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
  assert.ok(r.text.includes('`VCPUI` · 第 2 个脚本'), r.text)
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
  ok('file: exposeInMainWorld keys rendered')
}

// ---- failure modes --------------------------------------------------------

{
  const bad = await tool.execute({ target: 'wat:foo' }, exec)
  assert.ok(bad.error && /target like ipc:/.test(bad.error))
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

rmRoot()
try { fs.rmSync(root2, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmp */ }

console.log(`\n${passed} trace groups passed`)
