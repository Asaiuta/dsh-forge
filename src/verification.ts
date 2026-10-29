/**
 * Formal verification records: what a check concluded, on which inputs, and
 * whether that conclusion still applies.
 *
 * The distinction this module exists to protect is the one C2 calls out: **a
 * historical execution result and its present applicability are different
 * facts.** A record never changes after it is written — a later failure does not
 * erase an earlier pass, and an earlier pass does not upgrade a later failure.
 * Applicability is computed fresh on every read, because only then can "this
 * passed" be told apart from "this passed, four edits ago".
 *
 * Two consequences shape the storage:
 *
 * - Records are separate files addressed by their own id, never a list inside a
 *   batch node. The ledger is append-only for *code*; a check is evidence
 *   *about* code, so joining it to a batch would either mutate history or lose
 *   records that describe several batches.
 * - Applicability is re-derived from content hashes, never from the card
 *   anchor's size+mtime digest. A same-size edit that restores the mtime is
 *   exactly the case where a stale pass would otherwise be reused, and that is
 *   the failure mode this module must not have.
 *
 * @module dsh-forge/verification
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { withFileLock } from './core.ts'
import { atomicWrite, storeFor, type StorePaths } from './ledger.ts'
import { candidateSetDrift } from './trace-candidates.ts'
import type { HostOutputRef } from './check-host.ts'

/** C2 closed status vocabulary. `stale` is this module's applicability verdict. */
export type CheckStatus = 'passed' | 'failed' | 'partial' | 'not_run' | 'unavailable' | 'stale'

/**
 * What kind of check produced a result.
 *
 * `process` is deliberately separate from `tests`. A process exiting 0 is a fact
 * about a process; it is not a statement that the tests inside it succeeded. The
 * contract's vocabulary has no slot for that distinction because it assumed the
 * TAP interpretation layer would exist; until it does, recording a process run
 * as `tests` would be exactly the false claim the module is built to avoid.
 */
export type CheckKind = 'bridge' | 'syntax' | 'ipc' | 'types' | 'tests' | 'process' | 'external'

/**
 * Where a result came from. `external-report` is a report a user or agent
 * supplied: it is recorded, it is displayed, and it never counts toward the
 * automatic acceptance set — the contract is explicit that a claim is not a
 * check.
 */
export type Provenance = 'internal-static' | 'host-execution' | 'external-report'

/** Earlier records omitted inputs and cannot establish present applicability. */
export const VERIFICATION_SCHEMA = 'forge-verification/2' as const

export interface CheckSourceRef {
  file: string
  line?: number
}

export interface CheckFinding {
  code: string
  message: string
  source?: CheckSourceRef
}

export interface CheckCoverage {
  /** Files the check actually examined. */
  files: number
  /** Sites (findings-capable positions) examined, where the check has that notion. */
  sites?: number
  /** A check that could not see everything says so here. */
  limitation?: string
}

export interface CheckResult {
  id: string
  kind: CheckKind
  status: CheckStatus
  reason?: string
  coverage: CheckCoverage
  findings: CheckFinding[]
  /** Each recipe retains its own host and complete-stream references. */
  execution?: { callId: string; recipeId: string; exitCode: number | null; output: HostOutputRef }
}

/**
 * One immutable record.
 *
 * `afterHashes` is the record's own claim about the inputs: the exact content it
 * saw. Applicability compares those hashes to the tree now, so a record whose
 * input changed is `stale` regardless of the size/mtime of the file.
 */
export interface VerificationRecord {
  /** Optional only so historical records remain readable. */
  schema?: typeof VERIFICATION_SCHEMA
  id: string
  workspaceId: string
  checkPlanId?: string
  batchIds: number[]
  afterHashes: Array<{ file: string; hash: string | null }>
  /** Complete source/config discovery set, present on a formal bridge check. */
  traceFiles?: string[]
  checks: CheckResult[]
  requiredChecks: string[]
  startedAt: string
  finishedAt: string
  provenance: Provenance
  hostCallId?: string
  recipeId?: string
  exitCode?: number
  outputRef?: string
}

/** Aggregate verdict over a record's required checks. */
export interface AggregatedChecks {
  status: CheckStatus
  /** Required checks with no result at all. */
  missing: string[]
  /** Required checks whose result was not a pass, by their own status. */
  notPassed: string[]
  /** Findings that survived regardless of which check reported them. */
  failures: CheckFinding[]
  /** Why the verdict is not `passed`; absent when it is. */
  reason?: string
}

/** Applicability of one record against the tree as it is now. */
export interface RecordApplicability {
  record: VerificationRecord
  /** True only when every recorded input still matches its hash. */
  applicable: boolean
  /** Files whose content no longer matches the record. */
  drifted: string[]
  /** The record's own verdict, unchanged by applicability. */
  verdict: AggregatedChecks
  /** `verdict`, downgraded to `stale` when the inputs moved. */
  effective: CheckStatus
  reason?: 'evidence_schema' | 'input_drift'
}

function dirFor(store: StorePaths): string {
  return path.join(store.dir, 'verification')
}

function revisionFile(store: StorePaths): string {
  return path.join(dirFor(store), 'revision.json')
}

/**
 * Read the revision counter.
 *
 * A corrupt or missing counter reads as revision 0 with no records known, which
 * makes the caller rescan rather than trust a number. Never throws: a history
 * listing must not fail because a cache file is unreadable.
 */
export function readRevision(store: StorePaths): { revision: number; records: number; updatedAt?: string } {
  try {
    const parsed = JSON.parse(readFileSync(revisionFile(store), 'utf8')) as { revision?: unknown; records?: unknown; updatedAt?: unknown }
    return {
      revision: typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
      records: typeof parsed.records === 'number' && Number.isSafeInteger(parsed.records) && parsed.records >= 0 ? parsed.records : 0,
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
    }
  } catch {
    return { revision: 0, records: 0 }
  }
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Hash one workspace-relative file, or `null` when it no longer exists. */
export function hashWorkspaceFile(workspace: string, rel: string): string | null {
  const abs = path.join(workspace, ...rel.split('/'))
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null
    return sha256Bytes(readFileSync(abs))
  } catch {
    return null
  }
}

/**
 * Append one record, advancing the revision only after the bytes are committed.
 *
 * The ordering is the requirement, not an optimization: a revision that moved
 * before the record landed would let `ffhistory` claim archived evidence that
 * does not exist. `atomicWrite` writes a temp file, fsyncs and renames, so a
 * half-written record is never visible under its final name — and a leftover
 * `.tmp` is not a record, which is why nothing here lists by prefix.
 *
 * @returns the record id, or the failure; a caller must not report a check as
 *   archived when this fails.
 */
export async function appendRecord(store: StorePaths, workspace: string, record: VerificationRecord): Promise<{ ok: true; id: string; revision: number } | { ok: false; detail: string }> {
  if (record.schema !== VERIFICATION_SCHEMA) return { ok: false, detail: 'the verification record lacks the current evidence schema; run a fresh check' }
  if (!/^[0-9a-zA-Z-]+$/.test(record.id)) return { ok: false, detail: 'invalid verification record id' }
  const dir = dirFor(store)
  const file = path.join(dir, `${record.id}.json`)
  let committed = false
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, detail: `cannot create the verification directory: ${errorMessage(error)}` }
  }
  try {
    await withFileLock(dir, () => {
      if (existsSync(file)) throw new Error('the verification id is already committed; records cannot be overwritten')
      atomicWrite(file, JSON.stringify(record, null, 2))
      committed = true
      const current = readRevision(store)
      atomicWrite(revisionFile(store), JSON.stringify({
        revision: current.revision + 1,
        records: countRecordsOnDisk(dir),
        updatedAt: new Date().toISOString(),
      }, null, 2))
    })
  } catch (error) {
    // A partially written record under its final name must not survive as
    // evidence: the revision was not advanced, so nothing will select it, and
    // removing it keeps the directory listing honest.
    if (committed) try { unlinkSync(file) } catch { /* the write never landed; nothing to remove */ }
    return { ok: false, detail: `the verification record was not persisted: ${errorMessage(error)}` }
  }
  return { ok: true, id: record.id, revision: readRevision(store).revision }
}

/** Count committed records. Temp files and the revision file are not records. */
function countRecordsOnDisk(dir: string): number {
  try {
    return readdirSync(dir).filter(name => /^[0-9a-zA-Z-]+\.json$/.test(name) && name !== 'revision.json').length
  } catch {
    return 0
  }
}

/**
 * Read every committed record, newest first.
 *
 * Unreadable or malformed entries are skipped and counted, never invented: a
 * caller must be able to say "records exist that could not be read" rather than
 * silently present a shorter history as complete.
 */
export function listRecords(store: StorePaths, options: { batchIds?: readonly number[]; limit?: number } = {}): { records: VerificationRecord[]; unreadable: number } {
  const dir = dirFor(store)
  if (!existsSync(dir)) return { records: [], unreadable: 0 }
  const names = readdirSync(dir).filter(name => /^[0-9a-zA-Z-]+\.json$/.test(name) && name !== 'revision.json')
  const records: VerificationRecord[] = []
  let unreadable = 0
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as VerificationRecord
      if (typeof parsed.id !== 'string' || !Array.isArray(parsed.checks) || !Array.isArray(parsed.batchIds)) {
        unreadable++
        continue
      }
      if (options.batchIds !== undefined && options.batchIds.length > 0) {
        // A record is about the batches it was run for. A record covering none
        // of the requested batches is not evidence about them.
        if (!parsed.batchIds.some(id => options.batchIds?.includes(id))) continue
      }
      records.push(parsed)
    } catch {
      unreadable++
    }
  }
  records.sort((a, b) => (Date.parse(b.finishedAt) || 0) - (Date.parse(a.finishedAt) || 0) || a.id.localeCompare(b.id))
  const limit = options.limit ?? records.length
  return { records: records.slice(0, Math.max(0, limit)), unreadable }
}

/**
 * Judge one record's own checks, without reference to the tree.
 *
 * A required entry names a check **id**, and is satisfied only by a result with
 * that id whose status is `passed`. Matching on ids rather than kinds matters:
 * one bridge run can cover several files, and a plan can require one specific
 * recipe out of many.
 *
 * The rules are the contract's, and each exists because the naive version is
 * wrong in a specific way:
 *
 * - A missing required check is not a pass. Absence of evidence is the failure
 *   mode this function exists to prevent.
 * - A skipped, cancelled, unavailable or stale check is not a pass either. All
 *   are recorded; none demonstrates anything.
 * - A failure anywhere wins. Closing a coverage gap must never bury a real
 *   finding.
 * - An external report is excluded from the automatic set entirely: it is
 *   shown, but a claim is not a check.
 * - Declaring nothing as required yields `not_run`, not `passed`. A record that
 *   required nothing has accepted nothing.
 */
export function aggregateChecks(required: readonly string[], results: readonly CheckResult[], provenance: Provenance): AggregatedChecks {
  const automatic = provenance === 'external-report' ? [] : results
  const failures: CheckFinding[] = []
  const failed = automatic.filter(result => result.status === 'failed')
  for (const result of failed) failures.push(...result.findings)

  if (failed.length > 0) {
    return { status: 'failed', missing: [], notPassed: failed.map(result => result.id), failures, reason: `${failed.length} failing check(s), ${failures.length} finding(s)` }
  }
  if (provenance === 'external-report') {
    return { status: 'not_run', missing: [...required], notPassed: [], failures, reason: 'an external report is not an automatic check; it demonstrates nothing on its own' }
  }
  if (required.length === 0) {
    return { status: 'not_run', missing: [], notPassed: [], failures, reason: 'the record declared no required check, so it accepts nothing' }
  }
  const stale = automatic.filter(result => result.status === 'stale')
  if (stale.length > 0) return { status: 'stale', missing: [], notPassed: stale.map(result => result.id), failures, reason: 'check inputs changed during execution; the recorded result is stale' }

  const missing: string[] = []
  const notPassed: string[] = []
  for (const id of required) {
    const found = automatic.filter(result => result.id === id)
    if (found.length === 0) { missing.push(id); continue }
    if (!found.every(result => result.status === 'passed')) notPassed.push(id)
  }

  if (missing.length === required.length) {
    return { status: 'not_run', missing, notPassed, failures, reason: `no result for the required check(s): ${missing.join(', ')}` }
  }
  if (missing.length > 0) {
    return { status: 'partial', missing, notPassed, failures, reason: `required check(s) absent: ${missing.join(', ')}` }
  }
  if (notPassed.length > 0) {
    if (missing.length === 0 && automatic.length > 0 && automatic.every(result => result.status === 'not_run')) {
      return { status: 'not_run', missing, notPassed, failures, reason: 'none of the required checks ran on an applicable input' }
    }
    return { status: 'partial', missing, notPassed, failures, reason: `required check(s) did not demonstrate a pass: ${notPassed.join(', ')}` }
  }
  return { status: 'passed', missing, notPassed, failures }
}

/**
 * Recompute one record's applicability against the current tree.
 *
 * The whole function is the comparison of the record's own after-hashes with the
 * files' hashes now. Content, not size+mtime: a same-length rewrite that
 * restores the timestamp would otherwise let an old pass survive, and that is
 * precisely the case M1.5 forbids.
 */
export function applicabilityOf(record: VerificationRecord, workspace: string): RecordApplicability {
  const verdict = aggregateChecks(record.requiredChecks, record.checks, record.provenance)
  if (record.schema !== VERIFICATION_SCHEMA) {
    return { record, applicable: false, drifted: [], verdict, effective: 'stale', reason: 'evidence_schema' }
  }
  const drifted: string[] = []
  for (const entry of record.afterHashes) {
    if (hashWorkspaceFile(workspace, entry.file) !== entry.hash) drifted.push(entry.file)
  }
  if (record.traceFiles !== undefined) {
    for (const file of candidateSetDrift(workspace, record.traceFiles)) if (!drifted.includes(file)) drifted.push(file)
  }
  const applicable = drifted.length === 0
  const effective: CheckStatus = !applicable ? 'stale' : verdict.status
  return { record, applicable, drifted, verdict, effective, ...(applicable ? {} : { reason: 'input_drift' as const }) }
}

/** Build an empty record shell with a fresh id. */
export function newRecordId(): string {
  return randomUUID()
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The store for a workspace, for callers that only have a path. */
export function verificationStore(workspace: string): StorePaths {
  return storeFor(workspace)
}
