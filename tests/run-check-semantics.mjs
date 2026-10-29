/**
 * M1.4 — semantic readings wired through `action=run`.
 *
 * `run-tap.mjs` proves the interpreter. This suite proves the *wiring*: that a
 * plan's frozen `kind` decides how a real run is read, that the reading survives
 * all the way into the tool's status and its verification record, and that no
 * path upgrades a process result into a test verdict.
 *
 * Two kinds of evidence are used deliberately:
 *
 * - a scripted host, to control truncation, exit codes and stdout precisely —
 *   cases a real subprocess cannot be made to produce on demand;
 * - a real `node --test` run, because a fake that returns fixture text proves
 *   only that the parser is reachable, not that the plan/approval/spawn path
 *   produces output the parser can read.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sem-data-'))
process.env.DSH_FORGE_DATA_DIR = dataDir

const { createCheckTool } = await import('../lib/tools-check.js')
const { listRecords } = await import('../lib/verification.js')
const { storeFor } = await import('../lib/ledger.js')

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

function workspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sem-ws-'))
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

const exec = (cwd) => ({ agent: { session: { header: { cwd } } }, signal: new AbortController().signal })
const raw = (callId = 'call-sem-1') => ({ agent: { session: { header: { id: 's' } } }, callId, signal: new AbortController().signal })

/** A host whose subprocess prints `stdout` and exits `exitCode`. */
function scriptedHost({ exitCode = 0, stdout = '', truncated = false, spillPath } = {}) {
  let reads = 0
  return {
    services: {
      get(name) {
        if (name === 'approval') return { async request() { return 'allowed-once' } }
        if (name === 'subprocess') {
          return {
            spawn() {
              return {
                done: Promise.resolve({ exitCode, signal: null }),
                terminate() {},
                async waitForExit() {},
                collected: {
                  stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
                  stdout: {
                    readFrom() {
                      reads++
                      return spillPath === undefined
                        ? { text: stdout, nextOffset: stdout.length, lossy: truncated }
                        : { text: stdout, nextOffset: stdout.length, lossy: false, spillPath }
                    },
                  },
                },
              }
            },
          }
        }
        return undefined
      },
    },
  }
}

/** Run one recipe of the given kind and return the tool's result. */
async function runRecipe(ws, host, recipe, extra = {}) {
  const tool = createCheckTool(host.services)
  const planned = await tool.execute({ action: 'plan', recipes: [recipe], ...extra }, exec(ws), raw())
  assert.ok(planned.checkPlanId, `planning failed: ${planned.error ?? planned.text}`)
  return tool.execute({ action: 'run', checkPlanId: planned.checkPlanId }, exec(ws), raw())
}

const TAP_PASS = [
  'TAP version 13',
  '# Subtest: adds',
  'ok 1 - adds',
  '  ---',
  "  duration_ms: 0.5",
  '  ...',
  '# Subtest: subs',
  'ok 2 - subs',
  '  ---',
  "  duration_ms: 0.4",
  '  ...',
  '1..2',
  '# tests 2',
  '# pass 2',
  '# fail 0',
  '# skipped 0',
  '# todo 0',
].join('\n')

const TAP_ALL_SKIP = ['TAP version 13', 'ok 1 - a # SKIP x', 'ok 2 - b # SKIP y', '1..2', '# tests 2', '# pass 0', '# fail 0', '# skipped 2', '# todo 0'].join('\n')
const TAP_EMPTY_FILE = ['TAP version 13', '# Subtest: none.mjs', 'ok 1 - none.mjs', '  ---', '  ...', '1..1', '# tests 1', '# pass 1', '# fail 0'].join('\n')
const TAP_FAIL = ['TAP version 13', 'ok 1 - adds', 'not ok 2 - subs', '  ---', "  error: '3 == 2'", '  ...', '1..2', '# tests 2', '# pass 1', '# fail 1'].join('\n')

// --- a declared tests recipe can pass -------------------------------------
{
  const ws = workspace()
  const result = await runRecipe(ws, scriptedHost({ stdout: TAP_PASS }), {
    id: 'unit', kind: 'tests', program: process.execPath, argv: ['--test', '--test-reporter=tap', 'x.mjs'],
  })
  assert.equal(result.status, 'completed', `expected completed, got ${result.status}: ${result.text}`)
  assert.equal(result.reason, 'semantic_checks_passed')
  assert.equal(result.runs[0].kind, 'tests')
  assert.equal(result.runs[0].verdict, 'passed')
  assert.match(result.text, /\[tests\] unit: passed — 2 test\(s\) executed and all passed/)
  ok('a tests recipe whose TAP report is clean is allowed to report completed')
}

// --- the traps, through the full path -------------------------------------
{
  const ws = workspace()
  const result = await runRecipe(ws, scriptedHost({ stdout: TAP_ALL_SKIP }), {
    id: 'unit', kind: 'tests', program: process.execPath, argv: ['--test', '--test-reporter=tap', 'x.mjs'],
  })
  assert.equal(result.runs[0].verdict, 'unverifiable')
  assert.equal(result.status, 'partial', 'every point is ok but nothing ran, so this is not completed')
  assert.equal(result.reason, 'test_report_uninterpretable')
  ok('an all-skip suite is partial, not completed, even though exit is 0')
}
{
  const ws = workspace()
  const result = await runRecipe(ws, scriptedHost({ stdout: TAP_EMPTY_FILE, exitCode: 0 }), {
    id: 'unit', kind: 'tests', program: process.execPath, argv: ['--test', '--test-reporter=tap', 'none.mjs'],
    scope: ['none.mjs'],
  })
  assert.equal(result.runs[0].verdict, 'unverifiable')
  assert.equal(result.status, 'partial')
  ok('a file that registered no test is partial despite exit 0 and # pass 1')
}
{
  const ws = workspace()
  const result = await runRecipe(ws, scriptedHost({ stdout: TAP_FAIL, exitCode: 1 }), {
    id: 'unit', kind: 'tests', program: process.execPath, argv: ['--test', '--test-reporter=tap', 'x.mjs'],
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'tests_failed', 'the reason names the semantic failure, not just the exit code')
  assert.equal(result.runs[0].verdict, 'failed')
  assert.match(result.text, /subs/)
  ok('a failing TAP report reports tests_failed with the failing test named')
}
{
  // A `tests` recipe whose output is not TAP must not invent a verdict.
  const ws = workspace()
  const result = await runRecipe(ws, scriptedHost({ stdout: 'something else entirely\n' }), {
    id: 'unit', kind: 'tests', program: process.execPath, argv: ['--test', 'x.mjs'],
  })
  assert.equal(result.runs[0].verdict, 'unverifiable')
  assert.equal(result.status, 'partial')
  ok('a tests recipe that printed no TAP is partial rather than passed or failed')
}
{
  // Truncation invalidates the reading even with a clean-looking tail.
  const ws = workspace()
  const result = await runRecipe(ws, scriptedHost({ stdout: TAP_PASS, truncated: true }), {
    id: 'unit', kind: 'tests', program: process.execPath, argv: ['--test', '--test-reporter=tap', 'x.mjs'],
  })
  assert.equal(result.runs[0].verdict, 'unverifiable')
  assert.equal(result.status, 'partial')
  assert.match(result.text, /truncated/)
  ok('a truncated stream cannot support a test verdict')
}

// --- a process recipe is never upgraded -----------------------------------
{
  const ws = workspace()
  // Perfect TAP on stdout, but the recipe was approved as `process`.
  const result = await runRecipe(ws, scriptedHost({ stdout: TAP_PASS }), {
    id: 'build', program: process.execPath, argv: ['-e', 'process.exit(0)'],
  })
  assert.equal(result.runs[0].kind, 'process')
  assert.equal(result.runs[0].verdict, 'process_ok')
  assert.equal(result.status, 'completed')
  assert.equal(result.reason, 'process_only', 'nobody approved a semantic reading, so none is taken')
  assert.match(result.text, /PROCESS result/)
  assert.match(result.text, /\[process\] build: exit 0 — no semantic verdict was derived/)
  ok('a process recipe that prints TAP is still only a process result')
}

// --- types ---------------------------------------------------------------
{
  const ws = workspace()
  // Silence plus exit 0 is the only shape that proves clean types.
  const result = await runRecipe(ws, scriptedHost({ stdout: '', exitCode: 0 }), {
    id: 'tsc', kind: 'types', program: process.execPath, argv: ['node_modules/typescript/bin/tsc', '--noEmit'],
  })
  assert.equal(result.runs[0].verdict, 'passed', `got ${result.runs[0].verdict}: ${result.text}`)
  assert.equal(result.status, 'completed')
  ok('a types recipe with a zero exit and no diagnostics passes')
}
{
  const ws = workspace()
  const result = await runRecipe(ws, scriptedHost({ stdout: '', exitCode: 2 }), {
    id: 'tsc', kind: 'types', program: process.execPath, argv: ['tsc', '--noEmit'],
  })
  assert.equal(result.runs[0].verdict, 'unverifiable', 'silence with a non-zero exit is a broken invocation')
  // The process really did fail, so the run is `failed`; what matters is that
  // the reason is the exit code and not a claim about the types.
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'nonzero_exit')
  assert.match(result.text, /exited 2/)
  assert.ok(!/type errors/i.test(result.text), 'a non-zero exit with no diagnostics must not be reported as type errors')
  ok('silence plus a non-zero exit is a failed invocation, never clean types')
}
{
  const ws = workspace()
  const diagnostics = [
    "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    '',
    'Found 1 error in 1 file.',
  ].join('\n')
  // Exit 0: a wrapper swallowed the status. The diagnostic itself must fail it.
  const result = await runRecipe(ws, scriptedHost({ stdout: diagnostics, exitCode: 0 }), {
    id: 'tsc', kind: 'types', program: process.execPath, argv: ['tsc', '--noEmit'],
  })
  assert.equal(result.runs[0].verdict, 'failed')
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'type_errors')
  assert.match(result.text, /TS2322/)
  ok('a parsed type error fails the run even when the process exited 0')
}

// --- the record reflects the semantic reading ------------------------------
{
  const ws = workspace()
  const result = await runRecipe(ws, scriptedHost({ stdout: TAP_PASS }), {
    id: 'unit', kind: 'tests', program: process.execPath, argv: ['--test', '--test-reporter=tap', 'x.mjs'],
  })
  assert.equal(result.verification.persisted, true)
  const records = listRecords(storeFor(ws)).records
  assert.equal(records.length, 1)
  const kinds = records[0].checks.map(check => `${check.id}:${check.kind}:${check.status}`)
  assert.deepEqual(kinds, ['unit:tests:passed'], 'the record keeps the semantic kind, not a generic process result')
  ok('the verification record stores the semantic kind and status, not a bare process result')
}
{
  const ws = workspace()
  const result = await runRecipe(ws, scriptedHost({ stdout: TAP_ALL_SKIP }), {
    id: 'unit', kind: 'tests', program: process.execPath, argv: ['--test', '--test-reporter=tap', 'x.mjs'],
  })
  const records = listRecords(storeFor(ws)).records
  assert.equal(records[0].checks[0].status, 'not_run', 'an uninterpretable report is recorded as not_run')
  assert.equal(result.verification.persisted, true)
  ok('an unverifiable reading is archived as not_run rather than silently dropped')
}

// --- kind validation ------------------------------------------------------
{
  const ws = workspace()
  const tool = createCheckTool(scriptedHost().services)
  const bad = await tool.execute({ action: 'plan', recipes: [{ id: 'x', kind: 'magic', program: 'node' }] }, exec(ws), raw())
  assert.match(bad.error, /kind must be "process", "tests" or "types"/)
  ok('an unknown kind is refused at plan time, before anyone is asked to approve it')
}
{
  const ws = workspace()
  const tool = createCheckTool(scriptedHost().services)
  const warns = await tool.execute({
    action: 'plan',
    recipes: [{ id: 'unit', kind: 'tests', program: 'node', argv: ['--test', 'x.mjs'] }],
  }, exec(ws), raw())
  assert.ok(warns.checkPlanId, 'the warning must not block the plan')
  assert.match(warns.text, /names no TAP reporter/)
  ok('a tests recipe that names no TAP reporter warns before approval')
}

// --- a real subprocess ----------------------------------------------------
{
  const ws = workspace({
    'ok.test.mjs': [
      "import test from 'node:test'",
      "import assert from 'node:assert'",
      "test('real-adds', () => { assert.equal(1 + 1, 2) })",
    ].join('\n'),
  })
  // Real spawn: the workspace's own node running a real test file with the real
  // TAP reporter, so the parser sees output no fake produced.
  const realHost = {
    services: {
      get(name) {
        if (name === 'approval') return { async request() { return 'allowed-once' } }
        if (name === 'subprocess') {
          return {
            spawn(spec) {
              const argv = spec.argv
              const done = spawnSync(argv[0], argv.slice(1), { cwd: spec.cwd, encoding: 'utf8', timeout: 60_000 })
              const stdout = done.stdout ?? ''
              const stderr = done.stderr ?? ''
              return {
                done: Promise.resolve({ exitCode: done.status, signal: null }),
                terminate() {},
                async waitForExit() {},
                collected: { stdout: { readFrom: () => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }) } },
              }
            },
          }
        }
        return undefined
      },
    },
  }
  const result = await runRecipe(ws, realHost, {
    id: 'unit', kind: 'tests', program: process.execPath,
    argv: ['--test', '--test-reporter=tap', 'ok.test.mjs'],
    scope: ['ok.test.mjs'],
  })
  assert.equal(result.status, 'completed', `real run failed: ${result.text}`)
  assert.equal(result.runs[0].verdict, 'passed')
  assert.match(result.text, /real-adds|1 test\(s\) executed/)
  ok('a real node --test run through plan, approval and spawn yields a passed test fact')
}

console.log(`${passed} check-semantics groups passed`)
