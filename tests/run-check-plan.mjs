/**
 * ffcheck action=plan / action=run — the approval-bound execution path.
 *
 * The claim this suite defends: **run accepts an approval subject, not a
 * command.** A caller that could pass `program`/`argv` straight to `run` would
 * make the approval prompt a formality, because the human answers one question
 * and a different command executes. So the cases here are about what is frozen,
 * what is refused, and what a zero exit is allowed to mean.
 *
 *   plan    — inert. It hashes, saves, and returns an id; it prompts nobody.
 *   identity— the id is the content hash, so an edited plan cannot keep it.
 *   drift   — inputs hashed before dispatch and after the terminal result.
 *   verdict — exit 0 is a PROCESS result. `passed` is never returned by run.
 *   denial  — a rejected prompt leaves no process, and run says so.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plan-data-'))
process.env.DSH_FORGE_DATA_DIR = dataDir

const { createCheckTool } = await import('../lib/tools-check.js')
const { planId, loadPlan } = await import('../lib/check-plan.js')
const { storeFor } = await import('../lib/ledger.js')

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

function workspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plan-ws-'))
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

const exec = (cwd, extra = {}) => ({
  agent: { session: { header: { cwd } } },
  signal: new AbortController().signal,
  ...extra,
})

/** A raw host execution object, kept live — never serialised. */
const raw = (callId = 'call-plan-1') => ({ agent: { session: { header: { id: 's' } } }, callId, signal: new AbortController().signal })

function hostWith({ approval = 'allowed-once', exitCode = 0, stdout = '' } = {}) {
  const record = { approvals: [], spawns: [] }
  return {
    record,
    services: {
      get(name) {
        if (name === 'approval') return { async request(req) { record.approvals.push(req); return approval } }
        if (name === 'subprocess') {
          return {
            spawn(spec) {
              record.spawns.push(spec)
              return {
                done: Promise.resolve({ exitCode, signal: null }),
                terminate() {},
                async waitForExit() {},
                collected: { stdout: { readFrom: () => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
              }
            },
          }
        }
        return undefined
      },
    },
  }
}

const tool = (host) => createCheckTool(host?.services)

// --- plan is inert ---------------------------------------------------------
{
  const ws = workspace({ 'src/a.js': 'export const a = 1\n' })
  const host = hostWith()
  const result = await tool(host).execute({
    action: 'plan',
    recipes: [{ id: 'unit', program: process.execPath, argv: ['-e', 'process.exit(0)'] }],
    inputs: ['src/a.js'],
  }, exec(ws), raw())
  assert.equal(result.status, 'not_run')
  assert.equal(result.reason, 'planned')
  assert.match(result.checkPlanId, /^[0-9a-f]{32}$/)
  assert.equal(host.record.approvals.length, 0, 'planning must not prompt')
  assert.equal(host.record.spawns.length, 0, 'planning must not spawn')
  assert.ok(result.planned.some(entry => entry.startsWith('run:unit')), 'the plan must list the command a human will be asked to approve')
  ok('plan hashes, saves and returns an id while prompting nobody and starting nothing')
}
{
  const ws = workspace()
  const result = await tool(hostWith()).execute({ action: 'plan', recipes: [] }, exec(ws), raw())
  assert.ok(result.error, 'a plan with no recipe is refused')
  assert.match(result.error, /at least one command/)
  ok('a plan with nothing to approve is refused rather than saved')
}
{
  const ws = workspace()
  const result = await tool(hostWith()).execute({
    action: 'plan',
    recipes: [{ id: 'x', program: 'node', argv: ['-e', 'process.exit(0)'] }, { id: 'x', program: 'node', argv: [] }],
  }, exec(ws), raw())
  assert.match(result.error, /duplicate recipe id/)
  ok('duplicate recipe ids are refused: the id is what the approval names')
}
{
  const ws = workspace()
  const result = await tool(hostWith()).execute({
    action: 'plan', recipes: [{ id: 'x', program: 'bash', argv: ['-c', 'echo hi'] }],
  }, exec(ws), raw())
  // A shell string is allowed only as an explicit argv; what is refused is a
  // non-string, because a non-array argv would be shell-interpreted downstream.
  assert.equal(result.status, 'not_run')
  const bad = await tool(hostWith()).execute({ action: 'plan', recipes: [{ id: 'y', program: 'bash', argv: 'ls' }] }, exec(ws), raw())
  assert.match(bad.error, /argv must be an array/)
  ok('argv must be an array of strings, never a shell string')
}

// --- identity is the content ----------------------------------------------
{
  const ws = workspace()
  const recipes = [{ id: 'unit', program: 'node', argv: ['-e', '1'] }]
  const a = planId(recipes, ['bridge', 'syntax'])
  const b = planId([{ ...recipes[0], argv: ['-e', '2'] }], ['bridge', 'syntax'])
  const c = planId([{ ...recipes[0], argv: ['-e', '1'], cwd: '/elsewhere' }], ['bridge', 'syntax'])
  assert.notEqual(a, b, 'a changed argument must change the id')
  assert.notEqual(a, c, 'a changed cwd must change the id')
  assert.equal(a, planId(recipes, ['syntax', 'bridge']), 'static check order must not change the id')
  ok('the plan id follows recipe content and is stable under check-set ordering')
}
{
  const ws = workspace({ 'src/a.js': 'x\n' })
  const planResult = await tool(hostWith()).execute({
    action: 'plan', recipes: [{ id: 'unit', program: 'node', argv: [] }], inputs: ['src/a.js'],
  }, exec(ws), raw())
  // Edit the saved plan on disk as if a different command had been approved.
  const stored = loadPlan(ws, planResult.checkPlanId)
  assert.equal(stored.ok, true)
  const planFile = path.join(storeFor(ws).dir, 'checks', `${planResult.checkPlanId}.json`)
  assert.ok(fs.existsSync(planFile), `expected the saved plan at ${planFile}`)
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  plan.recipes[0].argv = ['-e', 'malicious()']
  fs.writeFileSync(planFile, JSON.stringify(plan))
  const result = await tool(hostWith()).execute({ action: 'run', checkPlanId: planResult.checkPlanId }, exec(ws), raw())
  assert.equal(result.status, 'not_run')
  assert.match(result.detail, /no longer matches its own content/)
  ok('a plan edited on disk after planning is refused instead of running under the old approval')
}

// --- run requires the plan, and the plan requires approval ----------------
{
  const ws = workspace()
  const result = await tool(hostWith()).execute({ action: 'run' }, exec(ws), raw())
  assert.match(result.error, /checkPlanId/)
  ok('run without a checkPlanId is refused: programs and arguments are never accepted directly')
}
{
  const ws = workspace()
  const result = await tool(hostWith()).execute({ action: 'run', checkPlanId: '0'.repeat(32) }, exec(ws), raw())
  assert.equal(result.status, 'not_run')
  assert.equal(result.reason, 'unknown_plan')
  ok('an unknown plan id reports not_run instead of guessing a command')
}
{
  const ws = workspace()
  const host = hostWith()
  const planned = await tool(host).execute({
    action: 'plan', recipes: [{ id: 'unit', program: process.execPath, argv: ['-e', 'process.exit(0)'] }],
  }, exec(ws), raw())
  const result = await tool(host).execute({ action: 'run', checkPlanId: planned.checkPlanId }, exec(ws), raw())
  assert.equal(result.status, 'completed')
  assert.equal(result.reason, 'process_only')
  assert.equal(host.record.approvals.length, 1)
  assert.equal(host.record.spawns.length, 1)
  assert.match(result.detail, /process results only/)
  ok('a granted plan runs once, and its completion is labelled process-only rather than passed')
}
{
  const ws = workspace()
  const host = hostWith()
  const planned = await tool(host).execute({
    action: 'plan', recipes: [{ id: 'unit', program: process.execPath, argv: [] }],
  }, exec(ws), raw())
  const result = await tool(host).execute({ action: 'run', checkPlanId: planned.checkPlanId }, exec(ws), raw())
  assert.equal(result.status, 'completed')
  assert.notEqual(result.status, 'passed', 'run must never claim passed: it interprets no semantics')
  ok('run cannot return passed even when every process exits 0')
}

// --- denial ----------------------------------------------------------------
{
  const ws = workspace()
  const host = hostWith({ approval: 'rejected' })
  const planned = await tool(host).execute({
    action: 'plan', recipes: [{ id: 'unit', program: process.execPath, argv: [] }],
  }, exec(ws), raw())
  const result = await tool(host).execute({ action: 'run', checkPlanId: planned.checkPlanId }, exec(ws), raw())
  assert.equal(result.status, 'denied')
  assert.equal(result.reason, 'approval_denied')
  assert.equal(host.record.spawns.length, 0, 'a denied prompt must leave no process')
  ok('a rejected approval reports denied and starts nothing')
}

// --- drift -----------------------------------------------------------------
{
  const ws = workspace({ 'src/a.js': 'before\n' })
  const host = hostWith()
  const planned = await tool(host).execute({
    action: 'plan', recipes: [{ id: 'unit', program: process.execPath, argv: [] }], inputs: ['src/a.js'],
  }, exec(ws), raw())
  fs.writeFileSync(path.join(ws, 'src/a.js'), 'after\n')
  const result = await tool(host).execute({ action: 'run', checkPlanId: planned.checkPlanId }, exec(ws), raw())
  assert.equal(result.status, 'stale')
  assert.equal(result.reason, 'input_drift')
  assert.equal(host.record.approvals.length, 0, 'drifted inputs must not even spend a prompt')
  assert.equal(host.record.spawns.length, 0)
  ok('an input changed after planning makes run stale before it asks for approval')
}
{
  const ws = workspace({ 'src/a.js': 'v1\n' })
  const host = hostWith()
  const planned = await tool(host).execute({
    action: 'plan', recipes: [{ id: 'unit', program: process.execPath, argv: [] }], inputs: ['src/a.js'],
  }, exec(ws), raw())
  // The input changes while the "process" is running: the adapter's spawn hook
  // rewrites it, then exits 0. The process succeeded; the answer is not valid.
  const inner = host.services.get
  const host2 = {
    record: host.record,
    services: {
      get(name) {
        const service = inner(name)
        if (name !== 'subprocess') return service
        return {
          spawn(spec) {
            fs.writeFileSync(path.join(ws, 'src/a.js'), 'v2\n')
            return service.spawn(spec)
          },
        }
      },
    },
  }
  const result = await tool(host2).execute({ action: 'run', checkPlanId: planned.checkPlanId }, exec(ws), raw())
  assert.equal(result.status, 'stale')
  assert.equal(result.reason, 'input_drift_during_run')
  assert.match(result.text, /does not describe the current tree/)
  ok('an input changed during the run makes a zero exit inapplicable instead of successful')
}

// --- unavailability --------------------------------------------------------
{
  const ws = workspace()
  const planned = await tool(hostWith()).execute({
    action: 'plan', recipes: [{ id: 'unit', program: process.execPath, argv: [] }],
  }, exec(ws), raw())
  const bare = { services: { get: () => undefined } }
  const result = await tool(bare).execute({ action: 'run', checkPlanId: planned.checkPlanId }, exec(ws), raw())
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'no_execution_seam')
  ok('a deployment with no seams reports unavailable rather than spawning directly')
}
{
  const ws = workspace()
  const planned = await tool(hostWith()).execute({
    action: 'plan', recipes: [{ id: 'unit', program: process.execPath, argv: [] }],
  }, exec(ws), raw())
  const result = await tool(undefined).execute({ action: 'run', checkPlanId: planned.checkPlanId }, exec(ws), raw())
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'no_host_services')
  ok('a plugin mounted without host access says so instead of pretending to run')
}
{
  const ws = workspace()
  const host = hostWith()
  const planned = await tool(host).execute({
    action: 'plan', recipes: [{ id: 'unit', program: process.execPath, argv: [] }],
  }, exec(ws), raw())
  // No callId on the live execution: the approval could not be attributed.
  // That is "cannot even ask", not "a human said no" — the two call for
  // different next steps, so they must not collapse into one status.
  const result = await tool(host).execute({ action: 'run', checkPlanId: planned.checkPlanId }, exec(ws), raw(''))
  assert.equal(result.status, 'unavailable')
  assert.equal(host.record.approvals.length, 0, 'no prompt: the question could not be attributed to a call')
  assert.equal(host.record.spawns.length, 0)
  assert.match(result.text, /no registry callId/)
  ok('a run without an attributable callId asks nothing, starts nothing, and does not claim a denial')
}

console.log(`${passed} check-plan groups passed`)
