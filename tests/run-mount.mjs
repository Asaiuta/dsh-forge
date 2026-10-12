// Real-fork mount test: mounts dsh-forge's apply() through the actual
// @deepseek-ai/cordis fork (service resolution, generator-lifecycle protocol,
// disposal on unload) — the path the DSH host uses and that fake-ctx probes
// cannot cover.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Context } = require('@deepseek-ai/cordis')
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const ctx = new Context()

const registeredTools = []
const registeredCommands = []
const disposersRun = []
let disposedFsObserved = 0

ctx.provide('tools', {
  register(definition) {
    registeredTools.push(definition)
    return () => disposersRun.push('tool:' + definition.name)
  },
})
ctx.provide('commands', {
  register(definition) {
    registeredCommands.push(definition)
    return () => disposersRun.push('command:' + (definition.name ?? definition.id))
  },
})
ctx.provide('fs', {
  observeNativeRead() { disposedFsObserved++ },
})

const plugin = ctx.plugin(apply, 'dsh-forge')
// Services were provided before mount; activation should be immediate.
await new Promise((resolve) => setImmediate(resolve))

assert.equal(registeredTools.length, 15, `expected 15 tools, got ${registeredTools.length}`)
assert.equal(registeredCommands.length, 1, 'expected 1 command')
assert.deepEqual(
  registeredTools.map((d) => d.name),
  ['ffgrep', 'fffind', 'fff_multi_grep', 'ff_outline', 'ff_find_symbol', 'ff_read_symbol', 'ffedit', 'ffresolve', 'ffhistory', 'ffrollback', 'ff_project', 'ff_diff', 'ff_file', 'ff_read', 'fftrace'],
  'tool registration order changed',
)
assert.equal(registeredCommands[0].name, 'forge-status')

// Unload must run every collected disposable (15 registers + pool/workers).
plugin.dispose()
await new Promise((resolve) => setImmediate(resolve))
assert.ok(disposersRun.length >= 16, `expected >=16 disposables run, got ${disposersRun.length}`)

console.log(`run-mount: 15 tools + 1 command registered, ${disposersRun.length} disposables on unload — OK`)
