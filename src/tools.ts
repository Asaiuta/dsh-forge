/**
 * dsh-forge tool definitions: plain factories over the FinderPool, wrapped by
 * the official defineTool() in the cordis glue (src/index.ts). Model-facing
 * strings are English; /forge-status human-facing text is zh-CN, following
 * the dsh-blackhole convention.
 *
 * Tool-surface shape decision (documented in README): three separate tools —
 * fffind / ffgrep / fff-multi-grep — rather than ProjectForge's one-tool-many-
 * commands dispatch. Per-tool descriptions give the model clearer selection
 * signals, which matters more than schema-token savings at this size.
 *
 * @module dsh-forge/tools
 */

import type { FileFinderApi, GrepMode, GrepResult } from '@ff-labs/fff-node'
import { attachEnclosingSymbols } from './tools-symbol.ts'
import { allStores, hasPendingTransaction, pruneOrphanedStores, gcStoreBlobs, purgeStore, statsFor, storeFor } from './ledger.ts'
import { canonicalWorkspace } from './projects.ts'
import { countTickets } from './tickets.ts'
import {
  CONTEXT_MAX,
  FILTER_MAX_EXTRA_PAGES,
  FIND_LIMIT_DEFAULT,
  FIND_LIMIT_MAX,
  GREP_LIMIT_DEFAULT,
  GREP_LIMIT_MAX,
  TIME_BUDGET_DEFAULT_MS,
  type FinderLease,
  type FinderPool,
  type ForgeExec,
  type FindItem,
  type GrepItem,
  type ToolFailure,
  clampInt,
  compileConstraintFilter,
  dataDir,
  isHomeDir,
  noteQueryHit,
  renderFindItems,
  renderGrepItems,
  shapeFindItem,
  shapeGrepItem,
  storeCursor,
  takeCursor,
  workdirOf,
  withFileLock,
} from './core.ts'
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'

function failure(error: string): { error: string } {
  return { error }
}

function isFailure<T>(value: T | ToolFailure): value is ToolFailure {
  return typeof (value as ToolFailure).error === 'string'
}

/** Resolve a `path` tool parameter against the session workspace. */
async function resolveScope(
  pool: FinderPool,
  workdir: string,
  rawPath: string | undefined,
): Promise<{ lease: FinderLease; prefixFilter?: (rel: string) => boolean } | ToolFailure> {
  if (!rawPath || rawPath.trim() === '') {
    const lease = await pool.main(workdir)
    if (isFailure(lease)) return lease
    return { lease }
  }
  const trimmed = rawPath.trim()
  const absolute = path.isAbsolute(trimmed) ? trimmed : path.resolve(workdir, trimmed)

  // Glob-style constraint: keep the main index, filter by glob on relative paths.
  if (/[*?{[]/.test(trimmed)) {
    const lease = await pool.main(workdir)
    if (isFailure(lease)) return lease
    const filter = compileConstraintFilter(trimmed)
    if (!filter) return failure(`could not parse constraint ${trimmed}`)
    return { lease, prefixFilter: filter }
  }

  let st: { isDirectory(): boolean; isFile(): boolean }
  try {
    st = statSync(absolute)
  } catch {
    return failure(`path not found: ${absolute}`)
  }
  if (st.isDirectory()) {
    // Inside the indexed workspace a subdirectory constraint still goes to an
    // aux finder: GrepOptions has no path scoping, and post-filtering a whole
    // tree burns the page budget on out-of-scope hits.
    const lease = await pool.aux(absolute)
    if (isFailure(lease)) return lease
    return { lease }
  }
  if (st.isFile()) {
    const fileName = path.basename(absolute)
    const lease = await pool.aux(path.dirname(absolute))
    if (isFailure(lease)) return lease
    return { lease, prefixFilter: (rel) => path.resolve(lease.basePath, rel) === absolute }
  }
  return failure(`unsupported path kind: ${absolute}`)
}

interface GrepCallOptions {
  mode: GrepMode
  beforeContext: number
  afterContext: number
  pageSize: number
  timeBudgetMs: number
}

function grepCallOptions(mode: string | undefined, context: number, limit: number, timeBudgetMs: number): GrepCallOptions {
  const resolvedMode: GrepMode = mode === 'regex' || mode === 'fuzzy' ? mode : 'plain'
  return {
    mode: resolvedMode,
    beforeContext: context,
    afterContext: context,
    pageSize: limit,
    timeBudgetMs,
  } as const
}

/** Shaped grep outcome — engine bookkeeping plus cursor id for the next page. */
interface GrepOutcome {
  items: GrepItem[]
  totalMatched: number
  totalFilesSearched: number
  filteredFileCount: number
  regexFallbackError?: string
  nextCursorId: string | null
  filteredFrom: number
}

/**
 * Run engine grep, applying an optional post-filter. When a filter is active
 * the cursor is advanced transparently (bounded) so the page the model sees
 * is actually filled with in-scope hits.
 */
function runGrep(
  lease: FinderLease,
  pattern: string,
  options: GrepCallOptions,
  cursorId: string | undefined,
  filter: ((rel: string) => boolean) | undefined,
): { value: GrepOutcome } | ToolFailure {
  const engineCursor = takeCursor(cursorId)
  let nextEngineCursor = engineCursor
  const collected: GrepItem[] = []
  let filteredFrom = 0
  let filesSearched = 0
  let eligibleFiles = 0
  let regexFallbackError: string | undefined

  for (let page = 0; page <= (filter ? FILTER_MAX_EXTRA_PAGES : 0); page++) {
    const result = lease.finder.grep(pattern, {
      ...options,
      cursor: nextEngineCursor,
      maxMatchesPerFile: 200,
      smartCase: true,
    })
    if (!result.ok) return failure(`fff grep failed: ${result.error}`)
    const value = result.value
    filesSearched += value.totalFilesSearched
    eligibleFiles = value.filteredFileCount
    if (value.regexFallbackError) regexFallbackError = value.regexFallbackError
    filteredFrom += value.items.length
    for (const match of value.items) {
      if (filter && !filter(match.relativePath)) continue
      collected.push(shapeGrepItem(match))
    }
    nextEngineCursor = value.nextCursor
    if (!value.nextCursor) break
    if (!filter) break
    if (collected.length >= options.pageSize) break
  }

  return {
    value: {
      items: collected,
      totalMatched: collected.length,
      totalFilesSearched: filesSearched,
      filteredFileCount: eligibleFiles,
      regexFallbackError,
      nextCursorId: nextEngineCursor ? storeCursor(nextEngineCursor) : null,
      filteredFrom,
    },
  } as const
}

const GREP_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file: { type: 'string', required: true },
    line: { type: 'integer', required: true },
    col: { type: 'integer', required: true },
    text: { type: 'string', required: true },
    git: { type: 'string', required: true },
    frecency: { type: 'number', required: true },
    in: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', required: true },
        startLine: { type: 'integer', required: true },
        endLine: { type: 'integer', required: true },
      },
    },
    context: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          line: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          before: { type: 'boolean', required: true },
        },
      },
    },
  },
} as const

/** ffgrep — SIMD content search in frecency order, no subprocess. */
export function createGrepTool(pool: FinderPool) {
  return {
    name: 'ffgrep',
    description:
      'Search workspace text, including references. For definitions use ff_find_symbol; for multiple literals use fff_multi_grep. ' +
      'Lowercase patterns ignore case. Warming/timeout results may be partial; paginate with cursor.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Nonempty search text.' },
      path: { type: 'string', description: 'Absolute/workspace-relative directory or file, or globs "*.ts !test/"; default workspace.' },
      mode: { type: 'string', enum: ['plain', 'regex', 'fuzzy'], description: 'Default plain: literal. regex: invalid expressions fall back to literal. fuzzy: tolerate typos.' },
      context: { type: 'integer', description: `Lines around hits, 0-${CONTEXT_MAX}; default 0.` },
      limit: { type: 'integer', description: `Target hits/page, default ${GREP_LIMIT_DEFAULT}, max ${GREP_LIMIT_MAX}; file boundaries may exceed it.` },
      cursor: { type: 'string', description: 'Previous nextCursor; keep search arguments unchanged.' },
      timeBudgetMs: { type: 'integer', description: `Search budget in ms, not a hard deadline; default ${TIME_BUDGET_DEFAULT_MS}, max 60000; 0 = unlimited.` },
      enclosing: { type: 'boolean', description: 'Add current enclosing symbol + range for ff_read_symbol; default false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: GREP_ITEM_SCHEMA },
          totalMatched: { type: 'integer', required: true },
          nextCursor: { type: 'string' },
          warming: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { items: GrepItem[]; totalMatched: number; warming?: boolean; note?: string }) => {
        if (value.items.length === 0) return text('no matches')
        const header: string[] = []
        if (value.warming) header.push('[index still warming — results may be partial]')
        if (value.note) header.push(`[${value.note}]`)
        return text(renderGrepItems(value.items, header))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (pattern === '') return failure('pattern is required')
      const mode = typeof args.mode === 'string' ? args.mode : undefined
      const context = clampInt(args.context, 0, 0, CONTEXT_MAX)
      const limit = clampInt(args.limit, GREP_LIMIT_DEFAULT, 1, GREP_LIMIT_MAX)
      const timeBudgetMs = clampInt(args.timeBudgetMs, TIME_BUDGET_DEFAULT_MS, 0, 60_000)
      const scope = await resolveScope(pool, workdirOf(exec), typeof args.path === 'string' ? args.path : undefined)
      if (isFailure(scope)) return scope
      const options = grepCallOptions(mode, context, limit, timeBudgetMs)
      const result = runGrep(scope.lease, pattern, options, typeof args.cursor === 'string' ? args.cursor : undefined, scope.prefixFilter)
      if (isFailure(result)) return result
      const value = result.value
      if (args.enclosing === true && value.items.length > 0) {
        await attachEnclosingSymbols(value.items, scope.lease.basePath)
      }
      const notes: string[] = []
      if (value.regexFallbackError) notes.push(`regex failed to compile (${value.regexFallbackError}); literal fallback used`)
      if (scope.prefixFilter && value.filteredFrom > value.items.length) {
        notes.push(`page filled from ${value.filteredFrom} raw hits before constraint filtering`)
      }
      // Query→file memory for the ledger→fff feedback: when ffedit later
      // writes one of these files, the (query, file) pair is replayed into
      // trackQuery. Main leases only — aux finders persist no learning data.
      if (!scope.lease.aux) {
        for (const item of value.items.slice(0, 20)) {
          noteQueryHit(path.resolve(scope.lease.basePath, item.file), pattern)
        }
      }
      return {
        items: value.items.map(item => ({ ...item, file: displayPath(workdirOf(exec), scope.lease.basePath, item.file) })),
        totalMatched: value.totalMatched,
        ...(value.nextCursorId ? { nextCursor: value.nextCursorId } : {}),
        ...(scope.lease.warming ? { warming: true } : {}),
        ...(notes.length ? { note: notes.join('; ') } : {}),
      }
    },
  } as const
}

/** fffind — fuzzy file-name search with cross-session frecency ranking. */
export function createFindTool(pool: FinderPool) {
  return {
    name: 'fffind',
    description:
      'Find workspace files by fuzzy name/path, tolerating typos. For file contents use ffgrep. Warming results may be partial.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Nonempty fuzzy query, e.g. "store.js" or "src/ config"; not a glob.' },
      path: { type: 'string', description: 'Absolute/workspace-relative directory; default workspace.' },
      limit: { type: 'integer', description: `Max files; default ${FIND_LIMIT_DEFAULT}, max ${FIND_LIMIT_MAX}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                name: { type: 'string', required: true },
                score: { type: 'number', required: true },
                match: { type: 'string', required: true },
                git: { type: 'string', required: true },
                frecency: { type: 'number', required: true },
                size: { type: 'integer', required: true },
                modified: { type: 'string', required: true },
              },
            },
          },
          totalMatched: { type: 'integer', required: true },
          warming: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: { items: FindItem[]; warming?: boolean }) => {
        if (value.items.length === 0) return text('no files matched')
        const header: string[] = []
        if (value.warming) header.push('[index still warming — results may be partial]')
        return text(renderFindItems(value.items, header))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (pattern === '') return failure('pattern is required')
      const limit = clampInt(args.limit, FIND_LIMIT_DEFAULT, 1, FIND_LIMIT_MAX)
      const rawPath = typeof args.path === 'string' ? args.path : undefined
      let lease: FinderLease | ToolFailure
      let filter: ((rel: string) => boolean) | undefined
      if (rawPath && rawPath.trim() !== '') {
        const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(workdirOf(exec), rawPath)
        try {
          const st = statSync(absolute)
          if (st.isDirectory()) {
            lease = await pool.aux(absolute)
          } else {
            lease = await pool.aux(path.dirname(absolute))
            filter = (rel) => path.resolve(path.dirname(absolute), rel) === absolute
          }
        } catch {
          return failure(`path not found: ${absolute}`)
        }
      } else {
        lease = await pool.main(workdirOf(exec))
      }
      if (isFailure(lease)) return lease
      const result = lease.finder.fileSearch(pattern, { pageSize: filter ? FIND_LIMIT_MAX : limit })
      if (!result.ok) return failure(`fff file search failed: ${result.error}`)
      let items = result.value.items.map((item, i) => shapeFindItem(item, result.value.scores[i]))
      if (filter) {
        items = items.filter((item) => filter(item.path))
        // An explicit file must not disappear merely because other files rank higher.
        for (let pageIndex = 1; !items.length && pageIndex * FIND_LIMIT_MAX < result.value.totalMatched; pageIndex++) {
          const page = lease.finder.fileSearch(pattern, { pageSize: FIND_LIMIT_MAX, pageIndex })
          if (!page.ok) return failure(`fff file search failed: ${page.error}`)
          items = page.value.items.map((item, i) => shapeFindItem(item, page.value.scores[i])).filter(item => filter!(item.path))
          if (!page.value.items.length) break
        }
      }
      if (!lease.aux) {
        for (const item of items.slice(0, 20)) {
          noteQueryHit(path.resolve(lease.basePath, item.path), pattern)
        }
      }
      return {
        items: items.map(item => ({ ...item, path: displayPath(workdirOf(exec), lease.basePath, item.path) })),
        totalMatched: filter ? items.length : result.value.totalMatched,
        ...(lease.warming ? { warming: true } : {}),
      }
    }
  } as const
}

/** fff-multi-grep — OR-logic multi-pattern content search (Aho-Corasick). */
export function createMultiGrepTool(pool: FinderPool) {
  return {
    name: 'fff_multi_grep',
    description:
      'Search workspace text for ANY of 2-16 literals (OR), e.g. old/new call sites. For one pattern, regex or fuzzy use ffgrep. ' +
      'Lowercase patterns ignore case. Warming/timeout results may be partial; paginate with cursor.',
    parameters: {
      patterns: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '2-16 nonempty literals; no regex.',
      },
      constraints: { type: 'string', description: 'Space-separated globs, e.g. "*.{ts,tsx} !test/"; default all indexed files.' },
      context: { type: 'integer', description: `Lines around hits, 0-${CONTEXT_MAX}; default 0.` },
      limit: { type: 'integer', description: `Target hits/page, default ${GREP_LIMIT_DEFAULT}, max ${GREP_LIMIT_MAX}; file boundaries may exceed it.` },
      cursor: { type: 'string', description: 'Previous nextCursor; keep search arguments unchanged.' },
      timeBudgetMs: { type: 'integer', description: `Search budget in ms, not a hard deadline; default ${TIME_BUDGET_DEFAULT_MS}, max 60000; 0 = unlimited.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: GREP_ITEM_SCHEMA },
          totalMatched: { type: 'integer', required: true },
          nextCursor: { type: 'string' },
          warming: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: { items: GrepItem[]; warming?: boolean }) => {
        if (value.items.length === 0) return text('no matches')
        const header: string[] = []
        if (value.warming) header.push('[index still warming — results may be partial]')
        return text(renderGrepItems(value.items, header))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const raw = args.patterns
      const patterns = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p !== '') : []
      if (patterns.length < 2) return failure('patterns requires at least 2 literal patterns (use ffgrep for a single pattern)')
      if (patterns.length > 16) return failure('patterns accepts at most 16 patterns')
      const context = clampInt(args.context, 0, 0, CONTEXT_MAX)
      const limit = clampInt(args.limit, GREP_LIMIT_DEFAULT, 1, GREP_LIMIT_MAX)
      const timeBudgetMs = clampInt(args.timeBudgetMs, TIME_BUDGET_DEFAULT_MS, 0, 60_000)
      const lease = await pool.main(workdirOf(exec))
      if (isFailure(lease)) return lease
      const result = lease.finder.multiGrep({
        patterns,
        constraints: typeof args.constraints === 'string' && args.constraints.trim() !== '' ? args.constraints : undefined,
        beforeContext: context,
        afterContext: context,
        pageSize: limit,
        maxMatchesPerFile: 200,
        smartCase: true,
        timeBudgetMs,
        cursor: takeCursor(typeof args.cursor === 'string' ? args.cursor : undefined),
      })
      if (!result.ok) return failure(`fff multi-grep failed: ${result.error}`)
      for (const item of result.value.items.slice(0, 20)) {
        noteQueryHit(path.resolve(lease.basePath, item.relativePath), patterns.join(' | '))
      }
      return {
        items: result.value.items.map(shapeGrepItem),
        totalMatched: result.value.totalMatched,
        ...(result.value.nextCursor ? { nextCursor: storeCursor(result.value.nextCursor) } : {}),
        ...(lease.warming ? { warming: true } : {}),
      }
    }
  } as const
}

// ---------------------------------------------------------------------------
// /forge-status command
// ---------------------------------------------------------------------------

export interface ForgeStatusInvocation extends ForgeExec {
  readonly rawInput: string
}

export interface ForgeStatusResult {
  readonly kind: 'success' | 'error'
  readonly text: string
}

/** /forge-status — engine health in zh-CN (desktop UI convention). */
export function createStatusCommand(pool: FinderPool) {
  return {
    name: 'forge-status',
    description: '查看 dsh-forge 检索引擎状态（索引根、文件数、frecency 库、git 集成）、施工台账与票据统计。',
    input: { hint: '[rescan] [prune] [purge [confirm=yes]]' },
    async handler(invocation: ForgeStatusInvocation): Promise<ForgeStatusResult> {
      const args = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const wantRescan = args.includes('rescan')
      const wantPrune = args.includes('prune')
      const wantPurge = args.includes('purge')
      const purgeConfirmed = args.includes('confirm=yes')
      const live = pool.live()

      // Ledger + ticket section — shown even before any finder has warmed.
      const ledgerLines: string[] = []
      if (wantPrune) {
        const removed = pruneOrphanedStores()
        ledgerLines.push(removed.length === 0
          ? 'prune：没有可清理的孤儿快照库。'
          : `prune：已清理 ${removed.length} 个孤儿快照库，释放 ${(removed.reduce((sum, r) => sum + r.bytes, 0) / 1024).toFixed(0)} KB。`)
        let gcBlobs = 0, gcBytes = 0
        for (const store of allStores()) {
          if (statsFor(store).orphan) continue
          for (const freed of gcStoreBlobs(store)) { gcBlobs++; gcBytes += freed.bytes }
        }
        ledgerLines.push(gcBlobs === 0
          ? 'prune：没有可回收的无引用快照 blob。'
          : `prune：已回收 ${gcBlobs} 个无引用 blob，释放 ${(gcBytes / 1024).toFixed(0)} KB。`)
      }
      if (wantPurge) {
        const cwd = invocation.agent?.session?.header?.cwd
        if (!cwd) {
          return { kind: 'error', text: 'purge：缺少当前命令会话的工作区，拒绝清除。' }
        } else {
          const target = storeFor(canonicalWorkspace(cwd))
          await withFileLock(target.dir, () => {
            invocation.signal?.throwIfAborted()
            if (!existsSync(target.ledgerFile)) {
              ledgerLines.push('purge：当前工作区没有施工台账，无可清除内容。')
            } else if (!purgeConfirmed) {
              const s = statsFor(target)
              ledgerLines.push(
                `purge（预览）：将永久清除 ${s.root} 的施工历史——${s.batches} 个批次、${s.blobs} 个快照（${(s.blobBytes / 1024).toFixed(0)} KB）。` +
                `工作区磁盘文件不受影响，且无法回退。确认请执行 /forge-status purge confirm=yes`,
              )
            } else {
              try {
                const purged = purgeStore(target)
                ledgerLines.push(`purge：已永久清除 ${purged.batches} 个批次与全部快照（释放 ${(purged.bytes / 1024).toFixed(0)} KB）。工作区磁盘文件未改动。`)
              } catch (cause) {
                ledgerLines.push(`purge：拒绝执行 — ${cause instanceof Error ? cause.message : String(cause)}`)
              }
            }
          })
        }
      }
      const stores = allStores()
      if (stores.length === 0) {
        ledgerLines.push('施工台账：尚无任何工作区快照（ffedit 首次写入后建立）。')
      } else {
        for (const store of stores) {
          const s = statsFor(store)
          ledgerLines.push(
            `施工台账 ${s.root}：批次 ${s.batches}，快照 ${s.blobs} 个（${(s.blobBytes / 1024).toFixed(0)} KB），在管文件 ${s.files}` +
            (s.orphan ? '，⚠ 工作区已不存在（/forge-status prune 可清理）' : '') +
            (hasPendingTransaction(store) ? '，⚠ 有写入中断的未完成事务（下次写操作将自动恢复；若被外部修改阻塞会显式报错）' : ''),
          )
        }
      }
      ledgerLines.push(`歧义票据：${countTickets()} 张存活（24h 过期）`)

      if (live.length === 0) {
        return {
          kind: 'success',
          text: [
            'dsh-forge：尚未创建任何索引。',
            '引擎在首次调用 fffind / ffgrep / fff_multi_grep 时按会话工作区懒启动，会话启动零开销。',
            ...ledgerLines,
            `数据目录：${dataDir()}（frecency 与查询史跨会话累积）`,
          ].join('\n'),
        }
      }
      const lines: string[] = []
      if (wantRescan) {
        for (const { finder, basePath, aux } of live) {
          if (aux) continue
          finder.scanFiles()
          lines.push(`已触发重扫：${basePath}`)
        }
      }
      for (const { finder, basePath, aux } of live) {
        const health = finder.healthCheck()
        if (!health.ok) {
          lines.push(`${aux ? '[辅助]' : '[主]'} ${basePath}：healthCheck 失败（${health.error}）`)
          continue
        }
        const h = health.value
        const pick = h.filePicker
        lines.push(
          `${aux ? '[辅助]' : '[主]'} ${pick.basePath ?? basePath}` +
          `：文件 ${pick.indexedFiles ?? '?'}，${pick.isScanning ? '扫描中' : '就绪'}` +
          `，git ${h.git.available ? (h.git.repositoryFound ? '已接入' : '未发现仓库') : '不可用'}` +
          `，frecency 库 ${h.frecency.initialized ? '已启用' : '未启用'}` +
          `，查询史库 ${h.queryTracker.initialized ? '已启用' : '未启用'}` +
          (isHomeDir(basePath) ? '（注意：正在索引用户主目录）' : ''),
        )
      }
      lines.push(`引擎版本：fff ${live.length > 0 ? safeVersion(live[0].finder) : '?'}`)
      lines.push(`数据目录：${dataDir()}`)
      lines.push('')
      lines.push(...ledgerLines)
      return { kind: 'success', text: lines.join('\n') }
    },
  } as const
}

function safeVersion(finder: FileFinderApi): string {
  const health = finder.healthCheck()
  return health.ok ? health.value.version : 'unknown'
}

/** Tiny helper mirroring dsh-ssh's text() output wrapper. */
function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

function displayPath(workdir: string, root: string, relative: string): string {
  const absolute = path.resolve(root, relative)
  const local = path.relative(workdir, absolute)
  return (local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)
    ? absolute : local).split(path.sep).join('/')
}
