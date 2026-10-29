// The registration switch: `registration: additive | takeover`.
//
// Additive is pinned by run-mount.mjs (ten global tools, one command, one gated
// section). This file covers what is new: the config surface, the plan, the
// prompt text that has to follow the plan, and the takeover mount against the
// real cordis fork — global tools minus the taken-over one, one scoped
// registration per agent under the native name, and two independent owners for
// its disposer (the agent scope and the plugin).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Context } = require('@deepseek-ai/cordis')
const { apply, Config } = await import(new URL('../lib/index.js', import.meta.url).href)
const { resolveConfig, TAKE_OVER_CAPABLE } = await import(new URL('../lib/config.js', import.meta.url).href)
const { planRegistration, surfaceFor, createScopeInstaller } = await import(
  new URL('../lib/registration.js', import.meta.url).href
)
const { ADDITIVE_SURFACE, FORGE_CAPABILITIES, forgeGuidance, surfaceNames, visibleForgeText } = await import(
  new URL('../lib/guidance.js', import.meta.url).href
)

let passed = 0
const ok = (name) => console.log(`ok ${++passed} - ${name}`)

// --- config ---------------------------------------------------------------
{
  const bare = { registration: 'additive', takeover: [], prewarm: true, cards: { distill: 'session' } }
  assert.deepEqual(resolveConfig(undefined), bare)
  assert.deepEqual(resolveConfig({}), bare)
  assert.deepEqual(resolveConfig({ prewarm: false }), { registration: 'additive', takeover: [], prewarm: false, cards: { distill: 'session' } })
  assert.throws(() => resolveConfig({ prewarm: 'yes' }), /must be true or false/)
  ok('an unconfigured row is additive, takes nothing over, and pre-warms')
}
{
  // Test the schema path the loader runs BEFORE apply/resolveConfig. Passing
  // apply alone to ctx.plugin omits this step and missed the activation bug.
  for (const raw of [{}, { registration:'takeover', takeover:['read','glob','grep'] }, { cards:{distill:'session'} }, { cards:{distill:'off'} }]) {
    const checked = Config['~standard'].validate(structuredClone(raw))
    assert.ok(!checked.issues, JSON.stringify(checked.issues))
    assert.equal(resolveConfig(checked.value).cards.endpoint, undefined)
  }
  assert.ok(Config['~standard'].validate({cards:{endpoint:{}}}).issues)
  const missingEndpoint = Config['~standard'].validate({cards:{distill:'endpoint'}})
  assert.ok(!missingEndpoint.issues)
  assert.throws(()=>resolveConfig(missingEndpoint.value), /needs config\.cards\.endpoint/)
  ok('the loader schema permits default cards settings without materializing an invalid endpoint')
}
{
  assert.deepEqual(resolveConfig({ registration: 'takeover' }).takeover, [...TAKE_OVER_CAPABLE],
    'takeover with no list means everything forge can serve in native shape')
  assert.deepEqual(resolveConfig({ registration: 'takeover', takeover: ['read'] }).takeover, ['read'])
  ok('takeover defaults to the capability table and accepts an explicit list')
}
{
  assert.throws(() => resolveConfig({ registration: 'both' }), /registration must be one of/)
  assert.throws(() => resolveConfig('takeover'), /config must be a mapping/)
  assert.throws(() => resolveConfig({ takeover: 'read' }), /must be a list/)
  ok('a malformed mode or list is rejected instead of falling back silently')
}
{
  // The names forge *cannot* serve in native shape are the cases worth an
  // error: a user who writes `edit` expects the built-in edit replaced, and
  // ffedit's anchored matcher rescues an ambiguous `old_string` by rule where
  // the built-in refuses it — no fallback can turn that into the built-in's
  // answer, because by the time the ambiguity exists the built-in only has an
  // error to offer. `glob` and `grep` are servable — each has a native branch
  // that keeps the built-in's argument contract, and `grep` hands the calls it
  // cannot answer honestly back to the built-in — so both must resolve.
  assert.deepEqual(resolveConfig({ registration: 'takeover', takeover: ['glob'] }).takeover, ['glob'])
  assert.deepEqual(resolveConfig({ registration: 'takeover', takeover: ['grep'] }).takeover, ['grep'])
  assert.deepEqual(resolveConfig({ registration: 'takeover', takeover: ['read', 'grep'] }).takeover, ['read', 'grep'])
  assert.throws(() => resolveConfig({ registration: 'takeover', takeover: ['edit'] }), /cannot serve "edit"/)
  assert.throws(() => resolveConfig({ registration: 'takeover', takeover: ['bash'] }), /cannot serve "bash"/)
  assert.throws(() => resolveConfig({ registration: 'takeover', takeover: ['read', 'read'] }), /twice/)
  ok('unsupported takeover names are rejected with the supported list; glob and grep are served')
}

// --- plan -----------------------------------------------------------------
const rows = FORGE_CAPABILITIES.map((capability) => ({
  forge: ADDITIVE_SURFACE[capability],
  native: capability === 'read' ? 'read' : undefined,
  build: (as) => ({ name: as ?? ADDITIVE_SURFACE[capability] }),
}))

{
  const plan = planRegistration(resolveConfig(undefined), rows)
  assert.equal(plan.global.length, 10)
  assert.deepEqual(plan.scoped, [])
  ok('additive puts the whole table on the global registry')
}
{
  const plan = planRegistration(resolveConfig({ registration: 'takeover', takeover: ['read'] }), rows)
  assert.equal(plan.global.length, 9)
  assert.ok(!plan.global.some((row) => row.forge === 'ff_read'), 'the taken-over row must not also register globally')
  assert.deepEqual(plan.scoped.map((row) => [row.forge, row.native]), [['ff_read', 'read']])
  ok('takeover moves exactly the listed row into the scoped list')
}
{
  const plan = planRegistration(resolveConfig({ registration: 'takeover', takeover: ['read'] }), rows)
  const surface = surfaceFor(plan, ADDITIVE_SURFACE)
  assert.equal(surface.read, 'read')
  assert.equal(surface.grep, 'ffgrep')
  assert.equal(surfaceNames(surface).length, 10)
  ok('the surface renames only the taken-over capability')
}

// --- prompt text ----------------------------------------------------------
{
  const additive = forgeGuidance(ADDITIVE_SURFACE)
  assert.ok(additive.includes('ff_read view=outline first'))
  assert.ok(additive.includes('ffgrep over grep'))
  ok('the additive text announces task-specific read and grep capabilities')
}
{
  const takeover = forgeGuidance(surfaceFor(planRegistration(
    resolveConfig({ registration: 'takeover', takeover: ['read'] }), rows,
  ), ADDITIVE_SURFACE))
  assert.ok(takeover.includes('read view=outline first'), 'the outline clause must name the registered tool')
  assert.ok(!takeover.includes('ff_read'), 'a taken-over name must not appear in the guidance')
  assert.ok(takeover.includes('ffgrep'), 'untouched tools keep their own names')
  ok('the takeover text announces the names that were actually registered')
}
{
  const native = { ...ADDITIVE_SURFACE, find: 'glob', grep: 'grep', read: 'read' }
  const guidance = forgeGuidance(native)
  assert.ok(!guidance.includes('mode=name') && !guidance.includes('patterns for'), 'takeover search tools must not promise additive-only arguments')
  const scope = {}, seen = []
  const provider = visibleForgeText({ get(name, gotScope) { seen.push(gotScope); return name === 'fftrace' ? {} : undefined } }, native)
  const subset = provider({ scope })
  assert.ok(subset.includes('fftrace') && !subset.includes('ffedit') && !subset.includes('view=outline'))
  assert.ok(seen.every(value => value === scope))
  const fallback = visibleForgeText({ get(name) { return name === 'read' ? {name:'read',parameters:{file_path:{type:'string'}}} : undefined } }, native)
  assert.equal(fallback({scope}), '', 'a native built-in left after failed takeover must not promise Forge parameters')
  ok('scoped guidance advertises only available capabilities and follows native search contracts')
}

// --- takeover mount against the real fork ---------------------------------
function world() {
  const ctx = new Context()
  const globalTools = []
  const sections = []
  const agents = []
  ctx.provide('tools', {
    register(definition) {
      globalTools.push(definition.name)
      return () => globalTools.splice(globalTools.indexOf(definition.name), 1)
    },
    // Every name resolves: the gate itself is covered by run-mount.mjs, and
    // here an *empty* section would hide the text this file asserts on. In the
    // real host `get(name, scope)` resolves the agent-scoped shadow.
    get(name) { return { name, dshForgeName: ({read:'ff_read',glob:'fffind',grep:'ffgrep'})[name] ?? name } },
  })
  ctx.provide('commands', { register() { return () => {} } })
  ctx.provide('fs', { observeNativeRead() {} })
  ctx.provide('systemPrompt', { section(s) { sections.push(s); return () => {} } })
  ctx.provide('agents', { list() { return agents } })
  return { ctx, globalTools, sections, agents }
}

function scopedAgent() {
  const scope = new Context()
  const registered = []
  const disposed = []
  scope.provide('tools', {
    register(definition) {
      registered.push(definition)
      return () => disposed.push(definition.name)
    },
  })
  return { agent: { ctx: scope }, registered, disposed, scope }
}

{
  const { ctx, globalTools, sections, agents } = world()
  const plugin = ctx.plugin(apply, { registration: 'takeover', takeover: ['read'] })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(globalTools.length, 9, `expected 9 global tools, got ${globalTools.length}: ${globalTools}`)
  assert.ok(!globalTools.includes('read'), 'the taken-over name must not be registered globally')
  assert.ok(!globalTools.includes('ff_read'), 'the taken-over tool must not exist under both names')

  const first = scopedAgent()
  agents.push(first.agent)
  ctx.emit('agent/created', { agent: first.agent })
  assert.deepEqual(first.registered.map((definition) => definition.name), ['read'],
    'the taken-over tool registers into the agent scope under the native name')
  // `defineTool` compiles the argument spec into JSON Schema, which is what the
  // model is shown: the native arguments have to survive that compile step.
  const scopedProps = Object.keys(first.registered[0].parameters?.properties ?? {})
  assert.ok(scopedProps.includes('file_path') && scopedProps.includes('offset'),
    `the scoped definition must carry the built-in argument shape, got: ${scopedProps.join(', ')}`)
  ok('takeover mounts one native-named tool per agent and keeps the rest global')

  // The guidance section is generated from the served surface, so it must name
  // `read` — a section promising `ff_read` would describe a tool that is gone.
  const text = sections[0].text({})
  assert.ok(text.includes('read view=outline'), 'guidance must follow the taken-over name')
  assert.ok(!text.includes('ff_read'))
  ok('guidance follows the registration surface')

  const second = scopedAgent()
  ctx.emit('agent/created', { agent: second.agent })
  assert.deepEqual(second.registered.map((definition) => definition.name), ['read'],
    'a second agent gets its own registration')
  ctx.emit('agent/disposed', { agent: second.agent })
  assert.deepEqual(second.disposed, ['read'], 'agent disposal must remove it from that scope')
  assert.deepEqual(first.disposed, [], 'one agent going away must not touch another')
  ok('disposal is per agent')

  // Plugin unload disposes what is left: practices.md requires both owners,
  // because unloading the plugin does not dispose `agent.ctx` by itself.
  plugin.dispose()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(first.disposed, ['read'], 'plugin unload must remove the remaining scoped registration')
  ok('plugin unload tears down scoped registrations')
}

// --- a host with no agent registry ---------------------------------------
{
  // Config that cannot be honoured must fail activation with the reason, not
  // silently serve nothing: the model would get no `read` at all.
  const fake = {
    tools: { register() { return () => {} } },
    commands: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
  }
  const drive = () => {
    const iterator = apply(fake, { registration: 'takeover', takeover: ['read'] })
    for (;;) {
      const step = iterator.next()
      if (step.done) return
    }
  }
  assert.throws(drive, /needs the host agent registry/)
  ok('takeover on a host without agents fails activation with the reason')
}

// --- the same absence, through the real fork ------------------------------
{
  // A plain object cannot catch this one: the context proxy in front of a
  // *plugin* fiber resolves a service property through the inject graph, so
  // `host.agents` on a host that never provided it throws
  // `cannot get property "agents" without inject` instead of reading as
  // undefined. An "optional" service written that way is mandatory in practice,
  // and the failure lands on whatever the optional path was guarding — here,
  // both the takeover refusal and the default-on pre-warm.
  const ctx = new Context()
  const sections = []
  ctx.provide('tools', { register() { return () => {} }, get(name) { return { name } } })
  ctx.provide('commands', { register() { return () => {} } })
  ctx.provide('fs', { observeNativeRead() {} })
  ctx.provide('systemPrompt', { section(section) { sections.push(section); return () => {} } })

  await assert.rejects(
    async () => { await ctx.plugin(apply, { registration: 'takeover', takeover: ['read'] }) },
    /needs the host agent registry/,
    'the refusal must be the explained one, not a proxy error',
  )
  ok('a real fork without `agents` refuses takeover with the reason, not a proxy error')

  await ctx.plugin(apply, {})
  assert.equal(sections.length, 1, 'pre-warming an absent registry must not stop activation')
  ok('additive mode with the default-on pre-warm activates on a host serving no agent registry')
}

console.log(`\n${passed} registration groups passed`)
