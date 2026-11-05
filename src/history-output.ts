/** Snapshot-bound diff pages. Only coordinates live in the cursor cache. */
import { createHash, randomBytes } from 'node:crypto'
import { boundedOutput, jsonBytes, outputFragment, OUTPUT_CONTENT_BYTES, OUTPUT_ITEM_BYTES } from './output-budget.ts'
import type { LedgerBatch, LedgerNode, StorePaths } from './ledger.ts'
import { nodeId, oversizedHunk, snapshot, snapshotPatch } from './history.ts'

export interface NodeDiff {
 node: string; file: string; before: string | null; after: string | null
 diff: string; binary: boolean; truncated: boolean; coarse: boolean
}
export interface DiffPage {
 diffs: NodeDiff[]; complete: boolean; total: number; returned: number
 nextCursor?: string; omittedNodes?: string[]
 format?: 'patch-fragment' | 'record-fragment'; offset?: number; totalChars?: number; record?: string; snapshot?: string
}
export interface DiffView { detail?: 'hunks' | 'patch' | 'record' | 'receipt'; cursor?: string }
interface Position { query: string; snapshot: string; offset: number; expires: number }
type Pick = { node: LedgerNode; index: number }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const TTL = 30 * 60_000

export const NODE_DIFF_SCHEMA = {
 type: 'object', additionalProperties: false,
 properties: {
  node: { type: 'string', required: true }, file: { type: 'string', required: true },
  before: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  after: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  diff: { type: 'string', required: true }, binary: { type: 'boolean', required: true },
  truncated: { type: 'boolean', required: true }, coarse: { type: 'boolean', required: true },
 },
} as const
export const DIFF_PAGE_FIELDS = {
 complete: { type: 'boolean', required: true }, total: { type: 'integer', required: true }, returned: { type: 'integer', required: true },
 nextCursor: { type: 'string' }, omittedNodes: { type: 'array', items: { type: 'string' } },
 format: { type: 'string', enum: ['patch-fragment', 'record-fragment'] }, offset: { type: 'integer' }, totalChars: { type: 'integer' }, record: { type: 'string' }, snapshot: { type: 'string' },
} as const
export const DIFF_PAGE_SCHEMA = { type: 'object', additionalProperties: false,
 properties: { diffs: { type: 'array', required: true, items: NODE_DIFF_SCHEMA }, ...DIFF_PAGE_FIELDS } } as const

export class DiffOutput {
 private readonly cursors = new Map<string, Position>()
 private readonly now: () => number
 constructor(now: () => number = Date.now) { this.now = now }
 private position(query: string, snapshotId: string, cursor?: string): Position {
  const now = this.now()
  for (const [key, value] of this.cursors) if (value.expires <= now) this.cursors.delete(key)
  if (cursor !== undefined) {
   const previous = this.cursors.get(cursor)
   if (!previous) throw new Error('diff cursor expired or unknown; restart without cursor')
   if (previous.query !== query) throw new Error('diff cursor does not match workspace/node/batch/detail')
   if (previous.snapshot !== snapshotId) throw new Error('diff snapshot changed; restart without cursor')
   return previous
  }
  return { query, snapshot: snapshotId, offset: 0, expires: now + TTL }
 }
 private next(position: Position, offset: number): string {
  while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!)
  const cursor = randomBytes(18).toString('base64url')
  this.cursors.set(cursor, { ...position, offset }); return cursor
 }
 record(source: string, query: string, cursor?: string): DiffPage {
  const position = this.position(query, hash(source), cursor)
  const { text, end } = outputFragment(source, position.offset)
  return this.bound({ diffs: [], record: text, snapshot: position.snapshot, format: 'record-fragment', offset: position.offset,
   totalChars: source.length, total: 1, returned: end === source.length ? 1 : 0, complete: end === source.length,
   ...(end === source.length ? {} : { nextCursor: this.next(position, end) }) })
 }
 read(store: StorePaths, batch: LedgerBatch, picks: Pick[], selection: string, view: DiffView = {}): DiffPage {
  const detail = view.detail ?? 'hunks'
  if (detail === 'patch' && (picks.length !== 1 || !selection.startsWith('node:'))) throw new Error('detail=patch requires one node, not a batch')
  const query = JSON.stringify([store.root, selection, detail])
  if (detail === 'record') {
   return this.record(JSON.stringify(batch), query, view.cursor)
  }
  const position = this.position(query, hash(picks.map(p => p.node)), view.cursor)
  const sources = picks.map(({ node, index }) => ({
   info: { node: nodeId(batch.id, index), file: node.file, before: node.before, after: node.after },
   patch: snapshotPatch(snapshot(store, node.before), snapshot(store, node.after), node.file),
  }))
  if (detail === 'patch') {
   const { info, patch } = sources[0], source = patch.header + patch.hunks.join('')
   const { text, end } = outputFragment(source, position.offset)
   const complete = end === source.length
   return this.bound({ diffs: [{ ...info, diff: text, binary: patch.binary, coarse: patch.coarse, truncated: !complete || position.offset !== 0 }],
    complete, total: patch.hunks.length, returned: complete && position.offset === 0 ? patch.hunks.length : 0,
    format: 'patch-fragment', offset: position.offset, totalChars: source.length,
    ...(complete ? {} : { nextCursor: this.next(position, end) }) })
  }
  const units = sources.flatMap(({ info, patch }) => (patch.hunks.length ? patch.hunks : ['']).map(hunk => ({ info, patch, hunk })))
  const hasOmissions = units.some(u => oversizedHunk(u.hunk))
  const omittedNodes: string[] = []
  const diffs: NodeDiff[] = []
  let end = position.offset
  for (const unit of units.slice(position.offset)) {
   const existing = diffs.find(d => d.node === unit.info.node), oversized = oversizedHunk(unit.hunk)
   const diff = existing ? { ...existing } : { ...unit.info, diff: unit.patch.header, binary: unit.patch.binary, coarse: unit.patch.coarse, truncated: false }
   diff.diff += oversized ? '' : unit.hunk
   diff.truncated ||= oversized
   const candidate = existing ? diffs.map(d => d === existing ? diff : d) : [...diffs, diff]
   if (jsonBytes(candidate) > OUTPUT_CONTENT_BYTES || jsonBytes(diff) > OUTPUT_ITEM_BYTES || end - position.offset >= 100) break
   if (oversized && !omittedNodes.includes(unit.info.node)) omittedNodes.push(unit.info.node)
   if (existing) Object.assign(existing, diff); else diffs.push(diff)
   end++
  }
  if (end === position.offset && end < units.length) throw new Error('diff metadata exceeds page budget; select one node with detail=patch')
  const remaining = end < units.length
  for (const diff of diffs) if (units.slice(0, position.offset).some(u => u.info.node === diff.node)
    || units.slice(end).some(u => u.info.node === diff.node)) diff.truncated = true
  return this.bound({ diffs, total: units.length, returned: end - position.offset,
   complete: !remaining && !hasOmissions,
   ...(remaining ? { nextCursor: this.next(position, end) } : {}), ...(omittedNodes.length ? { omittedNodes } : {}) })
 }
 private bound(page: DiffPage): DiffPage {
  return boundedOutput(page, 'narrow diff to a node')
 }
}

// Shared between ff_edit's optional receipt and ff_history continuation.
export const historyDiffOutput = new DiffOutput()
export function renderDiffPage(page: DiffPage): string[] {
 const lines = page.diffs.map(d => `${d.node} ${d.before ?? 'absent'} -> ${d.after ?? 'absent'}${d.coarse ? ' [coarse alignment]' : ''}${d.truncated ? ' [incomplete]' : ''}\n${d.diff}`)
 if (page.record !== undefined) lines.push(page.record)
 if (page.snapshot) lines.push(`[snapshot ${page.snapshot}]`)
 if (page.format) lines.push(`[${page.format} offset=${page.offset} totalChars=${page.totalChars}; concatenate ${page.record === undefined ? 'diff strings before applying' : 'record strings before JSON parsing'}]`)
 if (page.omittedNodes?.length) lines.push(`[oversized hunks omitted; ff_history node=<${page.omittedNodes.join('|')}> detail=patch returns complete patch fragments]`)
 if (page.nextCursor) lines.push(`[incomplete; continue ff_history with the same batch/node/detail and cursor=${page.nextCursor}]`)
 if (!page.complete && !page.nextCursor && !page.omittedNodes?.length) lines.push('[incomplete; oversized hunks were omitted on earlier pages; read those node addresses with detail=patch]')
 return lines
}
