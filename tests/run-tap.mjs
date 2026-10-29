/**
 * M1.4 — TAP interpretation.
 *
 * Every fixture under `tests/fixtures/tap/` is real output from
 * `node --test --test-reporter=tap`, captured rather than written by hand. That
 * matters: the traps this suite defends against (a skipped test reporting `ok`,
 * a file with no tests reporting `ok` and `# pass 1`) are only visible in genuine
 * reporter output, and a hand-written fixture would encode what I *think* the
 * reporter prints.
 *
 * The claim under test: **`passed` is reachable only when tests actually ran and
 * all of them passed**, and every other reading says why it cannot claim that.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { parseTap, interpretTestReport, crossCheckReport } = await import('../lib/tap.js')

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const fixture = (name) => readFileSync(path.join(here, 'fixtures', 'tap', `${name}.tap`), 'utf8')
const evidence = (overrides = {}) => ({ callId: 'call-1', expectedCallId: 'call-1', truncated: false, ...overrides })

// --- parsing real output --------------------------------------------------
{
  const report = parseTap(fixture('pass'))
  assert.equal(report.recognised, true)
  assert.equal(report.version, 13)
  assert.equal(report.plan, 2)
  assert.equal(report.points.length, 2)
  assert.deepEqual(report.points.map(p => p.name), ['adds', 'subtracts'])
  assert.deepEqual(report.summary, { tests: 2, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 })
  ok('a real passing report parses into points, plan and summary')
}
{
  const report = parseTap(fixture('fail'))
  assert.equal(report.points.length, 2)
  assert.equal(report.points[1].ok, false)
  assert.equal(report.points[1].error, '2 == 3', 'the assertion message is captured from the diagnostics block')
  ok('a failing point is marked not-ok and keeps its assertion message')
}

// --- the five traps -------------------------------------------------------
{
  // Node reports a skipped test as `ok`. Counting ok lines would call this green.
  const report = parseTap(fixture('skip'))
  assert.equal(report.points[0].ok, true, 'the raw TAP point is ok — this is the trap')
  assert.equal(report.points[0].skip, 'not ready')
  const verdict = interpretTestReport(report, evidence())
  assert.equal(verdict.status, 'passed', 'the one real test did pass')
  assert.equal(verdict.executed, 1, 'only the executed test is counted')
  assert.equal(verdict.total, 2)
  ok('a skipped test is reported ok by TAP but excluded from the executed count')
}
{
  // Every test skipped: all ok lines, nothing demonstrated.
  const report = parseTap(fixture('allskip'))
  assert.ok(report.points.every(p => p.ok), 'TAP reports every skipped test as ok')
  const verdict = interpretTestReport(report, evidence())
  assert.equal(verdict.status, 'unverifiable')
  assert.equal(verdict.reason, 'no_tests_executed')
  ok('a fully skipped suite is unverifiable even though every point is ok')
}
{
  // A todo is likewise `ok`, and likewise not evidence.
  const report = parseTap(fixture('todo'))
  assert.equal(report.points[0].todo !== null, true)
  const verdict = interpretTestReport(report, evidence())
  assert.equal(verdict.status, 'passed')
  assert.equal(verdict.executed, 1, 'the todo is excluded like a skip')
  ok('a todo test is reported ok but is not counted as executed')
}
{
  // A file that registers no test still reports ok and `# pass 1`.
  const report = parseTap(fixture('none'))
  assert.equal(report.summary.pass, 1, 'the summary claims a pass for a file with no tests')
  assert.equal(report.points.length, 1)
  const verdict = interpretTestReport(report, evidence({ scope: ['none.mjs'] }))
  assert.equal(verdict.status, 'unverifiable', 'the file-level entry must not be mistaken for a test')
  assert.equal(verdict.reason, 'no_tests_executed')
  assert.match(verdict.detail, /file-level/)
  ok('a file with no tests reports ok and # pass 1, and is refused as unverifiable')
}
{
  // The same file-level entry, when not declared as scope, is still caught by
  // the "no executed test" guard only if it is a wrapper — so scope is what
  // distinguishes a real test named after a file from a wrapper.
  const report = parseTap(fixture('none'))
  const withScope = interpretTestReport(report, evidence({ scope: ['./none.mjs'] }))
  assert.equal(withScope.status, 'unverifiable')
  ok('a wrapper is recognised by basename too, not just by exact path')
}
{
  // Nested tests: the plan counts top-level, the summary counts leaves.
  const report = parseTap(fixture('nested'))
  assert.equal(report.plan, 1, 'the plan counts one top-level subtest')
  assert.equal(report.summary.tests, 3, 'the summary counts the parent and both children')
  assert.equal(report.points.length, 3)
  const cross = crossCheckReport(report)
  assert.equal(cross.ok, true, 'plan counts top-level, points include children — both consistent')
  ok('nested tests are counted at two levels without being treated as disagreement')
}
{
  // Diagnostics blocks hold arbitrary text, including things that look like points.
  const injected = [
    'TAP version 13',
    '# Subtest: evil',
    'not ok 1 - evil',
    '  ---',
    '  error: |',
    '    ok 2 - this looks like a passing point',
    '    not ok 3 - and so does this',
    '  ...',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1',
  ].join('\n')
  const report = parseTap(injected)
  assert.equal(report.points.length, 1, 'lines inside a diagnostics block are never parsed as points')
  assert.equal(report.points[0].name, 'evil')
  ok('point-shaped text inside a diagnostics block is ignored')
}

// --- provenance and integrity ---------------------------------------------
{
  const report = parseTap(fixture('pass'))
  const foreign = interpretTestReport(report, evidence({ callId: 'call-2' }))
  assert.equal(foreign.status, 'unverifiable')
  assert.equal(foreign.reason, 'foreign_report')
  ok('a report attributed to another callId is refused')
}
{
  const report = parseTap(fixture('fail'))
  const truncated = interpretTestReport(report, evidence({ truncated: true }))
  assert.equal(truncated.status, 'unverifiable')
  assert.equal(truncated.reason, 'truncated_report')
  ok('a truncated stream is refused rather than half-read')
}
{
  const verdict = interpretTestReport(parseTap('total garbage\nnot tap at all'), evidence())
  assert.equal(verdict.status, 'unrecognised')
  assert.equal(verdict.reason, 'not_tap')
  ok('non-TAP output is refused, not counted as zero failures')
}
{
  // A report that ends inside a diagnostics block is incomplete, not zero-fail.
  const report = parseTap('TAP version 13\n# Subtest: x\nnot ok 1 - x\n  ---\n  error: boom')
  assert.equal(report.recognised, false)
  assert.match(report.problem, /ends inside a diagnostics block/)
  ok('a report cut off inside a diagnostics block is not accepted')
}
{
  // Plan disagrees with the points actually present.
  const report = parseTap('TAP version 13\nok 1 - a\n1..5\n# tests 1')
  const cross = crossCheckReport(report)
  assert.equal(cross.ok, false)
  assert.match(cross.detail, /plan announces 5/)
  ok('a plan that disagrees with the reported points is refused')
}
{
  const report = parseTap('TAP version 13\nok 1 - a\n1..1\n# tests 9\n# pass 1\n# fail 0')
  const cross = crossCheckReport(report)
  assert.equal(cross.ok, false)
  assert.match(cross.detail, /summary counts 9/)
  ok('a summary that disagrees with the reported points is refused')
}

// --- required tests -------------------------------------------------------
{
  const report = parseTap(fixture('pass'))
  const missing = interpretTestReport(report, evidence({ requiredTests: ['integration'] }))
  assert.equal(missing.status, 'unverifiable')
  assert.equal(missing.reason, 'required_test_missing')
  ok('a required test that never appears is unverifiable')
}
{
  const report = parseTap(fixture('skip'))
  const notRun = interpretTestReport(report, evidence({ requiredTests: ['later'] }))
  assert.equal(notRun.status, 'unverifiable')
  assert.equal(notRun.reason, 'required_test_not_executed')
  ok('a required test that was skipped demonstrates nothing')
}
{
  const report = parseTap(fixture('pass'))
  const satisfied = interpretTestReport(report, evidence({ requiredTests: ['adds', 'subtracts'] }))
  assert.equal(satisfied.status, 'passed')
  ok('required tests that ran and passed are satisfied')
}

// --- the failure path -----------------------------------------------------
{
  const verdict = interpretTestReport(parseTap(fixture('fail')), evidence())
  assert.equal(verdict.status, 'failed')
  assert.equal(verdict.failures.length, 1)
  assert.equal(verdict.failures[0].name, 'subtracts')
  assert.equal(verdict.failures[0].error, '2 == 3')
  ok('a real failure produces failed with the failing test and its message')
}
{
  // A failure inside a skipped suite still fails: skip does not launder a failure.
  const report = parseTap(fixture('fail'))
  report.points[0].skip = 'ignored'
  report.summary.pass--
  report.summary.skipped++
  const verdict = interpretTestReport(report, evidence())
  assert.equal(verdict.status, 'failed')
  ok('marking a passing point skipped does not hide a separate real failure')
}

// --- passed is narrow -----------------------------------------------------
{
  const report = parseTap(fixture('pass'))
  const verdict = interpretTestReport(report, evidence())
  assert.equal(verdict.status, 'passed')
  assert.equal(verdict.executed, 2)
  ok('passed requires executed tests, all ok, consistent counts and matching provenance')
}

console.log(`${passed} tap groups passed`)
