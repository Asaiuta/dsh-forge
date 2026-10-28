/**
 * Post-edit audit: what did this batch leave behind?
 *
 * A rename that lands in one file and misses its call sites is the failure mode
 * the ledger cannot catch. `revertOnSyntaxError` proves the file still parses —
 * it says nothing about the twelve renderer call sites that now reference a
 * member that no longer exists. Recovering that answer was previously the
 * caller's job: grep the identifier, read the hits, decide. Measured on a real
 * rename, that cost two extra rounds and ~58k context.
 *
 * This module answers the part of it the graph already knows, from data
 * assembled for `fftrace`: which exposed members this batch dropped or renamed,
 * and where the surviving call sites are.
 *
 * Three design rules, each one a measured failure avoided:
 *
 *   1. **Never build a graph.** `peekTraceGraph` returns the cached assembly or
 *      nothing. A cold audit is skipped, never paid for at edit time.
 *   2. **Never fail an edit.** Every failure path still returns a structured
 *      result; the write already happened and the audit is advice.
 *   3. **Never report silence as success.** The result always carries a status
 *      and a reason, so "no cached graph", "nothing to check", "stale" and
 *      "checked, nothing found" cannot collapse into one another. Only found
 *      findings need prose; the no-findings branches get one short line.
 *
 * This is still a *heuristic* channel: it asks whether a removed identifier
 * still appears in other files. That is why a completed run is `partial`
 * (`legacy_heuristic`), never `passed` — M1.2's AST diff is what may later earn
 * a stronger status.
 *
 * @module dsh-forge/edit-audit
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { scriptFacts } from './facts.ts'
import { peekTraceGraph } from './tools-trace.ts'
import { TRACE_SCAN_EXTENSIONS } from './trace-capabilities.ts'
import path from 'node:path'
import type { TraceGraph } from './linkgraph.ts'
import type { EditStep } from './edit-engine.ts'

/** Result status, shared vocabulary with the C2 check contract. The audit has
 *  no `passed`: a text heuristic cannot prove the absence of a broken call. */
export type AuditStatus = 'partial' | 'not_run' | 'stale'

/** Why the audit ended where it did. Values follow docs/forge-plan-m0-m1.md
 *  M0.2; `detail` carries the specific sub-case a reader needs. */
export type AuditReason = 'legacy_heuristic' | 'no_baseline' | 'not_applicable' | 'audit_error' | 'stale'

export interface AuditCoverage {
  /** Files whose post-write content this audit was asked about. */
  requested: string[]
  /** Files actually read for the check. */
  analyzed: number
  /** Did the scan that produced the baseline traverse the workspace completely? */
  traversalComplete: boolean
  /** Were all references returned, or only a bounded sample? */
  resultComplete: boolean
  limitations: Array<{ reason: string; file?: string; count?: number }>
}

/** Which graph answered, and how much of the workspace went into it. Without
 *  this a run cannot be recognized later as pre-write evidence. */
export interface AuditBaseline {
  source: 'cached-graph' | 'none'
  /** The cached assembly predates this batch; M0.4 gives it a real snapshotId. */
  snapshot?: 'pre-write'
  /** The graph that answered, resolvable through fftrace's snapshot lookup while
   *  it is still held. Absent when no graph was consulted. */
  snapshotId?: string
  strength?: 'observed' | 'content-bound'
  scanned: number
  truncated: boolean
}
/** One exposed member this batch stopped providing, with its surviving callers. */
export interface AuditRow {
  /** The global as consumers name it (`chartAPI`). */
  object: string
  /** The member this batch dropped or renamed. */
  member: string
  /** Call sites still referencing it. */
  sites: number
  /** Distinct files those sites live in. */
  files: number
  /** Up to three `path:line` examples, sorted. */
  sample: string[]
}

export interface EditAudit {
  status: AuditStatus
  reason: AuditReason
  /** The concrete sub-case behind `reason`; required whenever `status !== 'partial'`. */
  detail?: string
  coverage: AuditCoverage
  baseline: AuditBaseline
  rows: AuditRow[]
  /** Whole globals this batch removed (renamed the `exposeInMainWorld` name). */
  globals: Array<{ object: string; sites: number; files: number; sample: string[] }>
  /** One sentence a reader can act on. */
  verdict: string
}

/** Identifiers that appear in `after` but not in `before`… reversed here: the
 *  ones the batch stopped mentioning are what can strand a call site. */
function removedIdentifiers(before: string, after: string): Set<string> {
  const names = (text: string): Set<string> => new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])
  const kept = names(after)
  const gone = new Set<string>()
  for (const name of names(before)) if (!kept.has(name)) gone.add(name)
  return gone
}

/** Whole-word mention, so `pinToggle` never counts as `togglePin`. */
function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)
}

/**
 * The members the shipped text still provides, or `undefined` when that cannot
 * be decided from text alone.
 *
 * The snapshot's key list is pre-edit, so it cannot answer this. Re-parsing the
 * file would (the AST extractor is right there), but that costs a WASM parse on
 * every edit that might have audit value — and this function is on the write
 * path. Instead: a member counts as present when the shipped text still names
 * it as a key of some object literal. That is exactly the question being asked
 * ("will a consumer's `.member` resolve"), and it degrades to `undefined` only
 * when the file stopped looking like an object literal at all, where the batch's
 * own removal evidence is the better signal anyway.
 *
 * @returns the surviving member names, or `undefined` for "cannot tell".
 */
function liveMembers(shipped: string, candidates: readonly string[]): Set<string> | undefined {
  // A bridge rebuilt via a computed name or a spread is beyond textual reading;
  // say so instead of guessing.
  if (/\{\s*\.\.\./.test(shipped)) return undefined
  const live = new Set<string>()
  for (const name of candidates) {
    // Key position: `name:` at the start of an object-literal line, or the
    // shorthand form where the key and the function share one name.
    const key = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[\\s,{])${key}\\s*[:,}]`, 'm').test(shipped)) live.add(name)
  }
  return live
}

/** Where the members of `object` are referenced from, per member name. */
function memberSites(graph: TraceGraph, object: string): Map<string, string[]> {
  const byMember = new Map<string, string[]>()
  for (const ref of graph.bridgeByObject.get(object) ?? []) {
    const site = `${ref.path}:${ref.line}`
    const bucket = byMember.get(ref.name)
    if (bucket) bucket.push(site)
    else byMember.set(ref.name, [site])
  }
  return byMember
}

function summarize(sites: readonly string[]): { sites: number; files: number; sample: string[] } {
  const unique = [...new Set(sites)].sort()
  return {
    sites: unique.length,
    files: new Set(unique.map((site) => site.slice(0, site.lastIndexOf(':')))).size,
    sample: unique.slice(0, 3),
  }
}

/** Statuses are decided in one place so no branch can invent its own. */
function outcome(status: AuditStatus, reason: AuditReason, extra: Partial<EditAudit> & { detail?: string } = {}): EditAudit {
  return {
    status,
    reason,
    coverage: { requested: [], analyzed: 0, traversalComplete: false, resultComplete: true, limitations: [] },
    baseline: { source: 'none', scanned: 0, truncated: false },
    rows: [],
    globals: [],
    verdict: '',
    ...extra,
  }
}

/** A commit whose audit rules do not exist yet still owes the caller a state.
 *  Used by `ff_file` for operations no bridge check applies to. */
export function notApplicableAudit(requested: readonly string[], detail: string): EditAudit {
  return outcome('not_run', 'not_applicable', {
    detail,
    coverage: { requested: [...requested], analyzed: 0, traversalComplete: false, resultComplete: true, limitations: [{ reason: 'operation_not_audited' }] },
  })
}

/** Status precedence when several changed files answer: a real check outranks
 *  "nothing to check", and staleness outranks an incomplete run. */
const AUDIT_RANK: Record<AuditStatus, number> = { partial: 0, stale: 1, not_run: 2 }

/**
 * The single post-commit audit entry every construction tool calls.
 *
 * The plan requires one exit rather than one per tool: an identical byte change
 * must produce an identical audit sentence whether it arrived through ffedit,
 * a ticket reply, or ff_file. Callers run this *after* releasing the write
 * locks — a slow graph read must never hold construction back — which is safe
 * because the post-write hash is carried in and re-checked here.
 */
export function auditCommit(input: {
  /** Workspace root the batch ran in. */
  workspace: string
  /** Ledger batch id, for callers that want to correlate advice with history. */
  batchId: number
  /** State the operation kind so unattended operations can say why they are silent. */
  kind: 'edit' | 'ticket' | 'file'
  /** Changed files as `{rel, abs}`; `rel` uses the graph's `/` keys. */
  changed: ReadonlyArray<{ rel: string; abs: string }>
  /** Edit steps, for `edit`/`ticket` only. */
  steps?: readonly EditStep[]
  /** Post-write content prefix (the ledger's 12-hex hash). */
  hash?: string
  syntaxWarning?: boolean
  /** ff_file action, for the not-applicable message. */
  operation?: string
}): EditAudit {
  if (input.changed.length === 0) {
    return notApplicableAudit([], 'the batch changed no file, so there is nothing to recheck')
  }
  if (input.kind === 'file') {
    // File-level operations change file identity, not bridge membership. Until
    // M3 attaches a reference plan, saying "not checked" is the honest answer —
    // and it must be said here rather than by omitting this entry point.
    return notApplicableAudit(input.changed.map(item => item.rel),
      `${input.operation ?? 'file'} changes files without a bridge-surface rule; no consumer recheck was run for this operation`)
  }
  const steps = input.steps ?? []
  const audits = input.changed.map(item => auditEdit(input.workspace, item.rel, steps, item.abs, { hash: input.hash, syntaxWarning: input.syntaxWarning }))
  const audit = audits.reduce((worst, next) => (AUDIT_RANK[next.status] < AUDIT_RANK[worst.status] ? next : worst))
  if (audits.length === 1) return audit
  // Multi-file edits merge: state, rows and coverage union, prose concatenated.
  return {
    ...audit,
    coverage: {
      ...audit.coverage,
      requested: audits.flatMap(item => item.coverage.requested),
      analyzed: audits.reduce((sum, item) => sum + item.coverage.analyzed, 0),
      limitations: audits.flatMap(item => item.coverage.limitations),
    },
    rows: audits.flatMap(item => item.rows),
    globals: audits.flatMap(item => item.globals),
    verdict: audits.map(item => item.verdict).filter(Boolean).join(' '),
    ...(audit.detail ? { detail: audits.map(item => item.detail).filter(Boolean).join('; ') } : {}),
  }
}

/**
 * Compare what this batch removed against what the graph says is still called.
 *
 * @param workdir - workspace root the batch ran in.
 * @param rel - the edited file, workspace-relative (the graph's key).
 * @param steps - the batch as requested; `find` vs `replaceWith` is what says
 *   which names stopped being mentioned.
 * @param abs - absolute path of the edited file, read once for the new text.
 * @param expect - optional post-write identity; when the file no longer matches
 *   it, a later writer owns those bytes and this audit must not attribute them.
 * @returns a result for every branch; `status`/`reason` say whether anything
 *   was actually checked. Callers must not treat `not_run` as a clean bill.
 */
export function auditEdit(workdir: string, rel: string, steps: readonly EditStep[], abs: string, expect?: { hash?: string; syntaxWarning?: boolean }): EditAudit {
  // Flipped once analysis begins, so an exception can still say whether any
  // work was done (`partial`) or none was (`not_run`).
  let started = false
  try {
    const assembled = peekTraceGraph(workdir)
    if (!assembled) {
      return outcome('not_run', 'no_baseline', { detail: 'no cached Trace graph for this workspace; no consumer recheck was run' })
    }
    const baseline: AuditBaseline = {
      source: 'cached-graph',
      snapshot: 'pre-write',
      snapshotId: assembled.snapshot.snapshotId,
      strength: assembled.snapshot.strength,
      scanned: assembled.scanned,
      truncated: assembled.truncated,
    }
    const graph = assembled.graph
    const request = [rel]
    const coverage = (analyzed: number): AuditCoverage => ({
      requested: request,
      analyzed,
      traversalComplete: !assembled.truncated && assembled.walkErrors === 0,
      resultComplete: true,
      limitations: [
        ...(assembled.truncated ? [{ reason: 'scan_truncated' }] : []),
        ...(assembled.walkErrors > 0 ? [{ reason: 'walk_errors', count: assembled.walkErrors }] : []),
        ...(assembled.partialFiles > 0 ? [{ reason: 'partial_parse', count: assembled.partialFiles }] : []),
        ...(expect?.syntaxWarning ? [{ reason: 'shipped_text_syntax_warning' }] : []),
        { reason: 'name_match_heuristic' },
      ],
    })
    const ext = path.extname(rel).toLowerCase()
    if (!TRACE_SCAN_EXTENSIONS.has(ext)) {
      return outcome('not_run', 'not_applicable', {
        detail: `${ext || 'no extension'} is outside the Trace scan set; this file contributes no bridge surface to compare`,
        baseline,
        coverage: coverage(0),
      })
    }
    const entry = graph.files.get(rel)
    if (!entry) {
      return outcome('not_run', 'no_baseline', {
        detail: 'the cached graph does not contain this file (new, ignored, or unparsed); nothing to compare against',
        baseline,
        coverage: coverage(0),
      })
    }

    // The cached graph was assembled BEFORE this write, so its own facts for
    // this file are the pre-edit ones. Re-reading the shipped text is not
    // belt-and-braces: trusting the stale keys made a rename-back look like a
    // no-op (the old key was still "present", so nothing looked removed).
    // What the graph is still good for is the other side — which files call
    // into these globals — because this batch changed the callee, not them.
    started = true
    let shipped: string
    try {
      shipped = readFileSync(abs, 'utf8')
    } catch {
      return outcome('not_run', 'not_applicable', {
        detail: 'the edited file no longer exists after commit; deletion is not audited by this text heuristic',
        baseline,
        coverage: coverage(1),
      })
    }
    if (expect?.hash) {
      // The batch reports a 12-hex content prefix, so identity is a prefix test
      // of the same digest — still byte-derived, never a path/mtime guess.
      const actual = createHash('sha256').update(readFileSync(abs)).digest('hex')
      const unchanged = expect.hash === actual || (expect.hash !== '' && actual.startsWith(expect.hash))
      if (!unchanged) {
        return outcome('stale', 'stale', {
          detail: 'the file changed again after this batch committed; findings would be attributed to someone else\'s bytes',
          baseline,
          coverage: coverage(1),
        })
      }
    }

    // What the batch stopped naming. A delete step's `find` is all removal.
    const gone = new Set<string>()
    for (const step of steps) {
      const before = step.find ?? ''
      const after = step.replaceWith ?? ''
      for (const name of removedIdentifiers(before, after)) gone.add(name)
    }
    if (gone.size === 0) {
      return outcome('not_run', 'not_applicable', {
        detail: 'the batch removed no identifier, so no call site can have been stranded',
        baseline,
        coverage: coverage(1),
      })
    }

    const exposes = scriptFacts(entry)?.exposes ?? []
    if (exposes.length === 0) {
      return outcome('not_run', 'not_applicable', {
        detail: 'the cached file facts expose no bridge surface; the bridge audit does not apply',
        baseline,
        coverage: coverage(1),
      })
    }

    const rows: AuditRow[] = []
    const globals: EditAudit['globals'] = []
    /** Every stranded site, for the verdict's distinct-file count. */
    const allSites: string[] = []
    for (const expose of exposes) {
      const sites = memberSites(graph, expose.name)
      // The global itself left the surface: every member breaks at once. This is
      // the half-rename where the preload moved and the consumers did not.
      if (!mentions(shipped, expose.name)) {
        const all = [...sites.values()].flat()
        if (all.length) {
          globals.push({ object: expose.name, ...summarize(all) })
          allSites.push(...all)
        }
        continue
      }
      // The global survived. The question is which of the members its consumers
      // already call no longer exist — asked of the shipped text, never of the
      // snapshot, which predates this write. Iterating the sites (not the
      // batch's removed names) is what makes rename-back and rename-forward
      // symmetrical: both are "a member the callers use is gone".
      for (const [member, at] of sites) {
        if (!mentions(shipped, member)) {
          rows.push({ object: expose.name, member, ...summarize(at) })
          allSites.push(...at)
        }
      }
    }

    // A completed heuristic run is `partial`, findings or not: it cannot prove
    // that a dynamic call is absent, only that no visible name survives.
    const common = { baseline, coverage: coverage(1) }
    if (rows.length === 0 && globals.length === 0) {
      const checked = exposes.flatMap((expose) => [...memberSites(graph, expose.name).keys()]).length
      return outcome('partial', 'legacy_heuristic', {
        ...common,
        verdict: `checked ${checked} consumed member name(s) against the shipped text — no statically visible consumer still references a removed name; dynamic calls and aliases remain unknown`
          + (expect?.syntaxWarning ? '; the batch also left a syntax warning, so this text check is weaker than usual' : ''),
      })
    }

    // Count the real sites, not the printed samples: "9 call sites" that only
    // ever saw three of them would be the kind of number a reader catches.
    const uniqueSites = [...new Set(allSites)]
    const fileCount = new Set(uniqueSites.map((site) => site.slice(0, site.lastIndexOf(':')))).size
    const names = [
      ...globals.map((row) => `\`${row.object}\``),
      ...rows.map((row) => `\`${row.object}.${row.member}\``),
    ]
    // Deliberately not "these calls fail": a name in a comment or an unrelated
    // object looks identical to this heuristic. The consumer list is the claim.
    const verdict = `statically visible consumers still reference ${names.join(', ')}: `
      + `${uniqueSites.length} site(s) across ${fileCount} file(s) — recheck them and update the callers, `
      + 'or restore the name; this is a text match, not a resolved reference'

    return outcome('partial', 'legacy_heuristic', { ...common, rows, globals, verdict })
  } catch (cause) {
    // Advice must never cost a write, and must never hide its own failure.
    return outcome(started ? 'partial' : 'not_run', 'audit_error', {
      detail: `audit raised: ${cause instanceof Error ? cause.message : String(cause)}`,
      verdict: '',
    })
  }
}

/** Render one audit for the tool reply. Kept beside the analysis so the two
 *  cannot drift: every field a line prints is one the audit computed. */
export function renderAudit(audit: EditAudit): string[] {
  const state = audit.status === 'not_run' ? 'not run' : audit.status
  const head = `[audit] ${state} (${audit.reason})`
  if (audit.verdict) {
    const lines = [`${head}: ${audit.verdict}`]
    for (const row of audit.globals) {
      lines.push(`  ${row.object} · ${row.sites} site(s) in ${row.files} file(s): ${row.sample.map((s) => `\`${s}\``).join(', ')}`)
    }
    for (const row of audit.rows) {
      lines.push(`  ${row.object}.${row.member} · ${row.sites} site(s) in ${row.files} file(s): ${row.sample.map((s) => `\`${s}\``).join(', ')}`)
    }
    return lines
  }
  return [`${head}${audit.detail ? `: ${audit.detail}` : ''}`]
}
