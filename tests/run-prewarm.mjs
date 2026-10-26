// Background pre-warm: the policy half, without a native index.
//
// `schedulePrewarm` exists as its own function so this file can pin the three
// things that are easy to get wrong and invisible in a manual run:
//
//   nothing inline   the build is *delayed*, because the native scan blocks the
//                    JS thread once (measured p99 531 ms on a 5k-file tree) and
//                    a plugin that stalls session start to save a later query
//                    4 ms has traded a good trade for a bad one.
//   once per cwd     two agents on one workspace must not queue two scans, and
//                    a reload must not re-index what was just indexed.
//   cancelled on unload  an unloaded plugin has no pool left to warm.
//
// The finder pool is not touched here: warming is a callback, so the decision
// logic is testable on its own (the cost of an actual build is in
// `.tmp-analysis/probe-prewarm.mjs`, not in the suite).
import assert from 'node:assert/strict'

const { schedulePrewarm } = await import(new URL('../lib/index.js', import.meta.url).href)

let passed = 0
const ok = (name) => console.log(`ok ${++passed} - ${name}`)

/** An agent whose workspace root is `cwd` (any other shape is a real case too). */
const agentIn = (cwd) => (cwd === undefined ? {} : { session: { header: { cwd } } })

/** A host with a hand-firable `agent/created` and a fixed agent list. */
function host(agents = []) {
  const listeners = new Map()
  return {
    agents: { list: () => agents },
    on(event, listener) {
      const entry = { listener, off: false }
      listeners.set(event, [...(listeners.get(event) ?? []), entry])
      return () => { entry.off = true }
    },
    fire(payload) {
      for (const entry of listeners.get('agent/created') ?? []) if (!entry.off) entry.listener(payload)
    },
    listening() {
      return (listeners.get('agent/created') ?? []).filter((entry) => !entry.off).length
    },
  }
}

/** A scheduler that records instead of waiting, so delay and count are observable. */
function queue() {
  const entries = []
  const schedule = (run, delayMs) => {
    const entry = { run, delayMs, cancelled: false }
    entries.push(entry)
    return () => { entry.cancelled = true }
  }
  return { entries, schedule, fire: (index = 0) => entries[index].run() }
}

/** A warm() recorder. */
function warmer() {
  const seen = []
  return { seen, warm: (cwd) => { seen.push(cwd) } }
}

// --- delayed, not inline ---------------------------------------------------
{
  const h = host()
  const q = queue()
  const w = warmer()
  schedulePrewarm(h, w.warm, { schedule: q.schedule })
  h.fire({ agent: agentIn('/w') })

  assert.deepEqual(w.seen, [], 'the build must not run inside the agent/created listener')
  assert.equal(q.entries.length, 1, 'one agent means one queued build')
  assert.ok(q.entries[0].delayMs > 0, `the build must be delayed, got ${q.entries[0].delayMs}ms`)

  q.fire(0)
  assert.deepEqual(w.seen, ['/w'], 'firing the timer is what performs the build')
  ok('the build is queued with a delay and runs when the delay elapses')
}

// --- once per workspace ----------------------------------------------------
{
  const h = host()
  const q = queue()
  const w = warmer()
  schedulePrewarm(h, w.warm, { schedule: q.schedule })
  h.fire({ agent: agentIn('/w') })
  h.fire({ agent: agentIn('/w') })
  h.fire({ agent: agentIn('/w') })
  assert.equal(q.entries.length, 1, 'three agents in one workspace must queue one scan')

  h.fire({ agent: agentIn('/other') })
  assert.equal(q.entries.length, 2, 'a different workspace is a different scan')
  ok('one build per workspace root, not one per agent')
}

{
  // The same workspace arriving *after* its build finished must still be a
  // no-op: a reload re-creates the agent, not the index.
  const h = host()
  const q = queue()
  const w = warmer()
  schedulePrewarm(h, w.warm, { schedule: q.schedule })
  h.fire({ agent: agentIn('/w') })
  q.fire(0)
  h.fire({ agent: agentIn('/w') })
  assert.equal(q.entries.length, 1, 'a warmed workspace must not be warmed again')
  ok('a second session on a warmed workspace is free')
}

// --- agents that already exist ---------------------------------------------
{
  const h = host([agentIn('/already'), agentIn('/already')])
  const q = queue()
  const w = warmer()
  schedulePrewarm(h, w.warm, { schedule: q.schedule })
  assert.equal(q.entries.length, 1, 'agents live at activation get warmed, once each workspace')
  q.fire(0)
  assert.deepEqual(w.seen, ['/already'])
  ok('agents that already exist when the row activates are warmed too')
}

// --- unload -----------------------------------------------------------------
{
  const h = host()
  const q = queue()
  const w = warmer()
  const dispose = schedulePrewarm(h, w.warm, { schedule: q.schedule })
  h.fire({ agent: agentIn('/w') })
  dispose()

  assert.equal(q.entries[0].cancelled, true, 'a pending build must be cancelled on unload')
  assert.equal(h.listening(), 0, 'unload must stop listening for new agents')
  q.fire(0)
  assert.deepEqual(w.seen, [], 'and a build that slipped through anyway must not touch the dead pool')
  ok('unload cancels the pending build and stops listening')

  h.fire({ agent: agentIn('/after') })
  assert.equal(q.entries.length, 1, 'an agent created after unload must not be warmed')
  dispose()
  ok('unload is idempotent and later agents are ignored')
}

// --- hosts that cannot pre-warm --------------------------------------------
{
  // A headless profile has no agent registry. Pre-warming is a convenience, so
  // the absence must be silent — an error here would deactivate the plugin.
  const w = warmer()
  const dispose = schedulePrewarm({}, w.warm)
  assert.equal(typeof dispose, 'function')
  dispose()
  ok('a host without agents or events pre-warms nothing and does not throw')
}

// --- agents without a usable workspace --------------------------------------
{
  const h = host([{}, agentIn(''), agentIn('   '), agentIn(42)])
  const q = queue()
  const w = warmer()
  schedulePrewarm(h, w.warm, { schedule: q.schedule })
  h.fire({ agent: undefined })
  h.fire({})
  assert.equal(q.entries.length, 0, 'an agent with no cwd has no workspace to index')
  ok('a missing, empty or non-string cwd is skipped instead of indexing a wrong root')
}

console.log(`\n${passed} pre-warm groups passed`)
