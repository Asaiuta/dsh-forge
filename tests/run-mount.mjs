// Real-fork mount test: mounts dsh-forge's apply() through the actual
// @deepseek-ai/cordis fork (service resolution, generator-lifecycle protocol,
// disposal on unload) — the path the DSH host uses and that fake-ctx probes
// cannot cover.
//
// Also pins the prompt-guidance contract: the section's name, its placement in
// the plugin band, and the visibility gate (guidance must vanish together with
// a tool the scope cannot reach, and must survive an unreadable registry).
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Context } = require('@deepseek-ai/cordis')
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const ctx = new Context()

const registeredTools = []
const registeredCommands = []
const registeredSections = []
const disposersRun = []
let disposedFsObserved = 0

// Tool names the fake registry reports as reachable to the rendering scope.
// Empty by default: a section must not promise tools the session cannot see.
let reachable = new Set()

ctx.provide('tools', {
  register(definition) {
    registeredTools.push(definition)
    return () => disposersRun.push('tool:' + definition.name)
  },
  get(name) {
    return reachable.has(name) ? { name } : undefined
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
ctx.provide('systemPrompt', {
  section(section) {
    registeredSections.push(section)
    return () => disposersRun.push('section:' + section.name)
  },
})

// No config argument: the second parameter of `ctx.plugin` *is* the plugin's
// config, so the previous `'dsh-forge'` label was being handed to `apply` as a
// string. `resolveConfig` now rejects that, which is the behaviour we want from
// a real misconfiguration.
const plugin = ctx.plugin(apply)
// Services were provided before mount; activation should be immediate.
await new Promise((resolve) => setImmediate(resolve))

assert.equal(registeredTools.length, 10, `expected 10 tools, got ${registeredTools.length}`)
assert.equal(registeredCommands.length, 1, 'expected 1 command')
assert.deepEqual(
  registeredTools.map((d) => d.name),
  ['ffgrep', 'fffind', 'ffedit', 'ffhistory', 'ffrollback', 'ff_file', 'ff_read', 'fftrace', 'ffcheck', 'ff_cards'],
  'tool registration order changed',
)
assert.equal(registeredCommands[0].name, 'forge-status')

// --- prompt guidance ------------------------------------------------------
assert.equal(registeredSections.length, 1, `expected 1 prompt section, got ${registeredSections.length}`)
const section = registeredSections[0]
assert.equal(section.name, 'plugin:dsh-forge')
assert.equal(section.order, 130, 'section must stay in the 60-210 plugin band, ahead of PLAN_POLICY (500)')
assert.ok(section.order > 0 && section.order < 500, 'section must sort before PLAN_POLICY and every built-in TOOL_* slot')
assert.equal(typeof section.text, 'function', 'section text must be a provider so the visibility gate can render per scope')
assert.equal(section.text({}), '', 'no reachable forge tool must render no guidance at all')

reachable = new Set(['ffgrep'])
const subset = section.text({})
assert.ok(subset.includes('ffgrep'), 'guidance must name the reachable tool')
assert.ok(!/ff_read|fffind|ffedit|fftrace|ff_file|ffhistory|ffrollback|ff_cards/.test(subset), 'a subset must not promise unavailable capabilities')
reachable = new Set(registeredTools.map(d => d.name))
const rendered = section.text({})
assert.ok(/prefer over glob|Prefer over glob/i.test(rendered), 'guidance must state the division of labour against the built-in tools')
assert.ok(rendered.includes('built-in'), 'guidance must name what stays with the built-in tools')
assert.equal(section.text({}), rendered, 'rendering must be stable across calls')

// Task-first shape. The capability-first version described tools by layer, and
// a real session asked to explain a plugin read four files whole without ever
// calling the outline view — the "prefer over reading a whole file to learn its
// shape" clause was present but sat third in a bullet whose subject was three
// tool names, so there was no line matchable against "understand this repo".
// These two assertions keep a task clause attached to the tool that answers it,
// and keep the text covering the surface that is actually registered.
assert.ok(/view=outline first/.test(rendered), 'the understand-a-module task must name ff_read view=outline as its first move')
assert.ok(rendered.includes('impact:src/file.ts') && rendered.includes('ffi:<name>'), 'Trace guidance must give actionable dependency and native-boundary queries')
assert.ok(!rendered.includes('anything the sandbox refuses'), 'a denial must not become a tool-switching instruction')
const registeredNames = registeredTools.map((definition) => definition.name)
const uncovered = registeredNames.filter((name) => !rendered.includes(name))
assert.deepEqual(uncovered, [], `every registered tool must appear in the guidance, uncovered: ${uncovered.join(', ')}`)

// An unreadable registry keeps the guidance: a refused lookup is not proof the
// tool is gone.
const blindCtx = new Context()
const blindSections = []
blindCtx.provide('tools', {
  register() { return () => {} },
  get() { throw new Error('registry unavailable') },
})
blindCtx.provide('commands', { register() { return () => {} } })
blindCtx.provide('fs', { observeNativeRead() {} })
blindCtx.provide('systemPrompt', { section(s) { blindSections.push(s); return () => {} } })
blindCtx.plugin(apply)
await new Promise((resolve) => setImmediate(resolve))
assert.equal(blindSections.length, 1, 'section must still register when the registry throws')
assert.ok(blindSections[0].text({}).length > 0, 'a throwing registry lookup must keep the guidance')

// --- lifecycle ------------------------------------------------------------
// Unload must run every collected disposable: one per tool register, plus the
// command and the section. Counted off the registry rather than hardcoded — the
// tool surface is expected to change, the lifecycle contract is not.
plugin.dispose()
await new Promise((resolve) => setImmediate(resolve))
const expectedDisposers = registeredTools.length + registeredCommands.length + registeredSections.length
assert.equal(disposersRun.length, expectedDisposers, `expected ${expectedDisposers} disposables, got ${disposersRun.length}`)
assert.ok(disposersRun.includes('section:plugin:dsh-forge'), 'the section disposer must be collected')

console.log(`run-mount: ${registeredTools.length} tools + 1 command + 1 section (order 130, gated) registered, ${disposersRun.length} disposables on unload — OK`)
