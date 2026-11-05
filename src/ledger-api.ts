/**
 * Read model for the ledger tab in the sidebar.
 *
 * Everything here projects state that already exists on disk — batch records
 * from `ledger.jsonl`, the content-addressed snapshots they point at, and the
 * archived verification records — into plain JSON. No new file, no write path,
 * no git. A workspace forge has never written reads as an empty list rather
 * than as an error, because "this project has no construction history" is an
 * answer, not a failure.
 *
 * Diffs are rendered per batch and only when asked for: `snapshotDiff` previews
 * complete local hunks under an 8 KiB budget. Oversized hunks are explicit;
 * ff_history can retrieve the complete patch in fragments. Both surfaces use
 * the same snapshot patch generator, independent of current workspace bytes.
 *
 * @module dsh-forge/ledger-api
 */

import { createHash, randomBytes } from 'node:crypto'

export class LedgerApiError extends Error {
  constructor(message: string, public status: 400 | 409 | 503 = 400) { super(message) }
}
export interface LedgerListOptions { limit?: number; keyword?: string; pathContains?: string; actor?: string; kind?: string; cursor?: string; projectId?: string; taskId?: string; file?: string; unassigned?: boolean }
interface PageCursor { workspace: string; filter: string; anchor: number; before: number; fingerprint: string; expires: number }
const cursors = new Map<string, PageCursor>()
const CURSOR_TTL = 10 * 60_000
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

import { getBlob, readLedgerTail, storeFor, type LedgerBatch, type LedgerNode, type StorePaths } from './ledger.ts'
import { snapshot, snapshotDiff } from './history.ts'
import { applicabilityOf, listRecords, readRevision } from './verification.ts'
import { getProject, listProjects, projectBatchMembership } from './projects.ts'
import { readNode } from './history.ts'

/** Requests are bounded here as well as in the route, so a caller cannot page forever. */
const MAX_BATCHES = 200
const DEFAULT_BATCHES = 50

/** One file a batch touched, as the list shows it. */
export interface LedgerFileRow {
  file: string
  op: LedgerNode['op']
  bytes: number
}

/**
 * The archived verdict for a batch.
 *
 * `recorded` and `effective` are two separate facts and stay separate: a record
 * whose inputs have moved since is `applicable: false` and `effective: 'stale'`
 * while `recorded` keeps what was actually decided. Collapsing them into one
 * word would let an old pass read as a current pass.
 */
export interface LedgerCheckRow {
  id: string
  recorded: string
  effective: string
  applicable: boolean
  drifted: string[]
  finishedAt: string
}

/** One batch, newest first in the list. */
export interface LedgerBatchRow {
  id: number
  ts: number
  kind: string
  reason: string
  actor: string
  reverted?: number
  attribution?: LedgerBatch['attribution']
  membership?: 'direct' | 'linked'
  files: LedgerFileRow[]
  check?: LedgerCheckRow
}

/** One node's snapshot diff inside an opened batch. */
export interface LedgerDetailNode {
  node: string
  file: string
  op: LedgerNode['op']
  diff: string
  binary: boolean
  truncated: boolean
  /** Set when a snapshot blob is missing or corrupt; `diff` then carries the reason. */
  unreadable?: true
}

export interface LedgerListView {
  workspace: string
  batches: LedgerBatchRow[]
  /** All matching batches in this cursor's fixed ledger snapshot. */
  total: number
  /** Batches returned on this page, after the limit is applied. */
  returned: number
  nextCursor?: string
  verification: { revision: number; records: number; updatedAt?: string }
}

export interface LedgerBatchView {
  batch: LedgerBatchRow
  nodes: LedgerDetailNode[]
}

function toRow(batch: LedgerBatch, check: LedgerCheckRow | undefined): LedgerBatchRow {
  return {
    id: batch.id,
    ts: batch.ts,
    kind: batch.kind,
    reason: batch.reason,
    actor: batch.actor,
    ...(batch.reverted === undefined ? {} : { reverted: batch.reverted }),
    ...(batch.attribution ? { attribution: batch.attribution } : {}),
    files: batch.nodes.map((node) => ({ file: node.file, op: node.op, bytes: node.bytes })),
    ...(check === undefined ? {} : { check }),
  }
}

/**
 * The newest archived verdict per batch.
 *
 * A batch can be verified more than once; the tab shows one badge, so the last
 * record by `finishedAt` wins. Applicability is recomputed here against the
 * current files — a stored record never gets to claim it still applies.
 */
function checksByBatch(store: StorePaths, ids: readonly number[]): Map<number, LedgerCheckRow> {
  const result = new Map<number, LedgerCheckRow>()
  if (ids.length === 0) return result
  const wanted = new Set(ids)
  const { records } = listRecords(store, { batchIds: [...wanted] })
  const ordered = [...records].sort((left, right) => left.finishedAt.localeCompare(right.finishedAt))
  for (const record of ordered) {
    const view = applicabilityOf(record, store.root)
    const row: LedgerCheckRow = {
      id: record.id,
      recorded: view.verdict.status,
      effective: view.effective,
      applicable: view.applicable,
      drifted: view.drifted,
      finishedAt: record.finishedAt,
    }
    for (const batch of record.batchIds) if (wanted.has(batch)) result.set(batch, row)
  }
  return result
}

/**
 * Batch summaries for one workspace, newest first.
 *
 * @param workspace - absolute workspace root; the store is derived from it.
 * @param limit - how many recent batches to return, clamped to {@link MAX_BATCHES}.
 */
export function ledgerList(workspace: string, options: number | LedgerListOptions = DEFAULT_BATCHES): LedgerListView {
  const store = storeFor(workspace)
  const input = typeof options === 'number' ? { limit: options } : options
  const limit = input.limit ?? DEFAULT_BATCHES
  if (!Number.isFinite(limit)) throw new LedgerApiError('limit must be finite')
  const count = Math.min(Math.max(1, Math.trunc(limit)), MAX_BATCHES)
  const filters = { keyword: (input.keyword ?? '').trim().toLowerCase(), pathContains: (input.pathContains ?? '').trim().toLowerCase(), actor: (input.actor ?? '').trim(), kind: (input.kind ?? '').trim() }
  if (filters.kind && !['edit', 'rollback', 'external', 'project'].includes(filters.kind)) throw new LedgerApiError('invalid kind')
  if (input.unassigned !== undefined && typeof input.unassigned !== 'boolean') throw new LedgerApiError('unassigned must be boolean')
  if (input.taskId && !input.projectId) throw new LedgerApiError('taskId requires projectId')
  if (input.projectId && input.unassigned) throw new LedgerApiError('projectId and unassigned are exclusive')
  const project = input.projectId ? getProject(workspace, input.projectId) : undefined
  // Bind cursor membership to the same project revisions as the first page.
  const projects = input.unassigned ? listProjects({ workspace }) : project ? [project] : []
  const membershipVersion = projects.map(p => [p.id, p.revision]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))
  const matchesScope = (batch: LedgerBatch) => (!project || !!projectBatchMembership(project, batch, input.taskId))
    && (!input.unassigned || !batch.attribution && !projects.some(p => p.links.some(l => l.batchId === batch.id)))
    && (!input.file || batch.nodes.some(n => n.file === input.file))
  const filter = JSON.stringify({ ...filters, limit: count, projectId: input.projectId, taskId: input.taskId, file: input.file, unassigned: input.unassigned === true })
  const all = readLedgerTail(store, Number.MAX_SAFE_INTEGER)
  const now = Date.now()
  for (const [key, value] of cursors) if (value.expires <= now) cursors.delete(key)
  let anchor = all.at(-1)?.id ?? 0
  let before = Number.MAX_SAFE_INTEGER
  const fingerprintOf = (batches: LedgerBatch[]) => digest({ batches, membershipVersion })
  let fingerprint = fingerprintOf(all)
  if (input.cursor !== undefined) {
    const cursor = cursors.get(input.cursor)
    if (!cursor || cursor.workspace !== store.root || cursor.filter !== filter) throw new LedgerApiError('cursor expired or does not match workspace/filter', 409)
    anchor = cursor.anchor; before = cursor.before
    fingerprint = fingerprintOf(all.filter(batch => batch.id <= anchor))
    if (fingerprint !== cursor.fingerprint) throw new LedgerApiError('cursor ledger snapshot changed', 409)
  }
  const matchingSnapshot = all.filter(batch => batch.id <= anchor && matchesScope(batch)
    && (!filters.actor || batch.actor === filters.actor)
    && (!filters.kind || batch.kind === filters.kind)
    && (!filters.pathContains || batch.nodes.some(node => node.file.toLowerCase().includes(filters.pathContains)))
    && (!filters.keyword || [batch.reason, batch.actor, batch.kind, ...batch.nodes.map(node => node.file)].join('\n').toLowerCase().includes(filters.keyword))).reverse()
  const matches = matchingSnapshot.filter(batch => batch.id < before)
  const batches = matches.slice(0, count)
  let nextCursor: string | undefined
  if (matches.length > batches.length) {
    nextCursor = randomBytes(24).toString('base64url')
    if (cursors.size >= 512) cursors.delete(cursors.keys().next().value!)
    cursors.set(nextCursor, { workspace: store.root, filter, anchor, before: batches.at(-1)!.id, fingerprint, expires: now + CURSOR_TTL })
  }
  const checks = checksByBatch(store, batches.map(batch => batch.id))
  return { workspace: store.root, batches: batches.map(batch => ({ ...toRow(batch, checks.get(batch.id)), ...(project ? { membership: projectBatchMembership(project, batch, input.taskId) } : {}) })), total: matchingSnapshot.length, returned: batches.length, verification: readRevision(store), ...(nextCursor ? { nextCursor } : {}) }
}

/**
 * One batch with its per-file diffs.
 *
 * @returns `undefined` when the id names no batch in this workspace's ledger.
 */
export function ledgerBatchDetail(workspace: string, id: number): LedgerBatchView | undefined {
  const store = storeFor(workspace)
  const batch = readLedgerTail(store, Number.MAX_SAFE_INTEGER).find((candidate) => candidate.id === id)
  if (batch === undefined) return undefined
  const nodes = batch.nodes.map((node, index): LedgerDetailNode => {
    const address = `b${batch.id}:n${index}`
    try {
      const rendered = snapshotDiff(snapshot(store, node.before), snapshot(store, node.after), node.file)
      return { node: address, file: node.file, op: node.op, ...rendered }
    } catch (error) {
      // A missing blob is a fact about the store, not a reason to fail the whole
      // batch: the other nodes are still readable.
      return {
        node: address,
        file: node.file,
        op: node.op,
        diff: error instanceof Error ? error.message : String(error),
        binary: false,
        truncated: false,
        unreadable: true,
      }
    }
  })
  return { batch: toRow(batch, checksByBatch(store, [batch.id]).get(batch.id)), nodes }
}

export interface LedgerSnapshotPage {
 node: string; file: string; side: 'before' | 'after'; hash: string | null
 status: 'text' | 'absent' | 'binary' | 'unreadable'; bytes: number; total: number; offset: number; nextOffset: number | null; text?: string
}
/** Immutable UTF-8 text is paged by UTF-16 code units; concatenating pages is lossless. */
export function ledgerNodeSnapshot(workspace: string, address: string, side: 'before' | 'after', offset = 0, limit = 32768): LedgerSnapshotPage {
 if (side !== 'before' && side !== 'after') throw new LedgerApiError('side must be before or after')
 if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) throw new LedgerApiError('invalid snapshot offset/limit')
 const store = storeFor(workspace), { node } = readNode(store, address), hash = node[side]
 const base: LedgerSnapshotPage = { node: address, file: node.file, side, hash, status: 'absent', bytes: 0, total: 0, offset, nextOffset: null }
 if (hash === null) return base
 const bytes = getBlob(store, hash)
 if (bytes === null) return { ...base, status: 'unreadable' }
 if (bytes.includes(0)) return { ...base, status: 'binary', bytes: bytes.length }
 let text: string
 try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
 catch { return { ...base, status: 'binary', bytes: bytes.length } }
 if (offset > text.length) throw new LedgerApiError('snapshot offset exceeds text length')
 const end = Math.min(text.length, offset + limit)
 return { ...base, status: 'text', bytes: bytes.length, total: text.length, text: text.slice(offset, end), nextOffset: end < text.length ? end : null }
}
