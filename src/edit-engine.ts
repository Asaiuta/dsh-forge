/**
 * dsh-forge tolerant line-edit engine (stage 3). Clean-room implementation of
 * the construction-engine behaviors documented in the ProjectForge devlog —
 * no ProjectForge code.
 *
 * The engine is a PURE function over line arrays: no fs, no AST, no time.
 * The tool layer (src/tools-edit.ts) owns I/O, hashing, snapshots and
 * symbol annotation.
 *
 * Contract, mirroring the forge plan:
 * - All step coordinates refer to the ORIGINAL snapshot (调用前的原始快照为
 *   坐标). Steps are compiled to disjoint original-text ranges, overlap is an
 *   error (never guessed), and the result is assembled in one ascending pass.
 * - `expect` anchors: when the line at the given coordinate doesn't hold the
 *   expected content, the engine re-anchors within ±20 lines to the NEAREST
 *   match and reports the drift.
 * - First/last anchoring: if a replacement quotes the range's own first and
 *   last lines (the classic LLM over-quotation), the anchors are recognized
 *   and only the interior is replaced — no duplicated boundary lines.
 * - `N | ` line-number prefixes are stripped only when EVERY non-empty line
 *   carries one (markdown tables survive).
 * - target steps match whole blocks: exact, then trim-tolerant with the
 *   replacement re-indented to the actual match. Zero matches return the
 *   most similar lines; multiple matches return candidates for a ticket.
 * - atomic mode (default): any step failure aborts the whole batch.
 *   bestEffort: failed steps are skipped and reported.
 *
 * Line contract: 1-based, inclusive, over LF-normalized text — the same
 * contract as src/ast.ts.
 *
 * @module dsh-forge/edit-engine
 */

// ---------------------------------------------------------------------------
// Step shapes
// ---------------------------------------------------------------------------

export type EditOp = 'replace' | 'insert' | 'delete' | 'target'

export interface EditStep {
  op?: EditOp
  /** replace/delete: first affected line (1-based, original coordinates). */
  start?: number
  /** replace/delete: last affected line, inclusive. Default = start. */
  end?: number
  /** insert: boundary — text lands after original line N (0 = top of file). */
  after?: number
  /** target: the block to locate (multi-line, joined with \n). */
  find?: string
  /** target: replacement block; omit for a pure no-op match? No — required. */
  replaceWith?: string
  /** replacement text for replace/insert (joined with \n). */
  text?: string
  /** expected content of the anchor line (drift correction). */
  expect?: string
  /** Inline target is a literal substring, still bound to original offsets. */
  inline?: boolean
}

export interface StepSuggestion {
  line: number
  score: number
  text: string
}

export interface StepCandidate {
  /** 1-based inclusive original range of the candidate block. */
  start: number
  end: number
  startOffset?: number
  endOffset?: number
}

export interface StepReport {
  index: number
  op: EditOp
  status: 'applied' | 'drifted' | 'failed' | 'skipped'
  /** Lines the expect anchor moved by (negative = upward). */
  drift?: number
  /** The replacement quoted the range's own first/last lines; kept as anchors. */
  anchorsPreserved?: boolean
  /** Replacement was re-indented to the actual match (trim-tolerant path). */
  indentShifted?: boolean
  /** Innermost enclosing symbol of the edited range (tool layer annotates). */
  symbol?: string
  reason?: string
  suggestions?: StepSuggestion[]
  /** Original-coordinate range the step acted on. */
  originalRange?: StepCandidate
  /** New-coordinate range in the resulting file. */
  newRange?: StepCandidate
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface AppliedEdit {
  ok: true
  text: string
  reports: StepReport[]
}

export interface FailedEdit {
  ok: false
  /** Human-readable failure summary (atomic abort, invalid steps, …). */
  reason: string
  reports: StepReport[]
  /** Present when an atomic batch failed on an ambiguous target step. */
  ambiguity?: {
    stepIndex: number
    candidates: StepCandidate[]
  }
}

export type EditOutcome = AppliedEdit | FailedEdit

export interface EditOptions {
  mode?: 'atomic' | 'bestEffort'
  /** expect re-anchor search radius (default 20). */
  expectWindow?: number
  /**
   * Ticket resolution pinning: apply the target step at these verified
   * coordinates instead of re-scanning (ffresolve). The pinned block is
   * trim-verified against current content; a mismatch fails the step.
   */
  pinnedTarget?: { stepIndex: number; start: number; end: number }
  pinnedTargets?: Array<StepCandidate & { stepIndex: number }>
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const PREFIX_RE = /^[ \t]*(?:>[ \t]*)?\d+[ \t]+\| ?/

/**
 * Strip `N | ` line-number prefixes — but only when EVERY non-empty line
 * carries one, so markdown tables and quoted prose survive untouched.
 */
export function stripLinePrefixes(block: string): { text: string; stripped: boolean } {
  const lines = block.split('\n')
  const nonEmpty = lines.filter((l) => l.trim() !== '')
  if (nonEmpty.length === 0 || !nonEmpty.every((l) => PREFIX_RE.test(l))) {
    return { text: block, stripped: false }
  }
  return { text: lines.map((l) => l.replace(PREFIX_RE, '')).join('\n'), stripped: true }
}

function splitBlock(block: string | undefined): string[] {
  if (block === undefined || block === null) return []
  return block.split('\n')
}

function leadingWhitespace(line: string): string {
  const match = line.match(/^[ \t]*/)
  return match ? match[0] : ''
}

function shiftIndent(lines: string[], delta: number, sampleIndent: string): string[] {
  if (delta === 0) return lines
  return lines.map((line) => {
    if (line.trim() === '') return line
    if (delta > 0) return sampleIndent.slice(0, delta) + line
    const indentLen = line.length - line.trimStart().length
    return line.slice(Math.min(-delta, indentLen))
  })
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]
}

/** 0..1 similarity on trimmed lines. */
export function lineSimilarity(a: string, b: string): number {
  const x = a.trim()
  const y = b.trim()
  if (x === y) return 1
  const max = Math.max(x.length, y.length)
  if (max === 0) return 1
  return 1 - levenshtein(x, y) / max
}

function suggestionsFor(lines: string[], probe: string, exclude: number[]): StepSuggestion[] {
  const scored: StepSuggestion[] = []
  for (let i = 0; i < lines.length; i++) {
    if (exclude.includes(i + 1)) continue
    const score = lineSimilarity(lines[i], probe)
    if (score >= 0.4) scored.push({ line: i + 1, score: Math.round(score * 100) / 100, text: lines[i].slice(0, 200) })
  }
  scored.sort((a, b) => b.score - a.score || a.line - b.line)
  return scored.slice(0, 3)
}

// ---------------------------------------------------------------------------
// Step normalization & planning
// ---------------------------------------------------------------------------

interface PlannedRange {
  stepIndex: number
  start: number
  end: number
  lines: string[]
  report: StepReport
}

interface PlannedInsert {
  stepIndex: number
  boundary: number
  lines: string[]
  report: StepReport
}

type Planned =
  | { kind: 'range'; op: PlannedRange }
  | { kind: 'ranges'; ops: PlannedRange[] }
  | { kind: 'insert'; op: PlannedInsert }
  | { kind: 'failed'; report: StepReport }
  | { kind: 'ambiguous'; stepIndex: number; candidates: StepCandidate[]; report: StepReport }

function inferOp(step: EditStep): EditOp | null {
  if (step.op) return step.op
  if (step.find !== undefined) return 'target'
  if (step.after !== undefined) return 'insert'
  if (step.start !== undefined) return step.text !== undefined ? 'replace' : 'delete'
  return null
}

/** expect drift correction: returns lines moved (0 = in place), or null if unresolvable. */
function reanchor(lines: string[], anchor: number, expect: string, window: number): number | null {
  if (anchor >= 1 && anchor <= lines.length && lines[anchor - 1].trim() === expect.trim()) return 0
  for (let r = 1; r <= window; r++) {
    const up = anchor - r
    if (up >= 1 && up <= lines.length && lines[up - 1].trim() === expect.trim()) return -r
    const down = anchor + r
    if (down >= 1 && down <= lines.length && lines[down - 1].trim() === expect.trim()) return r
  }
  return null
}

interface TargetMatch {
  candidates: StepCandidate[]
  /** indent delta measured on the (first) trim-tolerant match. */
  indentDelta: number
  indentSample: string
}

function matchTarget(lines: string[], findLines: string[]): TargetMatch | null {
  if (findLines.length === 0 || findLines.every((l) => l.trim() === '')) return null
  const candidates: StepCandidate[] = []
  let indentDelta = 0
  let indentSample = ''
  const span = findLines.length
  for (let i = 0; i + span <= lines.length; i++) {
    let hit = true
    for (let k = 0; k < span; k++) {
      if (lines[i + k] !== findLines[k]) {
        hit = false
        break
      }
    }
    if (hit) candidates.push({ start: i + 1, end: i + span })
  }
  if (candidates.length > 0) return { candidates, indentDelta: 0, indentSample: '' }
  // trim-tolerant pass
  for (let i = 0; i + span <= lines.length; i++) {
    let hit = true
    for (let k = 0; k < span; k++) {
      if (lines[i + k].trim() !== findLines[k].trim()) {
        hit = false
        break
      }
    }
    if (hit) {
      candidates.push({ start: i + 1, end: i + span })
      if (candidates.length === 1) {
        const actual = leadingWhitespace(lines[i])
        const wanted = leadingWhitespace(findLines[0])
        indentDelta = actual.length - wanted.length
        indentSample = actual
      }
    }
  }
  if (candidates.length === 0 && findLines.some(line => ['...', '…'].includes(line.trim()))) {
    const segments: string[][] = [[]]
    for (const line of findLines) {
      if (['...', '…'].includes(line.trim())) segments.push([])
      else segments.at(-1)!.push(line)
    }
    if (segments.some(segment => segment.length === 0)) return null
    let work = 0
    const fits = (start: number, segment: string[]) => start + segment.length <= lines.length && segment.every((line, index) => lines[start + index].trim() === line.trim())
    const extend = (start: number, cursor: number, index: number): void => {
      if (index === segments.length) { candidates.push({ start: start + 1, end: cursor }); return }
      for (let row = cursor; row < lines.length && ++work < 100000 && candidates.length < 100; row++) {
        if (fits(row, segments[index])) extend(start, row + segments[index].length, index + 1)
      }
    }
    for (let start = 0; start < lines.length && work < 100000 && candidates.length < 100; start++) {
      if (fits(start, segments[0])) extend(start, start + segments[0].length, 1)
    }
    if (work >= 100000 || candidates.length >= 100) throw new Error('elided target exceeds candidate/search budget; use a narrower anchor')
    if (candidates.length > 0) {
      const actual = leadingWhitespace(lines[candidates[0].start - 1]), wanted = leadingWhitespace(findLines[0])
      indentDelta = actual.length - wanted.length; indentSample = actual
    }
  }
  if (candidates.length === 0) return null
  return { candidates, indentDelta, indentSample }
}

export function targetCandidateMatches(lines: string[], find: string, start: number, end: number): boolean {
  const match = matchTarget(lines.slice(start - 1, end), splitBlock(stripLinePrefixes(find).text))
  return !!match?.candidates.some(candidate => candidate.start === 1 && candidate.end === end - start + 1)
}

export type TargetResolution =
  | { kind: 'unique'; start: number; end: number; replacement: string[]; indentShifted: boolean }
  | { kind: 'ambiguous'; candidates: StepCandidate[] }
  | { kind: 'missing'; suggestions: StepSuggestion[] }

/**
 * Resolve one target step against current content — shared by the planner
 * and by ffresolve's pinned-candidate verification.
 */
export function resolveTarget(lines: string[], find: string, replaceWith: string): TargetResolution {
  const { text: findText } = stripLinePrefixes(find)
  const findLines = splitBlock(findText)
  const match = matchTarget(lines, findLines)
  if (!match || match.candidates.length === 0) {
    return { kind: 'missing', suggestions: suggestionsFor(lines, findLines[0] ?? '', []) }
  }
  if (match.candidates.length > 1) return { kind: 'ambiguous', candidates: match.candidates }
  const { text: replaceText } = stripLinePrefixes(replaceWith)
  let replacement = splitBlock(replaceText)
  let indentShifted = false
  if (match.indentDelta !== 0 && replacement.length > 0) {
    replacement = shiftIndent(replacement, match.indentDelta, match.indentSample)
    indentShifted = true
  }
  return {
    kind: 'unique',
    start: match.candidates[0].start,
    end: match.candidates[0].end,
    replacement,
    indentShifted,
  }
}

function planStep(lines: string[], step: EditStep, index: number, options: EditOptions): Planned {
  const window = options.expectWindow ?? 20
  const op = inferOp(step)
  const report: StepReport = { index, op: op ?? 'replace', status: 'failed' }
  if (!op) {
    report.reason = 'cannot infer op — provide op, or find (target), after (insert), or start (replace/delete)'
    return { kind: 'failed', report }
  }
  report.op = op

  if ((op === 'replace' || op === 'insert') && typeof step.text !== 'string'
    || op === 'target' && (typeof step.find !== 'string' || typeof step.replaceWith !== 'string')) {
    report.reason = `${op} requires explicit ${op === 'target' ? 'find and replaceWith' : 'text'}; use an empty string or op=delete to remove content`
    return { kind: 'failed', report }
  }

  if (op === 'insert') {
    let after = step.after
    if (typeof after !== 'number' || !Number.isInteger(after)) {
      report.reason = 'insert requires integer `after` (0 = top of file)'
      return { kind: 'failed', report }
    }
    if (step.expect !== undefined) {
      const drift = reanchor(lines, after, step.expect, window)
      if (drift === null) {
        report.reason = `expect anchor not found within ±${window} of line ${after}: "${step.expect.slice(0, 120)}"`
        return { kind: 'failed', report }
      }
      after += drift
      report.drift = drift
      report.status = 'applied'
    }
    if (after < 0 || after > lines.length) {
      report.reason = `insert boundary ${after} outside file (0-${lines.length})`
      return { kind: 'failed', report }
    }
    report.status = 'applied'
    const { text, stripped } = stripLinePrefixes(step.text ?? '')
    const insertLines = splitBlock(text)
    if (stripped) report.reason = `stripped ${'N | '} prefixes from ${insertLines.length} inserted lines`
    return {
      kind: 'insert',
      op: {
        stepIndex: index,
        boundary: after,
        lines: insertLines,
        report,
      },
    }
  }

  if (op === 'target') {
    const findRaw = step.find ?? ''
    const pins = options.pinnedTargets?.filter(pin => pin.stepIndex === index) ?? []
    if (pins.length > 1) {
      const ops: PlannedRange[] = []
      for (const pin of pins) {
        const planned = planStep(lines, step, index, { ...options, pinnedTargets: [pin] })
        if (planned.kind !== 'range') return planned
        ops.push(planned.op)
      }
      return { kind: 'ranges', ops }
    }
    const pin = options.pinnedTargets?.find(p => p.stepIndex === index)
      ?? (options.pinnedTarget?.stepIndex === index ? options.pinnedTarget : null)
    if (pin) {
      const findLines = splitBlock(stripLinePrefixes(findRaw).text)
      const span = pin.end - pin.start + 1
      const stillMatches = targetCandidateMatches(lines, findRaw, pin.start, pin.end)
      if (!stillMatches) {
        report.reason = `pinned candidate (lines ${pin.start}-${pin.end}) no longer matches current content`
        return { kind: 'failed', report }
      }
      const { text: replaceText } = stripLinePrefixes(step.replaceWith ?? '')
      let replacement = splitBlock(replaceText)
      let indentShifted = false
      if (replacement.length > 0) {
        const actual = leadingWhitespace(lines[pin.start - 1])
        const wanted = leadingWhitespace(findLines[0])
        const delta = actual.length - wanted.length
        if (delta !== 0) {
          replacement = shiftIndent(replacement, delta, actual)
          indentShifted = true
        }
      }
      report.status = 'applied'
      if (indentShifted) report.indentShifted = true
      return {
        kind: 'range',
        op: { stepIndex: index, start: pin.start, end: pin.end, lines: replacement, report },
      }
    }
    const resolution = resolveTarget(lines, findRaw, step.replaceWith ?? '')
    if (resolution.kind === 'missing') {
      report.reason = `target block not found (exact or trim-tolerant): "${(splitBlock(findRaw)[0] ?? '').trim().slice(0, 120)}"`
      report.suggestions = resolution.suggestions
      return { kind: 'failed', report }
    }
    if (resolution.kind === 'ambiguous') {
      report.reason = `target block matches ${resolution.candidates.length} locations`
      return { kind: 'ambiguous', stepIndex: index, candidates: resolution.candidates, report }
    }
    report.status = 'applied'
    if (resolution.indentShifted) report.indentShifted = true
    return {
      kind: 'range',
      op: {
        stepIndex: index,
        start: resolution.start,
        end: resolution.end,
        lines: resolution.replacement,
        report,
      },
    }
  }

  // replace / delete — numbered ranges with optional expect drift correction
  let start = step.start
  if (typeof start !== 'number' || !Number.isInteger(start)) {
    report.reason = `${op} requires integer \`start\``
    return { kind: 'failed', report }
  }
  let end = step.end ?? start
  if (typeof end !== 'number' || !Number.isInteger(end) || end < start) {
    report.reason = `\`end\` must be an integer ≥ start`
    return { kind: 'failed', report }
  }
  if (step.expect !== undefined) {
    const drift = reanchor(lines, start, step.expect, window)
    if (drift === null) {
      report.reason = `expect anchor not found within ±${window} of line ${start}: "${step.expect.slice(0, 120)}"`
      return { kind: 'failed', report }
    }
    if (drift !== 0) {
      start += drift
      end += drift
      report.drift = drift
      report.status = 'drifted'
    } else {
      report.status = 'applied'
    }
  } else {
    report.status = 'applied'
  }
  if (start < 1 || end > lines.length) {
    report.reason = `range ${start}-${end} outside file (1-${lines.length})`
    return { kind: 'failed', report }
  }

  let replacement: string[] = []
  if (op === 'replace') {
    const { text, stripped } = stripLinePrefixes(step.text ?? '')
    replacement = splitBlock(text)
    // First/last anchoring: the replacement quotes the range's own boundary
    // lines — keep the boundaries, replace only the interior (the classic
    // LLM over-quotation must not duplicate the anchor lines).
    if (
      replacement.length >= 2 &&
      replacement[0].trim() === lines[start - 1].trim() &&
      replacement[replacement.length - 1].trim() === lines[end - 1].trim()
    ) {
      const interior = replacement.slice(1, -1)
      report.anchorsPreserved = true
      if (end - start <= 1) {
        // No interior lines to replace: splice the interior between/after the
        // anchored boundary lines.
        return {
          kind: 'insert',
          op: { stepIndex: index, boundary: start, lines: interior, report },
        }
      }
      start += 1
      end -= 1
      replacement = interior
    }
    if (stripped && !report.reason) report.reason = `stripped ${'N | '} prefixes`
  }
  return {
    kind: 'range',
    op: { stepIndex: index, start, end, lines: replacement, report },
  }
}

// ---------------------------------------------------------------------------
// Overlap validation + assembly
// ---------------------------------------------------------------------------

function applyLineSteps(originalText: string, steps: EditStep[], options: EditOptions = {}): EditOutcome {
  // An empty string is ZERO lines (a fresh file), not one empty line — the
  // trailing-'' sentinel only exists for text that actually ends with \n.
  const lines = originalText === '' ? [] : originalText.split('\n')
  const lineCount = lines.length
  const mode = options.mode ?? 'atomic'
  const reports: StepReport[] = []
  const ranges: PlannedRange[] = []
  const inserts = new Map<number, PlannedInsert>()

  for (let i = 0; i < steps.length; i++) {
    const planned = planStep(lines, steps[i], i, options)
    if (planned.kind === 'failed') {
      const report = planned.report
      if (mode === 'atomic') {
        reports.push(report)
        return { ok: false, reason: `step ${i} failed: ${report.reason ?? 'unknown error'}`, reports }
      }
      report.status = 'skipped'
      reports.push(report)
      continue
    }
    if (planned.kind === 'ambiguous') {
      reports.push(planned.report)
      if (mode === 'atomic') {
        return {
          ok: false,
          reason: `step ${i}: ${planned.report.reason} — resolve with ffresolve`,
          reports,
          ambiguity: { stepIndex: planned.stepIndex, candidates: planned.candidates },
        }
      }
      planned.report.status = 'skipped'
      continue
    }
    if (planned.kind === 'ranges') {
      ranges.push(...planned.ops); reports.push(...planned.ops.map(op => op.report)); continue
    }
    if (planned.kind === 'insert') {
      const boundary = planned.op.boundary
      if (inserts.has(boundary)) {
        const report = planned.op.report
        report.reason = `two insert steps target the same boundary (after line ${boundary})`
        if (mode === 'atomic') {
          reports.push(report)
          return { ok: false, reason: `step ${i} failed: ${report.reason}`, reports }
        }
        report.status = 'skipped'
        reports.push(report)
        continue
      }
      inserts.set(boundary, planned.op)
      reports.push(planned.op.report)
      continue
    }
    ranges.push(planned.op)
    reports.push(planned.op.report)
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start <= ranges[i - 1].end) {
      const reason = `steps ${ranges[i - 1].stepIndex} and ${ranges[i].stepIndex} overlap on lines ${ranges[i].start}-${Math.min(ranges[i].end, ranges[i - 1].end)}`
      if (mode === 'atomic') {
        return { ok: false, reason, reports }
      }
      // bestEffort: drop the later overlapping step
      ranges[i].report.status = 'skipped'
      ranges[i].report.reason = reason
      ranges.splice(i, 1)
      i--
    }
  }
  for (const range of ranges) {
    for (const boundary of inserts.keys()) {
      if (boundary >= range.start && boundary < range.end) {
        const reason = `insert after line ${boundary} (step ${inserts.get(boundary)!.stepIndex}) lands inside step ${range.stepIndex}'s range ${range.start}-${range.end}`
        if (mode === 'atomic') {
          return { ok: false, reason, reports }
        }
        const insert = inserts.get(boundary)!
        inserts.delete(boundary)
        insert.report.status = 'skipped'
        insert.report.reason = reason
      }
    }
  }

  // One ascending pass over the original lines; inserts at boundary B are
  // emitted right before original line B+1 (boundary lineCount = EOF).
  const out: string[] = []
  const rangeByStart = new Map<number, PlannedRange>(ranges.map((r) => [r.start, r]))
  const pushAll = (texts: string[]): void => {
    out.push(...texts)
  }
  for (let i = 1; i <= lineCount; i++) {
    const beforeBoundary = i - 1
    const insert = inserts.get(beforeBoundary)
    if (insert) {
      insert.report.newRange = { start: out.length + 1, end: out.length + insert.lines.length }
      insert.report.status = insert.report.status === 'skipped' ? 'skipped' : 'applied'
      pushAll(insert.lines)
    }
    const range = rangeByStart.get(i)
    if (range) {
      range.report.originalRange = { start: range.start, end: range.end }
      range.report.newRange = { start: out.length + 1, end: out.length + range.lines.length }
      pushAll(range.lines)
      i = range.end
      continue
    }
    out.push(lines[i - 1])
  }
  const tail = inserts.get(lineCount)
  if (tail) {
    tail.report.newRange = { start: out.length + 1, end: out.length + tail.lines.length }
    tail.report.status = tail.report.status === 'skipped' ? 'skipped' : 'applied'
    pushAll(tail.lines)
  }

  return { ok: true, text: out.join('\n'), reports }
}

/** Character targets share the same original snapshot and overlap contract. */
export function applyEditSteps(originalText: string, steps: EditStep[], options: EditOptions = {}): EditOutcome {
  steps = steps.map(step => step.inline || !step.find || step.find.includes('\n') || typeof step.replaceWith !== 'string' ? step
    : resolveTarget(originalText.split('\n'), step.find, step.replaceWith).kind === 'missing' && originalText.includes(step.find) ? { ...step, inline: true } : step)
  if (!steps.some(step => step.inline)) return applyLineSteps(originalText, steps, options)
  if (options.mode === 'bestEffort') return { ok: false, reason: 'inline targets currently require atomic mode; bestEffort supports whole-line steps only', reports: [] }
  const lineSteps = steps.map(step => step.inline ? undefined : step)
  const plans: Array<{ start: number; end: number; text: string; report: StepReport }> = []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    if (!step.inline) continue
    const report: StepReport = { index, op: 'target', status: 'failed' }
    if (!step.find || typeof step.replaceWith !== 'string' || step.find.includes('\n')) return { ok: false, reason: 'inline target requires nonempty single-line find and explicit replaceWith', reports: [report] }
    const candidates: StepCandidate[] = []
    let cursor = 0
    while (cursor <= originalText.length - step.find.length) {
      const start = originalText.indexOf(step.find, cursor)
      if (start < 0) break
      if (candidates.length >= 100) return { ok: false, reason: 'inline target exceeds 100 candidates; use a narrower anchor', reports: [report] }
      const end = start + step.find.length, line = originalText.slice(0, start).split('\n').length
      candidates.push({ start: line, end: line, startOffset: start, endOffset: end }); cursor = start + 1
    }
    const pins = options.pinnedTargets?.filter(pin => pin.stepIndex === index) ?? []
    const selected = pins.length ? candidates.filter(candidate => pins.some(pin => candidate.startOffset === pin.startOffset && candidate.endOffset === pin.endOffset)) : candidates
    if (selected.length === 0 || (pins.length ? selected.length !== pins.length : selected.length !== 1)) {
      if (selected.length > 1) return { ok: false, reason: `inline target matches ${selected.length} locations`, reports: [report], ambiguity: { stepIndex: index, candidates: selected } }
      return { ok: false, reason: 'inline target not found at the original coordinates', reports: [report] }
    }
    for (const candidate of selected) {
      plans.push({ start: candidate.startOffset!, end: candidate.endOffset!, text: step.replaceWith, report: { ...report, status: 'applied', originalRange: candidate } })
    }
  }
  // Compile line steps independently against the same original snapshot;
  // character targets may coexist only with disjoint original line spans.
  for (let index = 0; index < lineSteps.length; index++) {
    const step = lineSteps[index]
    if (!step) continue
    const outcome = applyLineSteps(originalText, [step], { ...options, pinnedTargets: options.pinnedTargets?.filter(pin => pin.stepIndex === index).map(pin => ({ ...pin, stepIndex: 0 })) })
    if (!outcome.ok) return { ...outcome, reports: outcome.reports.map(report => ({ ...report, index })),
      ...(outcome.ambiguity ? { ambiguity: { ...outcome.ambiguity, stepIndex: index } } : {}) }
    const report = { ...outcome.reports[0], index }
    // A longest common prefix/suffix identifies the actual changed character span.
    let prefix = 0, suffix = 0
    while (prefix < Math.min(originalText.length, outcome.text.length) && originalText[prefix] === outcome.text[prefix]) prefix++
    while (suffix < Math.min(originalText.length, outcome.text.length) - prefix && originalText[originalText.length - suffix - 1] === outcome.text[outcome.text.length - suffix - 1]) suffix++
    plans.push({ start: prefix, end: originalText.length - suffix, text: outcome.text.slice(prefix, outcome.text.length - suffix), report })
  }
  plans.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < plans.length; index++) {
    const previous = plans[index - 1], current = plans[index]
    if (current.start < previous.end || current.start === previous.start) return { ok: false, reason: 'original character edit spans overlap', reports: plans.map(plan => plan.report) }
  }
  let text = '', cursor = 0
  for (const plan of plans) { text += originalText.slice(cursor, plan.start) + plan.text; cursor = plan.end }
  text += originalText.slice(cursor)
  return { ok: true, text, reports: plans.map(plan => plan.report).sort((a, b) => a.index - b.index) }
}
