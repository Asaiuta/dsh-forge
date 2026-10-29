/**
 * M1.4 — TypeScript diagnostics.
 *
 * The claim: **"the types are clean" is reachable only when the compiler said
 * nothing and exited 0**, and no other shape of output can be upgraded into it.
 *
 * The asymmetry with TAP is the point. A test report enumerates what ran, so
 * absence is visible. A type check is silent on success, so *absence is the
 * expected good news* — which makes "did it even run?" the hard question. These
 * cases pin the answer: the exit code is the only thing that separates a clean
 * compile from a command that never compiled anything.
 */
import assert from 'node:assert/strict'

const { parseTypeDiagnostics, interpretTypeReport } = await import('../lib/types-check.js')

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const judge = (text, exitCode, truncated = false) =>
  interpretTypeReport(parseTypeDiagnostics(text), { exitCode, truncated })

// --- the clean case: silence ---------------------------------------------
{
  const verdict = judge('', 0)
  assert.equal(verdict.status, 'passed', 'tsc prints nothing on success; that is the normal clean result')
  ok('silence plus exit 0 is clean types')
}
{
  const verdict = judge('   \n\n  ', 0)
  assert.equal(verdict.status, 'passed', 'whitespace-only output is still silence')
  ok('whitespace-only output counts as silence')
}
{
  // The invariant that stops a false negative from becoming a habit.
  const verdict = judge('', 2)
  assert.equal(verdict.status, 'unverifiable')
  assert.equal(verdict.reason, 'no_diagnostics_but_nonzero_exit')
  assert.match(verdict.detail, /exited 2/, 'the detail must attribute the verdict to the exit code')
  assert.ok(!/^clean types$/i.test(verdict.detail))
  ok('silence plus a non-zero exit is a failed invocation, not clean types')
}
{
  const verdict = judge('', null)
  assert.equal(verdict.status, 'unverifiable')
  assert.notEqual(verdict.status, 'passed', 'no exit code means no proof')
  ok('silence with no exit code proves nothing')
}

// --- parsing --------------------------------------------------------------
{
  const report = parseTypeDiagnostics("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.")
  assert.equal(report.recognised, true)
  assert.equal(report.diagnostics.length, 1)
  assert.deepEqual(report.diagnostics[0], {
    file: 'src/a.ts', line: 3, column: 7, severity: 'error', code: 'TS2322',
    message: "Type 'string' is not assignable to type 'number'.",
  })
  ok('a diagnostic line parses into file, position, code and message')
}
{
  const report = parseTypeDiagnostics('src/a.ts(1,1): warning TS6133: unused\n\nFound 0 errors in 1 file.')
  assert.equal(report.diagnostics.length, 1)
  assert.equal(report.diagnostics[0].severity, 'warning')
  assert.equal(report.declaredErrors, 0)
  const verdict = interpretTypeReport(report, { exitCode: 0, truncated: false })
  assert.equal(verdict.status, 'passed', 'a warning is not an error')
  ok('warnings do not fail a type check')
}
{
  // A path containing spaces and parentheses must not break the position match.
  const report = parseTypeDiagnostics('C:/my code/(v2)/src/a.ts(10,4): error TS1005: expected ;')
  assert.equal(report.diagnostics.length, 1)
  assert.equal(report.diagnostics[0].file, 'C:/my code/(v2)/src/a.ts')
  assert.equal(report.diagnostics[0].line, 10)
  ok('a path with spaces and parentheses still resolves its position')
}
{
  const report = parseTypeDiagnostics('Found 2 errors in 1 file.')
  assert.equal(report.diagnostics.length, 0, 'the summary line is not a diagnostic')
  assert.equal(report.declaredErrors, 2)
  ok('the "Found N errors" summary is recorded but never counted as a diagnostic')
}
{
  const report = parseTypeDiagnostics('some unrelated program output\nnothing to see')
  assert.equal(report.recognised, false)
  assert.equal(report.empty, false)
  const verdict = interpretTypeReport(report, { exitCode: 0, truncated: false })
  assert.equal(verdict.status, 'unverifiable')
  assert.equal(verdict.reason, 'compiler_output_not_recognised')
  ok('non-TypeScript output is refused rather than read as zero errors')
}

// --- the diagnostic wins over the exit code ------------------------------
{
  const text = "src/a.ts(1,1): error TS1005: expected ;\n\nFound 1 error in 1 file."
  const verdict = judge(text, 0)
  assert.equal(verdict.status, 'failed', 'a wrapper that exits 0 must not launder a real error')
  assert.equal(verdict.errors.length, 1)
  ok('a parsed error fails the run even when the process exited 0')
}
{
  const text = 'src/a.ts(1,1): error TS1005: expected ;\nsrc/b.ts(2,2): error TS2322: bad'
  const verdict = judge(text, 1)
  assert.equal(verdict.status, 'failed')
  assert.equal(verdict.errors.length, 2)
  ok('multiple errors are all reported')
}
{
  // Diagnostics parsed, no errors, but a non-zero exit: something failed that the
  // protocol did not describe, and guessing would be how a red build goes green.
  const verdict = judge('src/a.ts(1,1): warning TS6133: unused', 1)
  assert.equal(verdict.status, 'unverifiable')
  assert.equal(verdict.reason, 'clean_diagnostics_but_nonzero_exit')
  ok('clean diagnostics with a non-zero exit refutes the read-out instead of trusting it')
}

// --- incompleteness -------------------------------------------------------
{
  const verdict = judge('', 0, true)
  assert.equal(verdict.status, 'unverifiable')
  assert.equal(verdict.reason, 'truncated_report')
  ok('a truncated stream cannot prove clean types')
}

console.log(`${passed} types-check groups passed`)
