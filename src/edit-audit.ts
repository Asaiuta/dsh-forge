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
import { peekTraceGraph } from './tools-trace.ts'
import { extractTraceFileFromBytes, selectBridgeFacts } from './trace-facts.ts'
import { scriptFacts } from './facts.ts'
import { bridgeModel, diffBridges, type CheckResult } from './bridge-check.ts'
import type { TraceFileFacts } from './facts.ts'
import { TRACE_SCAN_EXTENSIONS } from './trace-capabilities.ts'
import path from 'node:path'
import type { TraceGraph } from './linkgraph.ts'
import type { EditStep } from './edit-engine.ts'

/** Result status, shared vocabulary with the C2 check contract. The audit has
 *  no `passed`: a text heuristic cannot prove the absence of a broken call. */
export type AuditStatus = 'partial' | 'not_run' | 'stale'

/** Why the audit ended where it did. Values follow docs/forge-plan-m0-m1.md
 *  M0.2; `detail` carries the specific sub-case a reader needs. */
export type AuditReason = 'ast_diff' | 'legacy_heuristic' | 'no_baseline' | 'not_applicable' | 'audit_error' | 'stale'

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
 * Diff the cached before-facts against a freshly extracted edited file.
 *
 * Only the edited file is re-extracted. That is sound because this batch wrote
 * exactly that file: every other file's facts in the cached graph still describe
 * the bytes that are on disk. Building a full graph here would be the one thing
 * the write path may not do.
 *
 * The before side also keeps its provider globals visible to the after side, so
 * a renamed or removed global does not silently take its consumers with it.
 */
function diffBridgeModels(workdir: string, files: ReadonlyMap<string, TraceFileFacts>, rel: string, after: TraceFileFacts): { result: CheckResult } {
  // Facts arriving from the assembled graph are already filtered to the bridge
  // globals (`selectBridgeFacts`), but a fresh extract is not: it names every
  // member access in the file, `ipcRenderer.invoke` included. Feeding that in
  // unfiltered made the model look like it had consumers of a global nobody
  // provides, which the diff then reported as `unknown_binding` — a limitation
  // invented by the audit's own plumbing. Same filter, same set, both sides.
  const globals = new Set<string>()
  for (const facts of [...files.values(), after]) {
    const own = scriptFacts(facts)
    for (const expose of own?.exposes ?? []) globals.add(expose.name)
    for (const alias of own?.bridgeAliases ?? []) globals.add(alias.name)
  }
  const before = bridgeModel({ workspace: workdir, files })
  const updated = new Map(files)
  updated.set(rel, selectBridgeFacts(after, [...globals]))
  const next = bridgeModel({ workspace: workdir, files: updated })
  return { result: diffBridges({ workspace: workdir, before, after: next, changed: [rel] }) }
}

/**
 * The single post-commit audit entry every construction tool calls.
 *
 * The plan requires one exit rather than one per tool: an identical byte change
 * must produce an identical audit sentence whether it arrived through ffedit,
 * a ticket reply, or ff_file. Callers run this *after* releasing the write
 * locks — a slow graph read must never hold construction back — which is safe
 * because the post-write hash is carried in and re-checked here.
 */
export async function auditCommit(input: {
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
}): Promise<EditAudit> {
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
  const audits = await Promise.all(input.changed.map(item => auditEdit(input.workspace, item.rel, steps, item.abs, { hash: input.hash, syntaxWarning: input.syntaxWarning })))
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
export async function auditEdit(workdir: string, rel: string, steps: readonly EditStep[], abs: string, expect?: { hash?: string; syntaxWarning?: boolean }): Promise<EditAudit> {
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
        // The diff resolves only *statically visible* sites. A dynamic member
        // access or a runtime-built API object stays outside it, so a clean
        // result is evidence, not proof of absence.
        { reason: 'static_references_only' },
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

    // The AST diff (M1.2). The cached graph still describes every *other* file
    // correctly — this batch changed the callee, not its callers — so only the
    // edited file needs re-extracting. That is one parse, not a graph build, and
    // it replaces a text match that could neither prove a finding nor avoid a
    // false one: a name left in a comment used to hide a real miss, and a
    // same-named local object used to invent one.
    const after = await extractTraceFileFromBytes(abs, readFileSync(abs))
    if (!after.value) {
      return outcome('not_run', 'not_applicable', {
        detail: `the edited file could not be re-extracted (${after.diagnostics?.[0]?.reason ?? 'no facts'}); the audit has nothing to compare`,
        baseline,
        coverage: coverage(1),
      })
    }
    const diff = diffBridgeModels(workdir, graph.files, rel, after.value)
    const flagged = diff.result.findings.filter(finding => finding.attribution !== 'existing')
    // Only this batch's own damage is reported. A consumer that was already
    // broken before the write is not a finding about this write.
    // Object → member → sites. Two levels keep the key unambiguous: a member
    // name may contain any character, so packing both into one string would
    // need an escaping rule that is itself a bug waiting to happen.
    const rowSites = new Map<string, Map<string, string[]>>()
    const globalSites = new Map<string, string[]>()
    for (const finding of flagged) {
      const site = `${finding.consumer.file}:${finding.consumer.line}`
      if (finding.kind === 'expose_global_missing') {
        const bucket = globalSites.get(finding.expected.object)
        if (bucket) bucket.push(site)
        else globalSites.set(finding.expected.object, [site])
        continue
      }
      let byMember = rowSites.get(finding.expected.object)
      if (!byMember) { byMember = new Map(); rowSites.set(finding.expected.object, byMember) }
      const bucket = byMember.get(finding.expected.member)
      if (bucket) bucket.push(site)
      else byMember.set(finding.expected.member, [site])
    }
    const settledRows: AuditRow[] = [...rowSites].flatMap(([object, byMember]) =>
      [...byMember].map(([member, sites]) => ({ object, member, ...summarize(sites) })))
    const settledGlobals: EditAudit['globals'] = [...globalSites].map(([object, sites]) => ({ object, ...summarize(sites) }))
    const common = { baseline, coverage: coverage(1) }
    // Nothing to recheck only when the changed file carries no bridge surface on
    // either side: a value change in a file that exposes nothing cannot strand a
    // call, and saying "checked, clean" about it would be a check that did not
    // happen. A file that *does* carry surface and simply broke nothing is
    // reported as a completed diff instead.
    const beforeFacts = scriptFacts(entry)
    const afterFacts = scriptFacts(after.value)
    const surface = (facts: typeof beforeFacts): boolean =>
      facts !== null && (facts.exposes.length > 0 || facts.bridge.length > 0 || facts.ipc.length > 0)
    if (!surface(beforeFacts) && !surface(afterFacts)) {
      return outcome('not_run', 'not_applicable', {
        detail: 'the changed file carries no bridge surface (no expose, member use or IPC endpoint) on either side of the write',
        ...common,
      })
    }
    if (settledRows.length === 0 && settledGlobals.length === 0) {
      // "Nothing found" is only allowed to sound clean when the diff could
      // actually decide. An unbound provider (two files exposing one global, a
      // dynamic name, a consumer the model could not resolve) means the search
      // space had a hole — and a hole is exactly where the miss would be.
      //
      // `no_spans` is different in kind: without spans two calls on one line
      // merge into one site, which blurs *how many* places broke but cannot hide
      // *whether* a member is provided. So it is reported in coverage and left
      // out of this list — downgrading to "undecidable" over a merged count
      // would trade a small inaccuracy for a large one.
      const BLOCKING = new Set(['ambiguous_provider', 'unknown_binding', 'dynamic_member'])
      const blocked = diff.result.limitations.filter(item => BLOCKING.has(item.code))
      const base = `checked ${diff.result.coverage.providers} exposed surface(s) against ${diff.result.coverage.consumers} statically visible consumer site(s)`
      if (blocked.length > 0) {
        const codes = [...new Set(blocked.map(item => item.code))].join(', ')
        return outcome('partial', 'ast_diff', {
          ...common,
          coverage: {
            ...coverage(1),
            resultComplete: false,
            limitations: [...coverage(1).limitations, ...blocked.map(item => ({ reason: item.code, ...(item.file ? { file: item.file } : {}) }))],
          },
          verdict: `${base}, but ${blocked.length} limitation(s) (${codes}) left part of the surface undecidable — `
            + 'no finding was produced, which is not the same as a clean result',
        })
      }
      return outcome('partial', 'ast_diff', {
        ...common,
        verdict: `${base} — no statically visible consumer still references a member this batch removed`
          + (expect?.syntaxWarning ? '; the batch also left a syntax warning' : ''),
      })
    }
    const uniqueSites = [...new Set([...settledRows, ...settledGlobals].flatMap(row => row.sample))]
    const names = [
      ...settledGlobals.map(row => `\`${row.object}\``),
      ...settledRows.map(row => `\`${row.object}.${row.member}\``),
    ]
    const totalSites = [...settledRows, ...settledGlobals].reduce((sum, row) => sum + row.sites, 0)
    const fileCount = new Set([...settledRows, ...settledGlobals].flatMap(row => row.sample.map(site => site.slice(0, site.lastIndexOf(':'))))).size
    // Still not "these calls fail": the diff resolves static references only.
    // What it can now say is which sites exist in the AST, not in a text search.
    const verdict = `statically visible consumers still reference ${names.join(', ')}: `
      + `${totalSites} site(s) across ${fileCount} file(s) — recheck them and update the callers, `
      + 'or restore the name; resolved from the AST, not from a text match'
      + (uniqueSites.length < totalSites ? ` (samples: ${uniqueSites.slice(0, 3).join(', ')})` : '')

    return outcome('partial', 'ast_diff', { ...common, rows: settledRows, globals: settledGlobals, verdict })  } catch (cause) {
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
