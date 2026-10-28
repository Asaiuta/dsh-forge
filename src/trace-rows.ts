/**
 * Structured rows for the queries whose answers can be longer than one reply.
 *
 * Why this is a separate module from `trace-queries.ts`: rendering decides what
 * fits in a reply, and the completeness of the answer must not be a side effect
 * of that decision. Paging a rendered string means re-parsing text that was
 * already truncated (M0.6 forbids exactly that), and a count printed from the
 * truncated text is how "33 consumers, 3 shown" turns into a wrong edit plan.
 *
 * So: rows are computed once from the graph, completely, inside the traversal
 * budgets; the renderer and the pager each consume rows. What pagination
 * cannot fix is stated instead of hidden — `traversalComplete` says whether the
 * graph walk finished, `resultComplete` whether the row computation was
 * bounded, and neither is derivable from a page.
 *
 * Rows carry `file` + `line` + object/member identity rather than a formatted
 * "path:line" string. Range identity (start/end columns) arrives with M1.2's
 * AST-backed bridge diff; until then `line` is the only position evidence the
 * facts hold, and the row says so by simply not pretending to have a range.
 *
 * @module dsh-forge/trace-rows
 */

import { scriptFacts } from './facts.ts'
import type { TraceGraph } from './linkgraph.ts'
import type { EdgeMode } from './trace-evidence.ts'
import { walkImpact, type TraversalCaps } from './trace-analysis.ts'

/** One addressable result row. `file` is workspace-relative with `/`. */
export interface TraceRow {
  file: string
  /** 1-based display line, when the row points at one. */
  line?: number
  /** Exposed global the row belongs to (`chartAPI`). */
  object?: string
  /** Bridge member (key) the row belongs to. */
  member?: string
  /** Referrer distance for traversals. */
  depth?: number
  /** Edge kind / basis, for dependency rows. */
  kind?: string
}

export interface RowSet {
  /** Rows computed inside the traversal budget, in stable order. */
  rows: TraceRow[]
  /** Did the graph walk finish (impact/path), or is this a direct fact scan? */
  traversalComplete: boolean
  /** Was the row computation itself bounded? */
  resultComplete: boolean
  /** Why rows may be missing, when they may be. */
  limitations: Array<{ reason: string; count?: number }>
}

export type RowQuery =
  | { kind: 'exposes'; value: string }
  | { kind: 'impact'; value: string; edgeMode: EdgeMode }
  | { kind: 'file'; value: string; edgeMode: EdgeMode }

/** Stable ordering: file, then line, then member — so a page boundary never
 *  shuffles an unseen row ahead of a seen one. */
function sortRows(rows: TraceRow[]): TraceRow[] {
  return rows.sort((a, b) =>
    a.file.localeCompare(b.file)
    || (a.line ?? 0) - (b.line ?? 0)
    || (a.member ?? '').localeCompare(b.member ?? '')
    || (a.object ?? '').localeCompare(b.object ?? ''))
}

/**
 * Every member-level consumer reference under every matching exposure.
 *
 * One row per (file, line, object, member). A line that touches two members of
 * the same bridge yields two rows — collapsing them would lose which member was
 * used, which is the whole question.
 */
function exposeRows(g: TraceGraph, filter: string): RowSet {
  const lower = filter.trim().toLowerCase()
  const survey = lower === '' || lower === 'all' || lower === '*'
  const rows: TraceRow[] = []
  let exposures = 0
  for (const [rel, entry] of g.files) {
    for (const expose of scriptFacts(entry)?.exposes ?? []) {
      if (!survey) {
        const file = rel.toLowerCase()
        const matches = expose.name.toLowerCase() === lower || file === lower || file.endsWith(`/${lower}`) || file.includes(lower)
        if (!matches) continue
      }
      exposures++
      // Member refs are already alias-resolved by the graph; bare `window.x`
      // uses have no member and are kept as object-level rows.
      const memberRows: TraceRow[] = []
      for (const ref of g.bridgeByObject.get(expose.name) ?? []) {
        memberRows.push({ file: ref.path, line: ref.line, object: expose.name, member: ref.name })
      }
      rows.push(...memberRows)
      // A call the graph recorded both as a member reference and as a bare
      // global use is one site, not two: the member row says strictly more.
      const covered = new Set(memberRows.map(row => `${row.file}\0${row.line}`))
      for (const use of g.guses.get(expose.name) ?? []) {
        if (covered.has(`${use.path}\0${use.line}`)) continue
        rows.push({ file: use.path, line: use.line, object: expose.name })
      }
    }
  }
  const deduped = new Map<string, TraceRow>()
  for (const row of rows) deduped.set(`${row.file}\0${row.line}\0${row.object}\0${row.member ?? ''}`, row)
  return {
    rows: sortRows([...deduped.values()]),
    traversalComplete: true,
    resultComplete: true,
    limitations: [
      { reason: 'static_visible_only' },
      ...(exposures === 0 ? [{ reason: 'no_matching_exposure' }] : []),
    ],
  }
}

/** Referrers of one file, from the traversal itself — not from the renderer's
 *  capped `analysis` arrays, which would make a second page a repeat of the
 *  first hundred rows. */
function impactRows(g: TraceGraph, value: string, edgeMode: EdgeMode, caps?: TraversalCaps): RowSet {
  const walk = walkImpact(g, value, edgeMode, caps)
  if (!walk) return { rows: [], traversalComplete: true, resultComplete: true, limitations: [{ reason: 'target_not_found' }] }
  const rows: TraceRow[] = walk.edges.map(edge => ({
    file: edge.from,
    line: edge.line,
    depth: walk.depths.get(edge.from),
    kind: edge.kind,
  }))
  return {
    rows: sortRows(rows),
    traversalComplete: walk.complete,
    // The row set is whatever the walk produced: nothing is dropped for display
    // any more, so completeness is exactly the traversal's completeness.
    resultComplete: walk.complete,
    limitations: [
      ...(walk.complete ? [] : [{ reason: 'traversal_budget' }]),
      { reason: 'static_file_edges_only' },
    ],
  }
}

/** Direct dependencies of one file, as rows. */
function fileRows(g: TraceGraph, value: string, edgeMode: EdgeMode): RowSet {
  const edges = (g.deps.get(value) ?? []).filter(edge => edgeMode === 'all' || edge.evidence.confidence === 'certain')
  return {
    rows: sortRows(edges.map(edge => ({ file: edge.to, line: edge.line, kind: edge.kind }))),
    traversalComplete: true,
    resultComplete: true,
    limitations: [{ reason: 'direct_dependencies_only' }],
  }
}

/** Compute a row set from one graph. Pure: the pager re-runs this against the
 *  snapshot it stored, which is why a page can never mix two scans.
 *
 *  `caps` exists so a test can prove what an incomplete traversal is allowed to
 *  claim without building a 20 000-file fixture. Production callers omit it. */
export function collectRows(g: TraceGraph, query: RowQuery, caps?: TraversalCaps): RowSet {
  if (query.kind === 'exposes') return exposeRows(g, query.value)
  if (query.kind === 'impact') return impactRows(g, query.value, query.edgeMode, caps)
  return fileRows(g, query.value, query.edgeMode)
}

/** One row as a display line. The pager and the full rendering both use this,
 *  so a row cannot read differently depending on which path showed it. */
export function rowText(row: TraceRow): string {
  const where = row.line === undefined ? `\`${row.file}\`` : `\`${row.file}:${row.line}\``
  const who = row.object ? ` · \`${row.object}${row.member ? `.${row.member}` : ''}\`` : ''
  const depth = row.depth === undefined ? '' : ` · 距离 ${row.depth}`
  const kind = row.kind ? ` · ${row.kind}` : ''
  return `- ${where}${who}${depth}${kind}`
}

/** A stable identity for a row, for de-duplication across pages. */
export function rowKey(row: TraceRow): string {
  return `${row.file}\0${row.line ?? ''}\0${row.object ?? ''}\0${row.member ?? ''}\0${row.kind ?? ''}`
}
