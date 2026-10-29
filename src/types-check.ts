/**
 * Type-checker diagnostics: deciding when a `tsc` run supports "the types are
 * clean".
 *
 * A type check is a different protocol from TAP, and it fails differently. The
 * trap here is not a miscounted point; it is that **the compiler prints nothing
 * on success**, so "no output" and "the command was never a compiler" are byte-
 * identical. Three rules follow, and each one exists to stop a specific false
 * pass:
 *
 * 1. **Silence is only evidence when the exit code agrees.** `tsc` exits 0 when
 *    clean. Exit 0 with no diagnostics is a pass; exit non-zero with no
 *    diagnostics is *not* — that is a crashed compiler, a missing config, or a
 *    wrong command, and none of those say anything about the types.
 * 2. **Parsed errors decide failure, not the exit code.** A build script can
 *    swallow the exit status; the diagnostics themselves are the finding. One
 *    `error TS…` line means failed even if the process exited 0.
 * 3. **Only errors fail.** Warnings, suggestions and "X errors" summaries are
 *    not failures, and a summary line must not be counted as a diagnostic — it
 *    would double-count the errors it summarises.
 *
 * The rule that is *not* here: interpreting arbitrary output. A recipe marked
 * `types` whose output contains no recognisable diagnostic and whose exit code
 * is non-zero is `unverifiable`, because guessing at what the compiler meant is
 * exactly how a red build gets reported green.
 *
 * @module dsh-forge/types-check
 */

/** One parsed compiler diagnostic. */
export interface TypeDiagnostic {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning'
  code: string
  message: string
}

export interface TypeReport {
  /** False when the text carries no recognisable diagnostic in the expected protocol. */
  recognised: boolean
  diagnostics: TypeDiagnostic[]
  /** The trailing `Found N errors.` line, when the compiler printed one. */
  declaredErrors?: number
  problem?: string
  /**
   * The compiler printed nothing at all.
   *
   * Kept separate from `recognised: false` because the two mean opposite things.
   * `tsc` is silent on success, so an empty stream is the *normal* clean result —
   * while non-empty output that follows no known protocol is a command that never
   * spoke the language we approved it for. Collapsing them makes a clean type
   * check look unreadable, which is a false negative that trains a caller to
   * ignore the verdict.
   */
  empty: boolean
}

/**
 * `path(line,col): error TS1234: message`
 *
 * Paths may contain parentheses and spaces, so the position group is anchored to
 * a trailing `(digits,digits)` rather than matched greedily from the left.
 */
const DIAGNOSTIC = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\):\s+(?<severity>error|warning)\s+(?<code>TS\d+):\s*(?<message>.*)$/
/** `  Found 2 errors in 1 file.` — a summary, deliberately not a diagnostic. */
const FOUND = /^\s*Found\s+(?<count>\d+)\s+errors?\b.*$/

/**
 * Parse `tsc --pretty false` output.
 *
 * `recognised` is false for empty or unrelated output: the caller needs to tell
 * "the compiler found nothing" from "this text came from something else", and
 * only the exit code can separate those. Returning zero diagnostics with
 * `recognised: false` keeps that distinction available instead of collapsing it
 * into a clean bill of health.
 */
export function parseTypeDiagnostics(text: string): TypeReport {
  const diagnostics: TypeDiagnostic[] = []
  let declaredErrors: number | undefined
  let sawCompilerShape = false

  for (const raw of text.split(/\r?\n/)) {
    // Indented continuation lines (the `message` of a multiline diagnostic) are
    // appended to the previous finding rather than parsed as new ones.
    if (/^\s{2,}\S/.test(raw) && diagnostics.length > 0 && !DIAGNOSTIC.test(raw) && !FOUND.test(raw)) {
      const last = diagnostics[diagnostics.length - 1]
      last.message = `${last.message} ${raw.trim()}`.trim()
      continue
    }
    const found = FOUND.exec(raw)
    if (found !== null) {
      declaredErrors = Number(found.groups?.count)
      sawCompilerShape = true
      continue
    }
    const match = DIAGNOSTIC.exec(raw)
    if (match === null) continue
    sawCompilerShape = true
    const groups = match.groups
    diagnostics.push({
      file: (groups?.file ?? '').replace(/\\/g, '/'),
      line: Number(groups?.line),
      column: Number(groups?.column),
      severity: groups?.severity === 'warning' ? 'warning' : 'error',
      code: groups?.code ?? 'TS0',
      message: (groups?.message ?? '').trim(),
    })
  }

  if (text.trim().length === 0) {
    return {
      recognised: false,
      empty: true,
      diagnostics: [],
      problem: 'the compiler printed nothing, which is only meaningful alongside a zero exit code',
    }
  }
  if (!sawCompilerShape) {
    return {
      recognised: false,
      empty: false,
      diagnostics: [],
      problem: 'the output contains no TypeScript diagnostic or summary line',
    }
  }
  return { recognised: true, empty: false, diagnostics, ...(declaredErrors === undefined ? {} : { declaredErrors }) }
}

/** A type check's verdict. `passed` alone may be reported upward as clean types. */
export type TypeVerdict =
  | { status: 'passed'; files: number }
  | { status: 'failed'; errors: TypeDiagnostic[] }
  | { status: 'unverifiable'; reason: string; detail: string }

/**
 * Decide whether a type-check run supports "the types are clean".
 *
 * The three guards are ordered so that a real finding always wins over a
 * coverage caveat, and silence is never upgraded without the exit code agreeing.
 */
export function interpretTypeReport(report: TypeReport, evidence: { exitCode: number | null; truncated: boolean }): TypeVerdict {
  if (evidence.truncated) {
    return {
      status: 'unverifiable',
      reason: 'truncated_report',
      detail: 'the output stream was truncated, so neither the diagnostics nor the summary can be trusted',
    }
  }

  const errors = report.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  // Rule 2: the diagnostics themselves decide failure. A wrapper that exits 0
  // over a failing compile must not launder it.
  if (errors.length > 0) {
    return { status: 'failed', errors }
  }

  if (report.empty) {
    // Rule 1, the normal clean case: `tsc` says nothing when it succeeds.
    //
    // The residual assumption is that the approved command really is a type
    // checker — silence from an unrelated program is indistinguishable from a
    // clean compile. That assumption is carried by the approval, not by this
    // function: the plan froze `kind: 'types'` and a human agreed that this
    // command is a type check. A silent exit 0 from a program that was approved
    // as a type check is clean types.
    if (evidence.exitCode === 0) return { status: 'passed', files: 0 }
    return {
      status: 'unverifiable',
      reason: 'no_diagnostics_but_nonzero_exit',
      detail: `the command printed nothing but exited ${evidence.exitCode ?? 'without a code'}; silence is only meaningful with a zero exit, so this is a failed invocation rather than clean types`,
    }
  }

  if (!report.recognised) {
    // Non-empty output that follows no known protocol: the command ran, and it
    // did not speak the language it was approved to speak.
    return {
      status: 'unverifiable',
      reason: 'compiler_output_not_recognised',
      detail: report.problem ?? 'the output does not follow the TypeScript diagnostic protocol',
    }
  }

  if (evidence.exitCode === null) {
    return {
      status: 'unverifiable',
      reason: 'no_exit_code',
      detail: 'the process did not report an exit code, so a clean-looking report proves nothing',
    }
  }
  if (evidence.exitCode !== 0) {
    // Diagnostics were parsed, none of them errors, yet the exit code is
    // non-zero: the invariance this module refuses to paper over.
    return {
      status: 'unverifiable',
      reason: 'clean_diagnostics_but_nonzero_exit',
      detail: `no error diagnostics, but the process exited ${evidence.exitCode}; a non-zero exit means something failed that this protocol did not describe`,
    }
  }
  const files = new Set(report.diagnostics.map(diagnostic => diagnostic.file))
  return { status: 'passed', files: files.size }
}
