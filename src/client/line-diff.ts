import { lineOperations } from '../line-ops.ts'

/**
 * Line alignment for the Git detail view.
 *
 * The detail view used to show two columns of raw text: technically complete,
 * unreadable in practice, because nothing said which line met which. This module
 * produces the aligned rows every diff viewer shows — old/new gutters, one-for-one
 * rewrites paired as `mod` with the exact changed span inside the line, and long
 * unchanged runs foldable into a counted gap.
 *
 * Pure and budgeted. A comparison too large for the work budget is reported as
 * `coarse` with every line still listed, never silently approximated: a diff that
 * quietly guesses is worse than one that admits it could not align.
 *
 * @module dsh-forge/client/line-diff
 */

/** How one row relates to the two sides. */
export type DiffKind = 'same' | 'add' | 'del' | 'mod'

/** One aligned row. */
export interface DiffRow {
  kind: DiffKind
  /** 1-based line number on the old side; null for an addition. */
  oldNo: number | null
  /** 1-based line number on the new side; null for a deletion. */
  newNo: number | null
  /** The line's text: the new text for `same`/`add`/`mod`, the old text for `del`. */
  text: string
  /** `[start, end)` of the changed span inside {@link text}, for `mod` rows. */
  change?: [number, number]
}

/** A folded run of unchanged lines. */
export interface DiffGap {
  kind: 'gap'
  count: number
}

export type DiffLine = DiffRow | DiffGap

export interface DiffResult {
  rows: DiffRow[]
  /** True when the budget was exceeded: rows are a whole-file replacement, not an alignment. */
  coarse: boolean
}

/** Cells the LCS table may occupy before the comparison degrades. */
const DEFAULT_MAX_CELLS = 250_000

/**
 * Split text into lines the way editors count them: CRLF and CR normalise to LF,
 * and a single trailing newline does not invent an empty final line.
 */
function linesOf(text: string): string[] {
  if (!text) return []
  const normalised = text.replace(/\r\n?/g, '\n')
  const parts = normalised.split('\n')
  if (parts.at(-1) === '') parts.pop()
  return parts
}

/** The common prefix and suffix length of two strings, without overlap. */
function sharedEdges(before: string, after: string): { prefix: number; suffix: number } {
  const limit = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1
  return { prefix, suffix }
}

/**
 * Align two texts into rows.
 *
 * @param before - the old text (index side).
 * @param after - the new text (worktree side).
 * @param options - `maxCells` bounds the LCS table.
 * @returns the aligned rows, plus `coarse` when the budget forced a whole-file
 *   replacement.
 */
export function diffLines(before: string, after: string, options: { maxCells?: number } = {}): DiffResult {
  const a = linesOf(before), b = linesOf(after)
  const { ops, coarse } = lineOperations(a, b, options.maxCells)
  const rows: DiffRow[] = []
  let index = 0
  while (index < ops.length) {
    const op = ops[index]!
    if (op.op === 'same') {
      rows.push({ kind: 'same', oldNo: op.a + 1, newNo: op.b + 1, text: a[op.a]! }); index++; continue
    }
    const dels: number[] = [], adds: number[] = []
    while (index < ops.length && ops[index]!.op === 'del') { dels.push((ops[index] as { a: number }).a); index++ }
    while (index < ops.length && ops[index]!.op === 'add') { adds.push((ops[index] as { b: number }).b); index++ }
    const paired = coarse ? 0 : Math.min(dels.length, adds.length)
    for (let k = 0; k < paired; k++) {
      const oldText = a[dels[k]!]!, newText = b[adds[k]!]!
      const { prefix, suffix } = sharedEdges(oldText, newText)
      const row: DiffRow = { kind: 'mod', oldNo: dels[k]! + 1, newNo: adds[k]! + 1, text: newText }
      if (newText.length - prefix - suffix > 0) row.change = [prefix, newText.length - suffix]
      rows.push(row)
    }
    for (let k = paired; k < dels.length; k++) rows.push({ kind: 'del', oldNo: dels[k]! + 1, newNo: null, text: a[dels[k]!]! })
    for (let k = paired; k < adds.length; k++) rows.push({ kind: 'add', oldNo: null, newNo: adds[k]! + 1, text: b[adds[k]!]! })
  }
  return { rows, coarse }
}

/**
 * Collapse runs of unchanged rows longer than `minRun` into counted gaps.
 *
 * A gap keeps the whole file's reading order intact: its `count` equals the rows
 * it hides, so nothing disappears — the renderer can expand it on demand.
 *
 * @param rows - aligned rows from {@link diffLines}.
 * @param minRun - shortest unchanged run worth folding (3 keeps two lines of
 *   context visible around each change).
 */
export function foldContext(rows: readonly DiffRow[], minRun = 3): DiffLine[] {
  const out: DiffLine[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]!
    if (row.kind !== 'same') { out.push(row); index += 1; continue }
    let end = index
    while (end < rows.length && rows[end]!.kind === 'same') end += 1
    const run = end - index
    // Keep the first and last line of a long run as context, like every editor.
    if (run > minRun) {
      const context = Math.floor(minRun / 2)
      for (let k = 0; k < context; k += 1) out.push(rows[index + k]!)
      out.push({ kind: 'gap', count: run - context * 2 })
      for (let k = run - context; k < run; k += 1) out.push(rows[index + k]!)
    } else for (let k = index; k < end; k += 1) out.push(rows[k]!)
    index = end
  }
  return out
}
