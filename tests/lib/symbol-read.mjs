import { readFileSync } from 'node:fs'
import path from 'node:path'
import { outlineView } from './read-views.mjs'

/** Test helper for measuring a symbol-sized source window after AST lookup. */
export function symbolReader(createReadTool) {
  const outline = outlineView(createReadTool())
  return {
    async execute(args, exec) {
      let file = args.path
      let wanted = args.symbol
      const hash = typeof file === 'string' ? file.lastIndexOf('#') : -1
      if (!wanted && hash > 0) {
        wanted = file.slice(hash + 1)
        file = file.slice(0, hash)
      }
      if (typeof file !== 'string' || typeof wanted !== 'string' || wanted.trim() === '') return { error: 'path and symbol are required' }

      const parsed = await outline.execute({ path: file, scope: 'all' }, exec)
      if (parsed.error) return { error: parsed.error }
      let cursor = parsed.page.nextCursor
      while (cursor) {
        const next = await outline.execute({ path: file, scope: 'all', cursor }, exec)
        if (next.error) return { error: next.error }
        parsed.items.push(...next.items)
        cursor = next.page.nextCursor
      }
      const query = wanted.trim().replace(/::/g, '.')
      // Exact qualified addresses win outright: only when nothing carries the
      // full address does a bare simple name act as a filter. A union here
      // would let `N.Item` answer a query for top-level `Item`.
      const exact = parsed.items.filter((item) => item.qualifiedName.replace(/::/g, '.') === query)
      const symbols = exact.length > 0 ? exact : parsed.items.filter((item) => item.name === wanted.trim())
      if (symbols.length === 0) return { error: `symbol "${wanted}" not found` }
      const ordered = symbols.slice().sort((a, b) => a.startLine - b.startLine)
      let index = args.occurrence === undefined ? -1 : Number(args.occurrence) - 1
      if (index < 0 && args.line !== undefined) {
        index = ordered.reduce((best, item, i) => Math.abs(item.startLine - Number(args.line)) < Math.abs(ordered[best].startLine - Number(args.line)) ? i : best, 0)
      }
      if (index < 0 && ordered.length === 1) index = 0
      if (index < 0 || index >= ordered.length) return { error: `symbol "${wanted}" is ambiguous (${ordered.length} definitions) — candidates: ${ordered.map((item, i) => `#${i + 1} ${item.qualifiedName} L${item.startLine}`).join(', ')}` }

      const symbol = ordered[index]
      const absolute = path.isAbsolute(file) ? file : path.resolve(exec.agent.session.header.cwd, file)
      const source = readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
      const start = Math.max(1, (args.body ? symbol.startLine : symbol.commentStartLine ?? symbol.startLine) - Number(args.context ?? 0))
      const end = Math.min(source.length, symbol.endLine + Number(args.context ?? 0))
      return {
        file: absolute,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        startLine: start,
        endLine: end,
        declLine: symbol.startLine,
        occurrence: index + 1,
        text: source.slice(start - 1, end).join('\n'),
      }
    },
  }
}

export function singleSymbolView(result) {
  if (result?.error) return { error: result.error }
  const block = result?.blocks?.[0]
  if (block === undefined) return { error: 'symbol reads are provided by the built-in read' }
  return { file: block.file, text: block.text, kind: block.kind, startLine: 1, endLine: 1 }
}
