/** AST-based symbol outline and definition search. Source text stays with `read`. */
import { findDefinitions, outlineOf } from './tools-symbol.ts'
import type { AstWorkerPool } from './ast-pool.ts'
import { clampInt, type ForgeExec, type ToolFailure } from './core.ts'
import { OutlineOutput, outlineQuery, type OutlinePage } from './outline-output.ts'

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
    ? ['view', 'path', 'depth', 'kind', 'scope', 'limit', 'cursor']
    : ['view', 'path', 'symbol', 'glob', 'kind', 'limit']
  const unknown = Object.keys(args).find((key) => !allowed.includes(key))
  return unknown === undefined ? undefined : `parameter "${unknown}" is not used by view=${view}`
}

/** `ff_read` handles structure; built-in `read` handles source text. */
export function createReadTool(workers?: AstWorkerPool) {
  const outline = new OutlineOutput()
  return {
    name: 'ff_symbols',
    description: 'Browse declarations and container members or locate exact symbol definitions. Outline pages stop below function/method bodies by default; changed source invalidates cursors. Known file and symbol: read file_path=<file>#<Symbol> directly.',
    parameters: {
      view: { type: 'string', enum: VIEWS, required: true, description: 'outline for one file, definitions to find a symbol.' },
      path: { type: 'string', description: 'outline: required file. definitions: optional search root; a file narrows the search to that file.' },
      symbol: { type: 'string', description: 'definitions: exact symbol name to find; Rust paths may use ::.' },
      glob: { type: 'string', description: 'definitions: optional file filter under the search root.' },
      depth: { type: 'integer', description: 'outline: maximum nesting depth; 1 lists top-level definitions.' },
      kind: { type: 'string', description: 'Comma-separated kinds, e.g. function,method. In outline implies scope=all unless scope is explicit.' },
      scope: { type: 'string', enum: ['declarations', 'all'], description: 'outline: default declarations stops below functions/methods; all traverses every extracted symbol.' },
      limit: { type: 'integer', description: `outline rows per page; definitions maximum results. Default ${DEFINITIONS_LIMIT_DEFAULT}, max ${DEFINITIONS_LIMIT_MAX}; outline byte budget may return fewer.` },
      cursor: { type: 'string', description: 'outline: same path/filters; limit must match or be omitted. Content-bound cursor expires after 30 minutes.' },
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
          page: {
            type: 'object', additionalProperties: false,
            properties: {
              path: { type: 'string', required: true }, snapshot: { type: 'string', required: true },
              filters: { type: 'object', required: true, additionalProperties: false, properties: {
                scope: { type: 'string', required: true, enum: ['declarations', 'all'] }, depth: { type: 'integer' }, kind: { type: 'string' },
              } },
              available: { type: 'integer', required: true }, total: { type: 'integer', required: true }, returned: { type: 'integer', required: true },
              offset: { type: 'integer', required: true }, complete: { type: 'boolean', required: true }, nextCursor: { type: 'string' },
            },
          },
        },
      },
      render: (args: { view?: string }, value: { items: Array<Record<string, unknown>>; lang?: string; stats?: string; note?: string; page?: OutlinePage }) => {
        if (args.view === 'outline') {
          const lines = value.items.map((item) => {
            const pad = '  '.repeat(Math.min(20, Math.max(0, Number(item.level ?? 1) - 1)))
            const first = item.commentStartLine ?? item.startLine
            return `${pad}${item.qualifiedName} ${item.kind} L${first}-${item.endLine}${Number(item.occurrence) > 1 ? ` #${item.occurrence}` : ''}`
          })
          if (value.items.length === 0) lines.push(`no symbols matched${value.lang ? ` (${value.lang})` : ''}`)
          if (value.page) {
            const p = value.page, f = p.filters
            lines.push(`[outline ${f.scope}${f.depth ? ` depth=${f.depth}` : ''}${f.kind ? ` kind=${f.kind}` : ''}; ${p.offset}-${p.offset + p.returned} of ${p.total} matched / ${p.available} extracted; ${p.complete ? 'complete' : `nextCursor=${p.nextCursor}`}]`)
          }
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
    // 两个视图的参数必须互斥：另一个视图的字段在本视图下只是补全产物，
    // 值是什么都不改变这一点；视图里根本没有的名字仍由 argumentProblem 拒绝。
    hygiene: {
      modeField: 'view',
      onlyIn: { symbol: ['definitions'], glob: ['definitions'], depth: ['outline'], scope: ['outline'], cursor: ['outline'] },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      // 视图专属字段的剔除在 defineForgeTool 的 hygiene 层完成；这里仍负责
      // 「视图里根本没有这个名字」的拒绝。
      const view = args.view
      if (typeof view !== 'string' || !(VIEWS as readonly string[]).includes(view)) {
        return failure('view must be outline or definitions')
      }
      const invalid = argumentProblem(args, view as ReadView)
      if (invalid) return failure(invalid)

      if (view === 'outline') {
        try {
          const query = outlineQuery(args)
          const result = await outlineOf(exec, args.path, query)
          return 'error' in result ? result : outline.page(result, query)
        } catch (cause) { return failure(cause instanceof Error ? cause.message : String(cause)) }
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
