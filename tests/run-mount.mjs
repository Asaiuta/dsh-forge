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
const plugin = ctx.plugin(apply, { surface: 'full' })
// Services were provided before mount; activation should be immediate.
await new Promise((resolve) => setImmediate(resolve))

assert.equal(registeredTools.length, 10, `expected 10 tools, got ${registeredTools.length}`)
assert.equal(registeredCommands.length, 1, 'expected 1 command')
assert.deepEqual(
  registeredTools.map((d) => d.name),
  ['ff_find', 'ff_grep', 'ff_symbols', 'ff_edit', 'ff_history', 'ff_rollback', 'ff_file', 'ff_trace', 'ff_verify', 'ff_project'],
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

reachable = new Set(['ff_grep'])
const subset = section.text({})
assert.ok(subset.includes('ff_grep'), 'guidance must name the reachable tool')
assert.ok(!/ff_symbols|ff_find|ff_edit|ff_trace|ff_file|ff_history|ff_rollback|ff_verify|ff_project/.test(subset), 'a subset must not promise unavailable capabilities')
reachable = new Set(registeredTools.map(d => d.name))
// Both host shapes, because the routing line differs and only one of them is
// allowed to mention a built-in that is not there. A registry with no built-in
// `grep`/`glob` is a real host (an SDK-only embedder), and sending that model to
// "the built-in grep" is a dead end it cannot recover from.
const bareHost = section.text({})
assert.match(bareHost, /Search contents → ff_grep: fuzzy by default/,
  'a host without a built-in grep must be pointed at ff_grep, not at a tool it lacks')
assert.match(bareHost, /Find files → ff_find: fuzzy names and typos/)
assert.doesNotMatch(bareHost, /built-in (glob|grep) for/, 'no built-in may be advertised when the scope has none')
reachable = new Set([...registeredTools.map(d => d.name), 'grep', 'glob'])
const rendered = section.text({})
assert.ok(/built-in glob|built-in grep/i.test(rendered), 'guidance must state the division of labour against the built-in tools')
assert.ok(rendered.includes('built-in'), 'guidance must name what stays with the built-in tools')
assert.equal(section.text({}), rendered, 'rendering must be stable across calls')

// Task-first shape. The capability-first version described tools by layer, and
// a real session asked to explain a plugin read four files whole without ever
// calling the outline view — the "prefer over reading a whole file to learn its
// shape" clause was present but sat third in a bullet whose subject was three
// tool names, so there was no line matchable against "understand this repo".
// These two assertions keep a task clause attached to the tool that answers it,
// and keep the text covering the surface that is actually registered.
assert.doesNotMatch(rendered, /path=<file>#/, 'a host without symbol-read augmentation must never advertise specialist source reads')
assert.match(rendered, /view=outline/, 'the outline discovers names and source locations')
assert.match(rendered, /view=definitions with symbol=<name>/, 'a known symbol is located through the supported definitions view')
assert.match(rendered, /built-in read using the returned file and line range/, 'source bytes must be read through the built-in window reader')
// The target enum and the edgeMode mechanics are the parameter descriptions
// verbatim, so the guidance no longer repeats them (see the dedup note in
// src/guidance.ts). What it must still carry is what no schema states: the
// measured correction that a literal registration is not a dependency, and the
// capture→ff_edit snapshotId link between two tools.
assert.ok(rendered.includes('not a dependency — take it as given'), 'Trace guidance must stop the hand-reverification of a literal edge (Q8)')
assert.ok(/capture=true returns a snapshotId that a later ff_edit checks/.test(rendered), 'Trace capture must name the tool that consumes the baseline')
assert.ok(!rendered.includes('anything the sandbox refuses'), 'a denial must not become a tool-switching instruction')
const registeredNames = registeredTools.map((definition) => definition.name)
const uncovered = registeredNames.filter((name) => !rendered.includes(name))
assert.deepEqual(uncovered, [], `every registered tool must appear in the guidance, uncovered: ${uncovered.join(', ')}`)

// --- guidance must not re-bill a fact a schema already carries --------------
// Measured 2026-10-31: guidance went 506 → 202 tok (additive) by deleting, line
// by line, every sentence whose content a tool schema already states. This fence
// is why the number stays down. Each entry pairs a phrase that must NOT be in the
// prompt with the schema text that does state it, so a failure says where the
// fact already lives — and the second assertion fails if the schema stops owning
// the fact, which is the case where the guidance would legitimately need it back.
const schemaText = registeredTools.map((definition) => JSON.stringify(definition)).join('\n')
const REBILLED = [
  ['ff_find surface', /mode=(name|glob)/, /Fuzzy file-name or path/],
  ['ff_trace target enum', /impact:|ffi:<name>/, /ffi:<name>/],
  ['ff_trace edgeMode mechanics', /edgeMode/, /certain excludes them/],
  ['ff_edit ticket protocol', /ticket, choice/, /ticket plus choice/],
  ['ff_edit verify whitelist', /verify=\[bridge/, /static checks over it/],
  ['ff_history checks semantics', /checks=true/, /CURRENT applicability/],
  ['ff_file read-before-write', /read before chang/i, /Read before writing/],
  ['host-path re-rooting', /Pass path at any/, /re-roots onto it/],
  ['ff_file read-before-write', /Read before writing/, /Read before writing/],
  ['ff_rollback dry run', /dry[- ]run first/, /Inspect the default dry run/],
]
for (const [name, forbidden, owner] of REBILLED) {
  assert.ok(!forbidden.test(rendered), `${name} is back in the guidance — a schema already states it`)
  assert.ok(owner.test(schemaText), `${name}: no schema states this any more, so the guidance may need to carry it again`)
}


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
blindCtx.plugin(apply, { surface: 'full' })
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
