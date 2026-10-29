/**
 * Two snapshots, one question: did this change orphan a consumer?
 *
 * `bridge-check.ts` diffs two models; `tools-trace.ts` builds graphs. This module
 * is the small amount of orchestration between them, and it exists because the
 * order of operations carries the honesty of the answer:
 *
 *   1. Build/load the **before** model. Its provider globals are evidence about
 *      the past, and they are needed *during* the after scan.
 *   2. Scan the **after** state while forcing those globals to stay visible
 *      (`extraGlobals`). Without this, deleting a preload erases every consumer
 *      of its global and the deletion looks clean.
 *   3. Diff, attributed by member identity, never by line.
 *
 * Everything it returns states which baseline produced it, so a caller cannot
 * accidentally present an unattributed result as a fresh check.
 *
 * @module dsh-forge/bridge-scan
 */

import { assembleTraceGraph, type AssembledTrace } from './tools-trace.ts'
import { bridgeModel, diffBridges, type BridgeModel, type CheckKind, type CheckResult } from './bridge-check.ts'

export interface WorkspaceBridgeDiffInput {
  workspace: string
  /** A graph to compare against, or null for "current state only". */
  before?: AssembledTrace | null
  /** Build a content-bound capture for the after state (slower; needed for a
   *  later edit gate or a repeat comparison). */
  capture?: boolean
  changed?: readonly string[]
  checks?: readonly CheckKind[]
  signal?: AbortSignal
}

export interface WorkspaceBridgeDiff {
  result: CheckResult
  /** The snapshot the after state came from; resolvable by ID afterwards. */
  after: AssembledTrace
  /** Snapshot the comparison baseline came from, when there was one. */
  beforeSnapshotId: string | null
}

/** Model for an already-assembled graph. */
export function modelOf(assembled: AssembledTrace, workspace: string): BridgeModel {
  return bridgeModel({ workspace, files: assembled.graph.files })
}

/**
 * Scan the workspace and diff it against an optional before-graph.
 *
 * The before-graph is intentionally *not* re-scanned: it describes an earlier
 * state, and re-reading the tree would replace the only evidence of that state
 * with the current one.
 */
export async function diffWorkspaceBridges(input: WorkspaceBridgeDiffInput): Promise<WorkspaceBridgeDiff> {
  const before = input.before ?? null
  const beforeModel = before ? modelOf(before, input.workspace) : null
  // Keep the previous provider globals visible during the after scan, so a
  // deleted provider still has its consumers on record.
  const extraGlobals = beforeModel
    ? [...new Set(beforeModel.providers.filter(provider => !provider.dynamicName).map(provider => provider.object))]
    : []
  const after = await assembleTraceGraph(input.workspace, {
    ...(input.capture === true ? { capture: true } : {}),
    ...(extraGlobals.length > 0 ? { extraGlobals } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const afterModel = modelOf(after, input.workspace)
  const result = diffBridges({
    workspace: input.workspace,
    before: beforeModel,
    after: afterModel,
    changed: input.changed ?? [],
    ...(input.checks ? { checks: input.checks } : {}),
  })
  return { result, after, beforeSnapshotId: before?.snapshot.snapshotId ?? null }
}
