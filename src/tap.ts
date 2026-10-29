/**
 * Node TAP interpretation: turning a test run's output into a verdict that is
 * allowed to say "the tests passed".
 *
 * Everything here exists because the naive reading is wrong in five separate
 * ways, each demonstrated by a real `node --test --test-reporter=tap` run:
 *
 * 1. **A skipped test is reported `ok`.** `ok 3 - skipped # SKIP not ready` is a
 *    passing TAP point. Counting `ok` lines reports a fully skipped suite as
 *    green.
 * 2. **A todo test is reported `ok` too.** `ok 4 - todoed # TODO` is likewise a
 *    pass in TAP. A todo is an acknowledgement of unfinished work, not evidence
 *    of it.
 * 3. **A file with no tests is reported `ok`.** `node --test empty.mjs` emits
 *    `ok 1 - empty.mjs` and `# pass 1`. A "did any test actually run" check that
 *    trusts the summary passes on a file that registered nothing.
 * 4. **Nested tests are counted differently at two levels.** The `1..N` plan
 *    counts top-level subtests; `# tests` counts every leaf. A parent subtest
 *    line stands for a whole subtree.
 * 5. **Diagnostics blocks contain arbitrary text.** A stack trace or an assertion
 *    message can hold anything, including lines that look like points, so the
 *    `---`/`...` block has to be skipped as a unit rather than matched line by
 *    line.
 *
 * The module therefore never infers a verdict from the summary alone: it parses
 * points, classifies each as executed/skipped/todo, subtracts file-level
 * wrappers, and reports why it could not give a verdict instead of guessing.
 *
 * Supported surface is deliberately narrow: Node's own TAP. Any other output is
 * `unrecognised`, which is a refusal to interpret rather than an interpretation.
 *
 * @module dsh-forge/tap
 */

/** One parsed test point. */
export interface TapPoint {
  /** 1-based index as written in the report (may repeat across files). */
  number: number
  /** Test name as reported, after directive stripping. */
  name: string
  ok: boolean
  /** Nesting depth; 0 is a top-level subtest. */
  depth: number
  skip: string | null
  todo: string | null
  /** Diagnostics attached by the reporter, when present. */
  error?: string
  cancelled?: boolean
  type?: 'test' | 'suite'
}

export interface TapSummary {
  tests?: number
  suites?: number
  pass?: number
  fail?: number
  cancelled?: number
  skipped?: number
  todo?: number
}

export interface TapReport {
  /** False when the text is not TAP this module recognises. */
  recognised: boolean
  version?: number
  /** The `1..N` plan, when present. */
  plan?: number
  /** Every parsed point, in report order. */
  points: TapPoint[]
  summary: TapSummary
  /** Why recognition failed; absent when it succeeded. */
  problem?: string
}

/** Evidence the caller must supply; the report alone cannot prove provenance. */
export interface ReportEvidence {
  /** Registry callId of the run that produced this output. */
  callId: string
  /** The callId the report is being attributed to. Equal ids are the proof. */
  expectedCallId: string
  /** True when the stream was truncated, so the tail (summary) may be absent. */
  truncated: boolean
  /**
   * Paths the run was told to execute. A point whose name matches one of them is
   * a file-level wrapper, not a test — see case 3 in the module comment.
   */
  scope?: readonly string[]
  /** Test names that must have actually run, not been skipped or left as todo. */
  requiredTests?: readonly string[]
}

/**
 * The interpretation verdict.
 *
 * `passed` is the only state that may be reported upward as "the tests passed",
 * and it is reachable only when every guard holds. `unverifiable` and
 * `unrecognised` are not soft failures: they mean the report cannot support any
 * claim about tests.
 */
export type TestVerdict =
  | { status: 'passed'; executed: number; total: number }
  | { status: 'failed'; executed: number; total: number; failures: Array<{ name: string; error?: string }> }
  | { status: 'unverifiable'; reason: string; detail: string }
  | { status: 'unrecognised'; reason: string; detail: string }

const POINT = /^(?<indent>[ \t]*)(?<ok>not ok|ok)\b(?<rest>.*)$/
const PLAN = /^(?<indent>[ \t]*)(?<plan>\d+)\.\.(?<count>\d+)\s*$/
const SUBTEST = /^(?<indent>[ \t]*)#\s*Subtest:\s*(?<name>.*)$/
const SUMMARY = /^#\s*(?<key>tests|suites|pass|fail|cancelled|skipped|todo)\s+(?<value>\d+)\s*$/
const VERSION = /^TAP version (?<version>\d+)\s*$/
const DIRECTIVE = /^#\s*(?<kind>SKIP|TODO)\b\s*(?<reason>.*)$/i

function indentWidth(text: string): number {
  let width = 0
  for (const char of text) {
    if (char === ' ') width += 1
    else if (char === '\t') width += 4
    else break
  }
  return width
}

/**
 * Strip and capture a trailing `# SKIP`/`# TODO` directive.
 *
 * TAP allows the directive after the description, and Node writes it exactly
 * there (`ok 3 - skipped # SKIP not ready`). Both are reported as `ok`, which is
 * why the directive has to be separated from the name before any counting
 * happens.
 */
function splitDirective(text: string): { name: string; skip: string | null; todo: string | null } {
  // The directive begins at the last `#` that starts a directive keyword; a `#`
  // inside a test name is ordinary text, so the scan is keyword-anchored.
  const match = /(?:^|\s)#\s*(SKIP|TODO)\b\s*(.*)$/i.exec(text)
  if (match === null) return { name: text.trim(), skip: null, todo: null }
  const kind = match[1].toUpperCase()
  const reason = match[2].trim()
  const name = text.slice(0, match.index).trim()
  return kind === 'SKIP'
    ? { name, skip: reason.length > 0 ? reason : 'skipped', todo: null }
    : { name, skip: null, todo: reason.length > 0 ? reason : 'todo' }
}

/**
 * Parse Node TAP into points plus the summary block.
 *
 * Synthetic points are avoided on purpose: a missing summary must stay missing
 * so the caller can refuse to interpret, rather than being filled in with zeros
 * that look like a clean run.
 */
export function parseTap(text: string): TapReport {
  const lines = text.split(/\r?\n/)
  const points: TapPoint[] = []
  const summary: TapSummary = {}
  let version: number | undefined
  let plan: number | undefined
  let inDiagnostics = false
  let diagnosticsDepth = 0
  let lastPoint: TapPoint | undefined
  let problem: string | undefined
  const subtests: Array<{ depth: number; children: TapPoint[]; plan?: number }> = []

  for (const line of lines) {
    if (inDiagnostics) {
      // A diagnostics block ends at a `...` line at the same
      // indentation. Content inside is reporter-supplied and never parsed.
      if (/^[ \t]*\.\.\.\s*$/.test(line) && indentWidth(line) === diagnosticsDepth) inDiagnostics = false
      else {
        const key = /^[ \t]+(?<key>error|code|name|failureType|type):\s*(?<value>.*)$/.exec(line)
        if (key !== null && lastPoint !== undefined && lastPoint.error === undefined && key.groups?.key === 'error') {
          lastPoint.error = (key.groups.value ?? '').trim().replace(/^['"]|['"]$/g, '')
        }
        if (key?.groups?.key === 'failureType' && lastPoint && /cancelledByParent|testAborted/.test(key.groups.value ?? '')) lastPoint.cancelled = true
        if (key?.groups?.key === 'type' && lastPoint) {
          const type = key.groups.value.replace(/^['"]|['"]$/g, '')
          if (type === 'test' || type === 'suite') lastPoint.type = type
        }
      }
      continue
    }
    if (/^[ \t]*---\s*$/.test(line)) {
      inDiagnostics = true
      diagnosticsDepth = indentWidth(line)
      continue
    }

    const versionMatch = VERSION.exec(line)
    if (versionMatch !== null) {
      if (version !== undefined) problem = 'the report contains multiple TAP headers'
      version = Number(versionMatch.groups?.version)
      continue
    }
    if (/^[ \t]*Bail out!/i.test(line)) problem = 'the TAP run bailed out before completion'

    const summaryMatch = SUMMARY.exec(line)
    if (summaryMatch !== null) {
      const key = summaryMatch.groups?.key as keyof TapSummary
      if (summary[key] !== undefined) problem = `the report repeats the ${key} summary`
      summary[key] = Number(summaryMatch.groups?.value)
      continue
    }

    const planMatch = PLAN.exec(line)
    if (planMatch !== null) {
      const depth = indentWidth(line) / 4
      if (depth === 0) {
        if (plan !== undefined) problem = 'the report contains multiple outer plans'
        if (Number(planMatch.groups?.plan) !== 1) problem = 'the outer plan must start at 1'
        plan = Number(planMatch.groups?.count)
      } else {
        const parent = subtests.at(-1)
        if (!Number.isInteger(depth) || parent?.depth !== depth - 1) problem = 'a nested plan has no matching subtest'
        else if (parent.plan !== undefined) problem = 'a subtest contains multiple nested plans'
        else {
          if (Number(planMatch.groups?.plan) !== 1) problem = 'a nested plan must start at 1'
          parent.plan = Number(planMatch.groups?.count)
        }
      }
      continue
    }

    const subtest = SUBTEST.exec(line)
    if (subtest !== null) {
      const depth = indentWidth(line) / 4
      if (!Number.isInteger(depth) || (depth > 0 && subtests.at(-1)?.depth !== depth - 1) || (subtests.at(-1)?.depth ?? -1) >= depth) {
        problem = 'a subtest starts before its preceding subtest completed'
      }
      subtests.push({ depth, children: [] })
      continue
    }

    const pointMatch = POINT.exec(line)
    if (pointMatch !== null) {
      const indent = indentWidth(pointMatch.groups?.indent ?? '')
      // Node's TAP reporter indents each subtest level by four spaces.
      const depth = indent / 4
      if (!Number.isInteger(depth)) problem = 'the report uses an unsupported subtest indentation'
      const rest = (pointMatch.groups?.rest ?? '').replace(/^\s*\d+\s*-\s*/, '')
      const { name, skip, todo } = splitDirective(rest)
      const point: TapPoint = {
        number: Number(/^\s*(\d+)/.exec(pointMatch.groups?.rest ?? '')?.[1] ?? 0),
        name: name.length > 0 ? name : '(unnamed)',
        ok: pointMatch.groups?.ok === 'ok',
        depth,
        skip,
        todo,
      }
      points.push(point)
      lastPoint = point
      const current = subtests.at(-1)
      if (current?.depth === point.depth) {
        subtests.pop()
        if (current.children.length > 0 && current.plan === undefined) problem = 'a nested subtest has no completion plan'
        if (current.plan !== undefined && current.plan !== current.children.length) problem = `a nested plan announces ${current.plan} test(s) but ${current.children.length} were reported`
        if (current.children.some((child, index) => child.number !== index + 1)) problem = 'nested test point numbers are missing, duplicated or out of order'
      }
      const parent = subtests.at(-1)
      if (parent?.depth === point.depth - 1) parent.children.push(point)
      else if (point.depth > 0) problem = 'a nested test point has no matching parent'
      continue
    }
  }
  // A block that never closed still suppresses its own content: the `problem`
  // field then reports a truncated report instead of a partial parse.
  const unterminated = inDiagnostics && diagnosticsDepth >= 0 && text.trim().length > 0

  if (version === undefined) {
    return { recognised: false, points: [], summary, problem: 'the output does not begin with a TAP version line' }
  }
  if (unterminated) {
    return { recognised: false, points: [], summary, problem: 'the report ends inside a diagnostics block, so it is incomplete' }
  }
  if (subtests.length > 0) problem = 'the report ends before a subtest completes'
  return { recognised: true, version, ...(plan === undefined ? {} : { plan }), points, summary, ...(problem ? { problem } : {}) }
}

/** Names a point can have when it stands for a file rather than a test. */
function isFileWrapper(name: string, scope: readonly string[]): boolean {
  const normalise = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '')
  const target = normalise(name)
  for (const entry of scope) {
    const candidate = normalise(entry)
    if (target === candidate) return true
    // Node writes the path exactly as it was given, which may be relative to a
    // cwd we do not know here. The basename is the stable fallback.
    const base = candidate.split('/').pop()
    if (base !== undefined && base.length > 0 && target === base) return true
  }
  return false
}

/**
 * Decide whether a report supports "the tests passed".
 *
 * Order matters, and each guard answers a distinct question:
 *
 * 1. **Is this a report at all?** Unrecognised output is refused, not treated
 *    as zero failures.
 * 2. **Is it this run's report?** A callId mismatch means the text describes
 *    some other execution.
 * 3. **Is it complete?** A truncated stream may have lost its summary or its
 *    tail of failures, so no count from it is trustworthy.
 * 4. **Did anything actually run?** File-level wrappers are removed first, then
 *    skips and todos; what remains must be greater than zero.
 * 5. **Did all of it pass?** Any `not ok` fails the run, and required tests must
 *    be present and executed.
 */
export function interpretTestReport(report: TapReport, evidence: ReportEvidence): TestVerdict {
  if (!report.recognised) {
    return { status: 'unrecognised', reason: 'not_tap', detail: report.problem ?? 'the output is not a recognised TAP report' }
  }
  if (evidence.callId !== evidence.expectedCallId) {
    return {
      status: 'unverifiable',
      reason: 'foreign_report',
      detail: `the report carries callId ${evidence.callId || '(none)'} but belongs to ${evidence.expectedCallId}`,
    }
  }
  if (evidence.truncated) {
    return {
      status: 'unverifiable',
      reason: 'truncated_report',
      detail: 'the output stream was truncated, so neither the summary nor the tail of failures can be trusted',
    }
  }
  const integrity = crossCheckReport(report)
  if (!integrity.ok) return { status: 'unverifiable', reason: 'inconsistent_report', detail: integrity.detail }

  const scope = evidence.scope ?? []
  const wrappers = report.points.filter(point => point.depth === 0 && isFileWrapper(point.name, scope))
  // A wrapper is removed only when it stands alone; a point that happens to share
  // a file's name but has siblings is more likely a real test.
  const points = report.points.filter(point => !wrappers.includes(point))
  const executedPoints = points.filter(point => point.type !== 'suite' && !point.cancelled && point.skip === null && point.todo === null)
  const skipped = points.filter(point => point.skip !== null)
  const todoed = points.filter(point => point.todo !== null)
  const failures = points.filter(point => !point.ok && point.skip === null && point.todo === null && !point.cancelled)

  // A failing suite hook can cancel every child before any test completes.
  // Its explicit failure remains a failure even with zero executed tests.
  if (failures.length > 0) {
    return {
      status: 'failed',
      executed: executedPoints.length,
      total: points.length,
      failures: failures.map(point => ({ name: point.name, ...(point.error === undefined ? {} : { error: point.error }) })),
    }
  }

  if (executedPoints.length === 0) {
    const onlyWrappers = report.points.length > 0 && points.length === 0
    const detail = onlyWrappers
      ? `the run reported ${report.points.length} file-level entr(ies) and no test: a file that registers no test still reports ok`
      : skipped.length + todoed.length === report.points.length && report.points.length > 0
        ? `every reported test was skipped (${skipped.length}) or left as todo (${todoed.length}); neither demonstrates a pass`
        : 'the report contains no executed test point'
    return { status: 'unverifiable', reason: 'no_tests_executed', detail }
  }

  if (points.some(point => point.cancelled)) return { status: 'unverifiable', reason: 'cancelled_tests', detail: 'some reported tests were cancelled before completion' }

  for (const required of evidence.requiredTests ?? []) {
    const found = points.filter(point => point.name === required)
    if (found.length === 0) {
      return { status: 'unverifiable', reason: 'required_test_missing', detail: `required test "${required}" does not appear in the report` }
    }
    if (found.every(point => point.type === 'suite' || point.skip !== null || point.todo !== null || point.cancelled)) {
      const state = found.some(point => point.type === 'suite') ? 'reported as a suite rather than an executed test'
        : found.some(point => point.skip !== null) ? 'skipped' : found.some(point => point.cancelled) ? 'cancelled' : 'left as todo'
      return {
        status: 'unverifiable',
        reason: 'required_test_not_executed',
        detail: `required test "${required}" was ${state}, which demonstrates nothing`,
      }
    }
  }

  return { status: 'passed', executed: executedPoints.length, total: points.length }
}

/**
 * Check the report against itself before trusting any count.
 *
 * Two independent statements describe the same run — the `1..N` plan and the
 * `# tests N` summary — plus the points actually present. When they disagree
 * the report is internally inconsistent and no figure from it is usable, which
 * is exactly what a truncated or interleaved stream looks like.
 */
export function crossCheckReport(report: TapReport): { ok: true; total: number } | { ok: false; detail: string } {
  if (!report.recognised) return { ok: false, detail: report.problem ?? 'not a TAP report' }
  if (report.problem) return { ok: false, detail: report.problem }
  if (report.version !== 13) return { ok: false, detail: 'only TAP version 13 reports are supported' }
  if (report.plan === undefined) return { ok: false, detail: 'the report has no outer plan; completion is unproven' }
  if (report.points.length === 0) return { ok: false, detail: 'the report contains no test points' }
  const topLevel = report.points.filter(point => point.depth === 0)
  if (report.plan !== topLevel.length) {
    return { ok: false, detail: `the plan announces ${report.plan} top-level test(s) but ${topLevel.length} were reported` }
  }
  if (topLevel.some((point, index) => point.number !== index + 1)) return { ok: false, detail: 'the outer test point numbers are missing, duplicated or out of order' }
  for (const key of ['tests', 'pass', 'fail'] as const) {
    if (report.summary[key] === undefined) return { ok: false, detail: `the Node TAP report has no ${key} summary` }
  }
  const tests = report.points.filter(point => point.type !== 'suite')
  if (report.summary.tests !== tests.length) {
    return { ok: false, detail: `the summary counts ${report.summary.tests} test(s) but ${tests.length} were reported` }
  }
  if (report.summary.suites !== undefined && report.summary.suites !== report.points.length - tests.length) return { ok: false, detail: 'the suite summary disagrees with the reported suite points' }
  const counts = {
    pass: tests.filter(point => point.ok && point.skip === null && point.todo === null && !point.cancelled).length,
    fail: tests.filter(point => !point.ok && point.skip === null && point.todo === null && !point.cancelled).length,
    cancelled: tests.filter(point => point.cancelled && point.skip === null && point.todo === null).length,
    skipped: tests.filter(point => point.skip !== null).length,
    todo: tests.filter(point => point.todo !== null).length,
  }
  for (const key of ['pass', 'fail', 'cancelled', 'skipped', 'todo'] as const) {
    if (report.summary[key] !== undefined && report.summary[key] !== counts[key]) {
      return { ok: false, detail: `the ${key} summary counts ${report.summary[key]} but the test points report ${counts[key]}` }
    }
  }
  return { ok: true, total: report.points.length }
}
