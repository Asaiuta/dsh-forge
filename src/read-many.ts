/** Explicit batch selections with lossless fragments and content-bound cursors. */
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { workdirOf, type ForgeExec } from './core.ts'
import { sourceRead, sourceSymbol, sha256 } from './source-read.ts'
import { boundedOutput, jsonBytes, outputFragment, OUTPUT_CONTENT_BYTES } from './output-budget.ts'

interface Selection { path: string; symbol?: string; startLine?: number; endLine?: number }
interface Cursor { scope: string; selections: Selection[]; snapshot: string; index: number; offset: number; expires: number }
interface Item { index: number; path: string; snapshot: string; startLine: number; endLine: number; offset: number; end: number; total: number; text: string; complete: boolean }
export interface ReadManyPage { snapshot: string; total: number; items: Item[]; complete: boolean; nextCursor?: string }
const scopeOf = (exec?: ForgeExec) => JSON.stringify([path.resolve(workdirOf(exec)), exec?.agent?.session?.header?.id ?? null])
function selectionsOf(value: unknown): Selection[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error('files must contain 1–20 selections')
  return value.map((s: Selection) => {
    if (!s || typeof s.path !== 'string' || !s.path.trim() || s.path.length > 2048) throw new Error('each selection needs a path (max 2048 characters)')
    if (Object.keys(s).some(k => !['path', 'symbol', 'startLine', 'endLine'].includes(k))) throw new Error('unknown selection field')
    if (s.symbol !== undefined && (typeof s.symbol !== 'string' || !s.symbol.trim() || s.symbol.length > 512)) throw new Error('invalid symbol')
    for (const n of [s.startLine, s.endLine]) if (n !== undefined && (!Number.isSafeInteger(n) || n < 1)) throw new Error('line numbers must be positive integers')
    if (s.symbol && (s.startLine || s.endLine)) throw new Error('symbol and line range are mutually exclusive')
    if (s.endLine !== undefined && s.endLine < (s.startLine ?? 1)) throw new Error('endLine precedes startLine')
    return { path: s.path, ...(s.symbol ? { symbol: s.symbol } : {}), ...(s.startLine ? { startLine: s.startLine } : {}), ...(s.endLine ? { endLine: s.endLine } : {}) }
  })
}
export function createBatchReader() {
  const cursors = new Map<string, Cursor>()
  return {
    description: 'Read 1–20 explicit UTF-8 files, ranges or symbols. LF-normalized text; lossless UTF-16 fragments under a shared byte budget. Continue with cursor alone; source changes invalidate it. A single symbol uses files=[{path,symbol}]; plain single-file reads use read.',
    parameters: {
      files: { type: 'array', description: 'First page selections; paths are literal, including #.', items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true, description: 'Literal absolute or workspace-relative file.' },
        symbol: { type: 'string', description: 'Exact qualified symbol including its leading comment; excludes line range.' },
        startLine: { type: 'integer', description: 'First line, 1-based inclusive; default 1.' },
        endLine: { type: 'integer', description: 'Last line, inclusive; default EOF.' },
      } } },
      cursor: { type: 'string', description: 'Continue the same snapshot, without files. Expires in 30 minutes or on eviction.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_: unknown, p: ReadManyPage) => [{ type: 'text' as const, text:
      p.items.map(s => `${s.path} L${s.startLine}-${s.endLine} [${s.offset}:${s.end}/${s.total}]\n${s.text}`).join('\n')
      + `\n[${p.complete ? 'complete' : `incomplete; cursor=${p.nextCursor}`}; snapshot=${p.snapshot}]`,
    }] },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec?: ForgeExec): Promise<ReadManyPage> {
      if (Object.keys(args).some(k => !['files', 'cursor'].includes(k))) throw new Error('read accepts files or cursor only')
      exec?.signal?.throwIfAborted()
      for (const [key, state] of cursors) if (state.expires < Date.now()) cursors.delete(key)
      const scope = scopeOf(exec)
      let prior: Cursor | undefined
      if (args.cursor !== undefined) {
        if (typeof args.cursor !== 'string' || args.files !== undefined) throw new Error('continuation requires cursor alone')
        prior = cursors.get(args.cursor)
        if (!prior || prior.scope !== scope) throw new Error('unknown/expired read cursor; restart with files')
      }
      const selections = prior?.selections ?? selectionsOf(args.files)
      const sources = new Map<string, Awaited<ReturnType<typeof sourceRead>>>()
      let bytes = 0
      for (const selection of selections) {
        const file = path.resolve(workdirOf(exec), selection.path)
        if (sources.has(file)) continue
        const source = await sourceRead(file, exec)
        sources.set(file, source)
        bytes += source.bytes
        if (bytes > 16 * 1024 * 1024) throw new Error('batch exceeds 16 MiB input cap; narrow selections')
      }
      const snapshot = sha256(JSON.stringify([...sources].map(([file, s]) => [file, s.snapshot])))
      if (prior && snapshot !== prior.snapshot) throw new Error('read snapshot changed; restart with files (no continuation was returned)')
      let index = prior?.index ?? 0, offset = prior?.offset ?? 0, used = 0
      const items: Item[] = []
      while (index < selections.length && items.length < 20) {
        const selection = selections[index], source = sources.get(path.resolve(workdirOf(exec), selection.path))!
        const lines = source.text.split('\n')
        let startLine = selection.startLine ?? 1, endLine = Math.min(selection.endLine ?? lines.length, lines.length)
        if (selection.symbol) {
          const { symbol } = await sourceSymbol(source, selection.symbol)
          startLine = symbol.commentStartLine ?? symbol.startLine; endLine = symbol.endLine
        }
        if (startLine > lines.length) throw new Error(`startLine exceeds ${source.file}'s ${lines.length} lines`)
        const selected = lines.slice(startLine - 1, endLine).join('\n')
        const base = { index, path: source.file, snapshot: source.snapshot, startLine, endLine, offset, end: selected.length, total: selected.length, text: '', complete: true }
        const available = OUTPUT_CONTENT_BYTES - used - jsonBytes(base) - 32
        if (available < 16) { if (!items.length) throw new Error('selection identity exceeds output budget'); break }
        const fragment = outputFragment(selected, offset, available)
        const item = { ...base, text: fragment.text, end: fragment.end, complete: fragment.end === selected.length }
        items.push(item); used += jsonBytes(item) + 1
        if (!item.complete) { offset = fragment.end; break }
        index++; offset = 0
      }
      const complete = index === selections.length
      const result: ReadManyPage = { snapshot, total: selections.length, items, complete }
      if (!complete) {
        const nextCursor = randomBytes(18).toString('base64url')
        cursors.set(nextCursor, { scope, selections, snapshot, index, offset, expires: Date.now() + 30 * 60_000 })
        while (cursors.size > 128) cursors.delete(cursors.keys().next().value!)
        result.nextCursor = nextCursor
      }
      return boundedOutput(result, 'narrow files')
    },
  } as const
}
