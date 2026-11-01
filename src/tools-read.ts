/** AST-based symbol outline and definition search. Source text stays with `read`. */
import { findDefinitions, outlineOf } from './tools-symbol.ts'
import type { AstWorkerPool } from './ast-pool.ts'
import { clampInt, type ForgeExec, type ToolFailure } from './core.ts'

const DEFINITIONS_LIMIT_DEFAULT = 50
const DEFINITIONS_LIMIT_MAX = 200
const VIEWS = ['outline', 'definitions'] as const
type ReadView = (typeof VIEWS)[number]

const SYMBOL_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    qualifiedName: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    startLine: { type: 'integer', required: true },
    endLine: { type: 'integer', required: true },
    commentStartLine: { type: 'integer' },
    level: { type: 'integer' },
    file: { type: 'string' },
    occurrence: { type: 'integer' },
    signature: { type: 'string' },
  },
} as const

function failure(error: string): ToolFailure {
  return { error }
}

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

function argumentProblem(args: Record<string, unknown>, view: ReadView): string | undefined {
  const allowed = view === 'outline'
    ? ['view', 'path', 'depth', 'kind']
    : ['view', 'path', 'symbol', 'glob', 'kind', 'limit']
  const unknown = Object.keys(args).find((key) => !allowed.includes(key))
  return unknown === undefined ? undefined : `parameter "${unknown}" is not used by view=${view}`
}

/** `ff_read` handles structure; built-in `read` handles source text. */
export function createReadTool(workers?: AstWorkerPool) {
  return {
    name: 'ff_symbols',
    description: 'Inspect code structure. view=outline lists definitions in one file; view=definitions finds exact symbol definitions across a search root. Use built-in read to inspect source, including file_path=<file>#<Symbol>.',
    parameters: {
      view: { type: 'string', enum: VIEWS, required: true, description: 'outline for one file, definitions to find a symbol.' },
      path: { type: 'string', description: 'outline: required file. definitions: optional search root; a file narrows the search to that file.' },
      symbol: { type: 'string', description: 'definitions: exact symbol name to find; Rust paths may use ::.' },
      glob: { type: 'string', description: 'definitions: optional file filter under the search root.' },
      depth: { type: 'integer', description: 'outline: maximum nesting depth; 1 lists top-level definitions.' },
      kind: { type: 'string', description: 'Comma-separated definition kinds, such as function,method.' },
      limit: { type: 'integer', description: `definitions: maximum results (default ${DEFINITIONS_LIMIT_DEFAULT}, max ${DEFINITIONS_LIMIT_MAX}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: SYMBOL_ITEM_SCHEMA },
          lang: { type: 'string' },
          stats: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args: { view?: string }, value: { items: Array<Record<string, unknown>>; lang?: string; stats?: string; note?: string }) => {
        if (args.view === 'outline') {
          if (value.items.length === 0) return text(`no symbols found${value.lang ? ` (${value.lang})` : ''}`)
          const lines = value.items.map((item) => {
            const pad = '  '.repeat(Number(item.level ?? 1) - 1)
            const first = item.commentStartLine ?? item.startLine
            return `${pad}${item.qualifiedName} (${item.kind}) L${first}-${item.endLine}`
          })
          if (value.note) lines.push(`[${value.note}]`)
          return text(lines.join('\n'))
        }
        if (value.items.length === 0) return text(`no definitions matched${value.stats ? ` (${value.stats})` : ''}`)
        const lines = value.items.map((item) =>
          `${item.file}#${item.qualifiedName} (${item.kind}) L${item.startLine}-${item.endLine}${Number(item.occurrence) > 1 ? ` #${item.occurrence}` : ''}`,
        )
        if (value.stats) lines.push(`[${value.stats}]`)
        if (value.note) lines.push(`[${value.note}]`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const view = args.view
      if (typeof view !== 'string' || !(VIEWS as readonly string[]).includes(view)) {
        return failure('view must be outline or definitions')
      }
      const invalid = argumentProblem(args, view as ReadView)
      if (invalid) return failure(invalid)

      if (view === 'outline') {
        const result = await outlineOf(exec, args.path, args.depth, args.kind)
        if ('error' in result) return result
        return {
          items: result.items,
          lang: result.lang,
          ...(result.partial ? { note: 'parse had errors; ranges are best-effort' } : {}),
        }
      }

      const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : ''
      if (symbol === '') return failure('view=definitions requires symbol')
      const limit = clampInt(args.limit, DEFINITIONS_LIMIT_DEFAULT, 1, DEFINITIONS_LIMIT_MAX)
      const result = await findDefinitions(exec, {
        name: symbol,
        path: args.path,
        glob: args.glob,
        kind: args.kind,
        limit,
      }, workers)
      if ('error' in result) return result
      return {
        items: result.items,
        stats: result.stats,
        ...(result.truncated ? { note: 'results truncated; narrow the root or file filter' } : {}),
      }
    },
  } as const
}
