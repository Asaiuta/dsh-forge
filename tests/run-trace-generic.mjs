// Generic Electron bridge fixture: no VCPChat registry/global names and no
// declarations file. Covers exposed-object aliases and renderer member sites.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTraceTool } from '../lib/tools-trace.js'
import { resetFactsCache } from '../lib/ast.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-generic-'))
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const exec = { agent: { session: { header: { cwd: root, id: 'trace-generic' } } }, token: {} }

try {
  write('preloads/desktop.cjs', `const methods = Object.freeze({
  openSettings: () => {},
  onWorkspaceReady: callback => {},
})
contextBridge.exposeInMainWorld('desktopBridge', methods)
`)
  write('renderer/settings.cjs', `const bridge = window.desktopBridge
bridge.openSettings()
window.desktopBridge.onWorkspaceReady(() => {})
`)

  resetFactsCache()
  const tool = createTraceTool()
  const one = await tool.execute({ target: 'exposes:desktopBridge' }, exec)
  assert.equal(one.found, true)
  assert.equal(one.decls, 'absent')
  assert.ok(one.text.includes('`desktopBridge`'), one.text)
  assert.match(one.text, /`openSettings` ×1：`renderer\/settings\.cjs:\d+`/)
  assert.match(one.text, /`onWorkspaceReady` ×1：`renderer\/settings\.cjs:\d+`/)
  assert.ok(one.text.includes('仅反映静态可见结果，动态属性名或运行时构造可能未覆盖'), one.text)
  assert.ok(!one.text.includes('electronAPI') && !one.text.includes('chatAPI'), one.text)
  ok('custom Electron global, exposed-object alias and per-key renderer references work without VCPChat names')

  const all = await tool.execute({ target: 'exposes:' }, exec)
  assert.equal(all.found, true)
  assert.ok(all.text.includes('`desktopBridge`'), all.text)
  assert.ok(!all.text.includes('electronAPI') && !all.text.includes('chatAPI'), all.text)
  ok('aggregate exposes query stays application-name agnostic')

  write('renderer/settings.html', `<html><body>
<script src="settings.cjs"></script>
<script>
const inlineBridge = window.desktopBridge
inlineBridge.openSettings()
</script>
</body></html>
`)
  const page = await tool.execute({ target: 'page:renderer/settings.html' }, exec)
  assert.equal(page.found, true)
  // settings.cjs: alias call + direct call; inline body: alias call.
  assert.match(page.text, /`desktopBridge`：2 个 API（3 处调用）/, page.text)
  ok('page bridge usage counts alias-resolved and inline-script references like exposes:')
} finally {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
}

console.log(`\n${passed} generic trace groups passed`)
