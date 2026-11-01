/** Verification-record persistence shared by static and host checks. */

import { workspaceKey, type StorePaths } from './ledger.ts'
import {
  appendRecord, newRecordId, VERIFICATION_SCHEMA,
  type CheckResult as VerificationCheckResult, type Provenance, type VerificationRecord,
} from './verification.ts'

/**
 * Persist one check outcome and report whether it is still there.
 *
 * The failure mode this function is shaped around is requirement 5: a storage
 * failure must not undo the code write, and must not be reported as if the
 * record were archived. So it returns a `persisted` flag for the caller's output
 * instead of throwing, and the caller's text says plainly that history cannot
 * claim this record.
 */
export async function persistRecord(
  workspace: string,
  store: StorePaths,
  provenance: Provenance,
  batchIds: readonly number[],
  requiredChecks: readonly string[],
  checkResults: readonly VerificationCheckResult[],
  afterHashes: Array<{ file: string; hash: string | null }>,
  startedAt: string,
  extra: { checkPlanId?: string; hostCallId?: string; recipeId?: string; exitCode?: number; outputRef?: string; traceFiles?: string[] } = {},
): Promise<{ id: string; revision?: number; persisted: boolean; detail?: string }> {
  const record: VerificationRecord = {
    schema: VERIFICATION_SCHEMA,
    id: newRecordId(),
    workspaceId: workspaceKey(workspace),
    batchIds: [...batchIds],
    afterHashes,
    checks: [...checkResults],
    requiredChecks: [...requiredChecks],
    startedAt,
    finishedAt: new Date().toISOString(),
    provenance,
    ...(extra.checkPlanId === undefined ? {} : { checkPlanId: extra.checkPlanId }),
    ...(extra.hostCallId === undefined ? {} : { hostCallId: extra.hostCallId }),
    ...(extra.recipeId === undefined ? {} : { recipeId: extra.recipeId }),
    ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
    ...(extra.outputRef === undefined ? {} : { outputRef: extra.outputRef }),
    ...(extra.traceFiles === undefined ? {} : { traceFiles: extra.traceFiles }),
  }
  const appended = await appendRecord(store, workspace, record)
  if (!appended.ok) return { id: record.id, persisted: false, detail: appended.detail }
  return { id: appended.id, revision: appended.revision, persisted: true }
}
