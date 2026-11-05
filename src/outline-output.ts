/** Bounded declaration browsing; exact definitions and source reads remain separate. */
import { randomBytes } from 'node:crypto'
import { boundedOutput, outputRows } from './output-budget.ts'

export interface OutlineFilters { scope: 'declarations' | 'all'; depth?: number; kind?: string }
export interface OutlineQuery extends OutlineFilters { limit?: number; cursor?: string }
export interface OutlineItem {
 name: string; qualifiedName: string; kind: string; startLine: number; endLine: number
 commentStartLine?: number; level: number; occurrence: number
}
export interface OutlineSource {
 items: OutlineItem[]; lang: string; partial: boolean; path: string; snapshot: string; available: number
}
export interface OutlinePage {
 path: string; snapshot: string; filters: OutlineFilters; available: number
 total: number; returned: number; offset: number; complete: boolean; nextCursor?: string
}
const KINDS = ['class','function','method','interface','struct','enum','type','trait','module','field','variable','object','impl']
const DEFAULT_LIMIT = 50, MAX_LIMIT = 200
const TTL = 30 * 60_000
type Cursor = { query: string; snapshot: string; offset: number; limit: number; expires: number }

export function outlineQuery(args: Record<string, unknown>): OutlineQuery {
 if (args.scope !== undefined && args.scope !== 'declarations' && args.scope !== 'all') throw new Error('scope must be declarations or all')
 if (args.depth !== undefined && (!Number.isSafeInteger(args.depth) || Number(args.depth) < 1 || Number(args.depth) > 20)) throw new Error('outline depth must be an integer between 1 and 20')
 if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > MAX_LIMIT)) throw new Error('outline limit must be an integer between 1 and 200')
 if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor.trim())) throw new Error('outline cursor must be a nonempty string')
 if (args.kind !== undefined && (typeof args.kind !== 'string' || !args.kind.trim())) throw new Error('outline kind must be a nonempty comma-separated list')
 const kinds = typeof args.kind === 'string' ? [...new Set(args.kind.split(',').map(k => k.trim()))].sort() : undefined
 if (kinds?.some(k => !KINDS.includes(k))) throw new Error(`outline kind must contain only ${KINDS.join(',')}`)
 return { scope: args.scope ?? (kinds ? 'all' : 'declarations'),
  ...(kinds ? { kind: kinds.join(',') } : {}), ...(args.depth === undefined ? {} : { depth: Number(args.depth) }),
  ...(args.limit === undefined ? {} : { limit: Number(args.limit) }), ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }) }
}

export class OutlineOutput {
 private readonly cursors = new Map<string, Cursor>()
 private readonly now: () => number
 constructor(now: () => number = Date.now) { this.now = now }
 page(source: OutlineSource, view: OutlineQuery): { items: OutlineItem[]; lang: string; page: OutlinePage; note?: string } {
  const now = this.now()
  for (const [key, cursor] of this.cursors) if (cursor.expires <= now) this.cursors.delete(key)
  const filters: OutlineFilters = { scope: view.scope, ...(view.depth === undefined ? {} : { depth: view.depth }), ...(view.kind ? { kind: view.kind } : {}) }
  const query = JSON.stringify([source.path, filters])
  let position: Cursor = { query, snapshot: source.snapshot, offset: 0, limit: view.limit ?? DEFAULT_LIMIT, expires: now + TTL }
  if (view.cursor !== undefined) {
   const saved = this.cursors.get(view.cursor)
   if (!saved) throw new Error('outline cursor expired or unknown; restart without cursor')
   if (saved.query !== query || (view.limit !== undefined && saved.limit !== view.limit)) throw new Error('outline cursor does not match path/filters/limit; restart the query')
   if (saved.snapshot !== source.snapshot) throw new Error('outline source changed; restart without cursor')
   position = saved
  }
  const items = outputRows(source.items, position.offset, position.limit,
   item => `symbol at L${item.startLine}-${item.endLine} exceeds the outline row budget; inspect that source range with read or narrow depth/kind`)
  const end = position.offset + items.length, complete = end === source.items.length
  let nextCursor: string | undefined
  if (!complete) {
   while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!)
   nextCursor = randomBytes(18).toString('base64url')
   this.cursors.set(nextCursor, { ...position, offset: end })
  }
  const result = { items, lang: source.lang,
   page: { path: source.path, snapshot: source.snapshot, filters, available: source.available, total: source.items.length,
    returned: items.length, offset: position.offset, complete, ...(nextCursor ? { nextCursor } : {}) },
   ...(source.partial ? { note: 'parse had errors; ranges are best-effort; page completeness covers extracted symbols only' } : {}) }
  return boundedOutput(result, 'outline metadata exceeds the page budget; shorten the file path or narrow filters')
 }
}
