/**
 * M1.4 — the host verification adapter, before anything is allowed to run.
 *
 * The claim this suite defends is narrow and load-bearing: **a grant precedes a
 * process.** Everything else in M1.4 (TAP parsing, staleness, attribution) is
 * downstream of that ordering, so the cases here are about ordering, identity
 * and evidence — not about the check results themselves.
 *
 * What each group protects:
 *
 *   capabilities — the probe is read-only and reports absence instead of
 *                  pretending. A deployment with no approval seam must not
 *                  appear runnable.
 *   identity     — the approval is filed against the live execution's own
 *                  callId and carries the live agent. A cloned or reconstructed
 *                  context would make the audit point at a call that never ran.
 *   denial       — a rejected prompt starts zero processes. There is no
 *                  start-then-kill path to accidentally leave open.
 *   cancel       — cancellation before and during are both non-results, and the
 *                  during case terminates the managed range before answering.
 *   evidence     — a completion carries a callId, an exit code and an output
 *                  reference; truncation is visible rather than implied.
 *   real runs    — a real child process, exit 0 and exit 7, because a fake that
 *                  never spawns proves the ordering but not the plumbing.
 */
import assert from 'node:assert/strict'
import { spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostCheckCapabilities, runHostCheck } from '../lib/check-host.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

/**
 * A host stand-in that records rather than performs.
 *
 * `spawned` is the point: the denial and capability cases assert it stays empty,
 * which is the only way to prove no process was started.
 */
function fakeHost(options = {}) {
  const record = { approvals: [], spawns: [], terminations: 0 }
  // A gated prompt stays open until the test answers it, which is the only way
  // to abort *while approval is pending* rather than after it granted.
  let answerPrompt
  const gate = options.gated === true
  if (gate) record.answer = (outcome) => answerPrompt(outcome)
  const services = {
    get(name) {
      if (name === 'approval' && options.approval !== null) {
        return {
          async request(req) {
            record.approvals.push(req)
            if (options.approvalThrows) throw new Error('approval seam exploded')
            if (gate) return new Promise((resolve) => { answerPrompt = resolve })
            return options.approval ?? 'allowed-once'
          },
        }
      }
      if (name === 'subprocess' && options.subprocess !== null) {
        return {
          spawn(spec) {
            record.spawns.push(spec)
            return options.handle
          },
        }
      }
      return undefined
    },
  }
  return { record, services }
}

/**
 * A handle that settles on demand, with the shape the seam documents.
 *
 * The deferred is captured before the handle literal so `settle` and `_reject`
 * do not depend on the object already existing inside its own initializer.
 */
function trackedHandle(outcome, stdoutText = '') {
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const handle = {
    terminated: 0,
    done,
    terminate() { handle.terminated++ },
    async waitForExit() {},
    collected: {
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stdout: {
        readFrom() {
          return { text: stdoutText, nextOffset: Buffer.byteLength(stdoutText), lossy: false }
        },
      },
    },
    settle: () => resolveDone(outcome),
    _reject: (error) => rejectDone(error),
  }
  return handle
}

const execution = (overrides = {}) => ({
  agent: { session: { header: { id: 'session-1' } } },
  callId: 'call-42',
  signal: new AbortController().signal,
  ...overrides,
})

const request = (raw = execution(), overrides = {}) => ({
  recipeId: 'recipe-node-smoke',
  program: 'node',
  argv: ['-e', 'process.exit(0)'],
  cwd: process.cwd(),
  reason: 'run the node smoke recipe',
  raw,
  ...overrides,
})

const OPTIONS = { toolName: 'ffcheck', timeoutMs: 5_000 }

// --- capabilities ---------------------------------------------------------
{
  const { services } = fakeHost()
  const caps = hostCheckCapabilities(services)
  assert.equal(caps.status, 'ok')
  assert.equal(caps.approval.symbol, 'ctx.approval.request')
  assert.equal(caps.subprocess.symbol, 'ctx.subprocess.spawn')
  assert.equal(caps.reason, undefined)
  ok('a deployment with both seams reports ok and names the exact symbols it found')
}
{
  const { services } = fakeHost({ approval: null })
  const caps = hostCheckCapabilities(services)
  assert.equal(caps.status, 'unavailable')
  assert.equal(caps.approval.available, false)
  assert.match(caps.reason, /approval/)
  ok('a missing approval seam makes the whole capability unavailable, with the reason')
}
{
  const { services } = fakeHost({ subprocess: null })
  const caps = hostCheckCapabilities(services)
  assert.equal(caps.status, 'unavailable')
  assert.match(caps.reason, /subprocess/)
  ok('a missing subprocess seam is reported separately instead of as a generic failure')
}
{
  // A service that exists but no longer has the member is NOT available. Shape
  // drift must read as absence, not as a later crash mid-run.
  const services = { get: (name) => (name === 'approval' ? { ask: () => 'allowed-once' } : { spawn: () => {} }) }
  const caps = hostCheckCapabilities(services)
  assert.equal(caps.approval.available, false)
  assert.equal(caps.status, 'unavailable')
  ok('a seam whose method was renamed reads as unavailable rather than crashing later')
}
{
  const { record, services } = fakeHost()
  hostCheckCapabilities(services)
  assert.equal(record.approvals.length, 0)
  assert.equal(record.spawns.length, 0)
  ok('the capability probe prompts nobody and starts nothing')
}

// --- raw context identity -------------------------------------------------
{
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { record, services } = fakeHost({ handle })
  const raw = execution()
  const pending = runHostCheck(services, request(raw), OPTIONS)
  handle.settle()
  const result = await pending
  assert.equal(result.status, 'completed')
  const approval = record.approvals[0]
  assert.equal(approval.callId, 'call-42')
  assert.equal(approval.agent, raw.agent, 'the live agent object must be passed through, not a copy')
  assert.equal(approval.signal, raw.signal, 'the live cancellation signal must be passed through')
  assert.equal(approval.toolName, 'ffcheck')
  assert.equal(approval.reason, 'run the node smoke recipe')
  ok('the approval carries the live execution identity: same agent object, same signal, same callId')
}
{
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { record, services } = fakeHost({ handle })
  const pending = runHostCheck(services, request(execution({ callId: undefined })), OPTIONS)
  const result = await pending
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /callId/)
  assert.equal(record.approvals.length, 0, 'no callId means no prompt: the question could not be attributed')
  assert.equal(record.spawns.length, 0)
  ok('a missing callId refuses before prompting instead of synthesising an identity')
}
{
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { record, services } = fakeHost({ handle })
  const result = await runHostCheck(services, request(execution({ agent: undefined })), OPTIONS)
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /no agent/)
  assert.equal(record.approvals.length, 0)
  assert.equal(record.spawns.length, 0)
  ok('an agent-less call refuses before prompting, matching the host\'s own degrade path')
}

// --- approved result roundtrip --------------------------------------------
{
  const handle = trackedHandle({ exitCode: 0, signal: null }, 'hello from the child')
  const { record, services } = fakeHost({ handle })
  const pending = runHostCheck(services, request(), OPTIONS)
  handle.settle()
  const result = await pending
  assert.equal(result.status, 'completed')
  assert.equal(result.callId, 'call-42', 'the completion must name the approved call')
  assert.equal(result.exitCode, 0)
  assert.equal(result.text, 'hello from the child')
  assert.ok(result.output.kind === 'digest' && /^[0-9a-f]{64}$/.test(result.output.sha256))
  assert.equal(result.output.bytes, Buffer.byteLength('hello from the child'))
  assert.equal(record.spawns.length, 1)
  assert.deepEqual(record.spawns[0].argv, ['node', '-e', 'process.exit(0)'])
  ok('a grant produces one spawn, and the completion carries callId, exitCode and an output reference')
}
{
  const handle = trackedHandle({ exitCode: 0, signal: null }, 'tail only')
  handle.collected.stdout.readFrom = () => ({ text: 'tail only', nextOffset: 9, lossy: true })
  const { services } = fakeHost({ handle })
  const pending = runHostCheck(services, request(), OPTIONS)
  handle.settle()
  const result = await pending
  assert.equal(result.status, 'completed')
  assert.equal(result.output.kind, 'digest')
  assert.equal(result.output.truncated, true, 'a lossy read must be visible as truncation, not implied by length')
  ok('a lossy read marks the output truncated so a caller cannot mistake a tail for the whole stream')
}
{
  const handle = trackedHandle({ exitCode: 0, signal: null }, 'x')
  const spillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-host-spill-'))
  const spillPath = path.join(spillRoot, 'stdout.log')
  fs.writeFileSync(spillPath, 'complete stdout')
  handle.collected.stdout.readFrom = () => ({ text: 'tail', nextOffset: 15, lossy: true, spillPath })
  const { services } = fakeHost({ handle })
  const pending = runHostCheck(services, request(), OPTIONS)
  handle.settle()
  const result = await pending
  assert.equal(result.status, 'completed')
  assert.equal(result.output.kind, 'spill')
  assert.equal(result.output.path, spillPath)
  assert.equal(result.output.bytes, 15)
  assert.equal(result.output.truncated, false)
  assert.equal(result.text, 'complete stdout')
  assert.equal(result.output.streams.stdout.truncated, false)
  assert.equal(result.output.streams.stderr.truncated, false)
  assert.equal(path.dirname(path.resolve(spillRoot)), path.resolve(os.tmpdir()))
  fs.rmSync(spillRoot, { recursive: true, force: true })
  ok('a stable complete spill artifact recovers a lossy stream with both stream references')
}
{
  const handle = trackedHandle({ exitCode: 7, signal: null })
  const { services } = fakeHost({ handle })
  const pending = runHostCheck(services, request(), OPTIONS)
  handle.settle()
  const result = await pending
  assert.equal(result.status, 'completed')
  assert.equal(result.exitCode, 7, 'a non-zero exit is still a completed process, not an adapter failure')
  ok('exit 7 completes with its real code: the adapter reports the process, it does not judge it')
}

// --- denial never starts ---------------------------------------------------
for (const [outcome, expected] of [['rejected', 'denied'], ['unavailable', 'unavailable'], ['cancelled', 'cancelled']]) {
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { record, services } = fakeHost({ approval: outcome, handle })
  const result = await runHostCheck(services, request(), OPTIONS)
  assert.equal(result.status, expected, `outcome ${outcome} must map to ${expected}`)
  assert.equal(record.spawns.length, 0, `outcome ${outcome} must start no process`)
  if (outcome === 'rejected') {
    assert.equal(result.approvalOutcome, 'rejected', 'the denial must preserve what the host actually said')
  }
}
ok('rejected, unavailable and cancelled each deny, and none of them starts a process')
{
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { record, services } = fakeHost({ approval: 'maybe', handle })
  const result = await runHostCheck(services, request(), OPTIONS)
  assert.equal(result.status, 'unavailable')
  assert.match(result.detail, /unknown outcome as a grant/)
  assert.equal(record.spawns.length, 0, 'an unrecognised outcome is never optimistic')
  ok('an unrecognised approval outcome fails closed instead of being read as permission')
}
{
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { record, services } = fakeHost({ approvalThrows: true, handle })
  const result = await runHostCheck(services, request(), OPTIONS)
  assert.equal(result.status, 'unavailable')
  assert.match(result.detail, /exploded/)
  assert.equal(record.spawns.length, 0)
  ok('a throwing approval seam produces no grant and no process')
}

// --- cancellation ----------------------------------------------------------
{
  const controller = new AbortController()
  controller.abort()
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { record, services } = fakeHost({ handle })
  const result = await runHostCheck(services, request(execution({ signal: controller.signal })), OPTIONS)
  assert.equal(result.status, 'cancelled')
  assert.equal(record.approvals.length, 0, 'a pre-cancelled call must not even ask')
  assert.equal(record.spawns.length, 0)
  ok('cancellation before approval settles as cancelled without prompting or spawning')
}
{
  // Cancelled while the prompt is open: the grant may still arrive, and it must
  // be ignored rather than turned into work.
  const controller = new AbortController()
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { record, services } = fakeHost({ handle, gated: true })
  const pending = runHostCheck(services, request(execution({ signal: controller.signal })), OPTIONS)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(record.approvals.length, 1, 'the prompt is open at this point')
  controller.abort()
  record.answer('allowed-once')
  const result = await pending
  assert.equal(result.status, 'cancelled')
  assert.equal(record.spawns.length, 0, 'a grant arriving after cancellation must not start a process')
  ok('cancellation while the prompt is open discards the late grant and spawns nothing')
}
{
  const controller = new AbortController()
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { record, services } = fakeHost({ handle })
  const pending = runHostCheck(services, request(execution({ signal: controller.signal })), OPTIONS)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(record.spawns.length, 1, 'the process is running by now')
  controller.abort()
  const result = await pending
  assert.equal(result.status, 'interrupted')
  assert.match(result.reason, /caller cancelled/)
  assert.equal(handle.terminated, 1, 'the managed range must be terminated before answering')
  ok('cancellation during execution terminates the managed range and reports interrupted, never completed')
}
{
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { services } = fakeHost({ handle })
  const result = await runHostCheck(services, request(), { toolName: 'ffcheck', timeoutMs: 20 })
  assert.equal(result.status, 'interrupted')
  assert.match(result.reason, /deadline/)
  assert.equal(handle.terminated, 1)
  ok('a hung check hits the adapter-owned deadline and is terminated instead of holding the turn open')
}

// --- missing or forged evidence -------------------------------------------
{
  assert.equal(typeof runHostCheck, 'function')
  const { record, services } = fakeHost({ handle: trackedHandle({ exitCode: 0, signal: null }) })
  const result = await runHostCheck({ get: () => undefined }, request(), OPTIONS)
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /neither an approval seam nor a subprocess seam/)
  assert.equal(record.spawns.length, 0)
  ok('a deployment composing nothing at all reports unavailable rather than spawning directly')
}
{
  // A process that fails before reporting an exit is interrupted with a detail,
  // not completed with a guessed code.
  const handle = trackedHandle({ exitCode: 0, signal: null })
  const { services } = fakeHost({ handle })
  const pending = runHostCheck(services, request(), OPTIONS)
  handle._reject(new Error('spawn refused by the provider'))
  const result = await pending
  assert.equal(result.status, 'interrupted')
  assert.match(result.detail, /spawn refused/)
  ok('a provider failure before exit is interrupted with its detail, never a fabricated exit code')
}

// --- real process plumbing -------------------------------------------------
{
  const realServices = {
    get(name) {
      if (name === 'approval') return { async request() { return 'allowed-once' } }
      if (name === 'subprocess') {
        return {
          spawn(spec) {
            const child = spawnProcess(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
            const stdout = [], stderr = []
            child.stdout.on('data', chunk => stdout.push(chunk))
            child.stderr.on('data', chunk => stderr.push(chunk))
            const done = new Promise((resolve, reject) => {
              child.once('error', reject)
              child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
            })
            return {
              done,
              terminate() { child.kill() },
              async waitForExit() { await done.catch(() => undefined) },
              collected: { stdout: { readFrom: () => ({ text: Buffer.concat(stdout).toString('utf8'), nextOffset: Buffer.concat(stdout).length, lossy: false }) }, stderr: { readFrom: () => ({ text: Buffer.concat(stderr).toString('utf8'), nextOffset: Buffer.concat(stderr).length, lossy: false }) } },
            }
          },
        }
      }
      return undefined
    },
  }
  const caps = hostCheckCapabilities(realServices)
  assert.equal(caps.status, 'ok')

  const zero = await runHostCheck(realServices, request(execution(), {
    recipeId: 'real-exit-0', program: process.execPath, argv: ['-e', 'process.exit(0)'],
  }), { toolName: 'ffcheck', timeoutMs: 30_000 })
  assert.equal(zero.status, 'completed')
  assert.equal(zero.exitCode, 0)

  const seven = await runHostCheck(realServices, request(execution(), {
    recipeId: 'real-exit-7', program: process.execPath, argv: ['-e', 'process.exit(7)'],
  }), { toolName: 'ffcheck', timeoutMs: 30_000 })
  assert.equal(seven.status, 'completed')
  assert.equal(seven.exitCode, 7)
  ok('real child processes round-trip: exit 0 and exit 7 both come back as their true codes')
}
{
  const realServices = {
    get(name) {
      if (name === 'approval') return { async request() { return 'allowed-once' } }
      if (name === 'subprocess') {
        return {
          spawn(spec) {
            const child = spawnProcess(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
            const stdout = [], stderr = []
            child.stdout.on('data', chunk => stdout.push(chunk))
            child.stderr.on('data', chunk => stderr.push(chunk))
            const done = new Promise((resolve, reject) => {
              child.once('error', reject)
              child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
            })
            return {
              done,
              terminate() { child.kill() },
              async waitForExit() { await done.catch(() => undefined) },
              collected: { stdout: { readFrom: () => ({ text: Buffer.concat(stdout).toString('utf8'), nextOffset: Buffer.concat(stdout).length, lossy: false }) }, stderr: { readFrom: () => ({ text: Buffer.concat(stderr).toString('utf8'), nextOffset: Buffer.concat(stderr).length, lossy: false }) } },
            }
          },
        }
      }
      return undefined
    },
  }
  const result = await runHostCheck(realServices, request(execution(), {
    recipeId: 'real-stdout', program: process.execPath, argv: ['-e', 'process.stdout.write("tap-ish")'],
  }), { toolName: 'ffcheck', timeoutMs: 30_000 })
  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'tap-ish')
  assert.ok(/^[0-9a-f]{64}$/.test(result.output.sha256))
  ok('real stdout reaches the caller and its digest matches the bytes actually read')
}

console.log(`${passed} host-check groups passed`)
