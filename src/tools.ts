/**
 * dsh-forge tool definitions: plain factories over the FinderPool, wrapped by
 * the official defineTool() in the cordis glue (src/index.ts). Model-facing
 * strings are English; /forge-status human-facing text is zh-CN, following
 * the dsh-blackhole convention.
 *
 * Search surface: two focused tools, `fffind` and `ffgrep`. Status and
 * verification commands live in their own modules so search owns only search.
 *
 * @module dsh-forge/tools
 */

import type { GrepMode, GrepResult } from '@ff-labs/fff-node'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { explainAbsence, literalNeedle, walkForName, walkNewerThan, type AbsenceWalk } from './absence.ts'
import { overlaySnapshot, searchOverlay } from './overlay.ts'
import {
  CONTEXT_MAX,
  FILTER_MAX_EXTRA_PAGES,
  FIND_LIMIT_DEFAULT,
  FIND_LIMIT_MAX,
  GREP_LIMIT_DEFAULT,
  GREP_LIMIT_MAX,
  GREP_MAX_MATCHES_PER_FILE,
  TIME_BUDGET_DEFAULT_MS,
  type FinderLease,
  type FinderPool,
  type ForgeExec,
  type FindItem,
  type GrepItem,
  type ToolFailure,
  clampInt,
  compileConstraintFilter,
  noteQueryHit,
  renderFindItems,
  renderGrepItems,
  shapeFindItem,
  shapeGrepItem,
  storeCursor,
  takeCursor,
  weakNameMatch,
  workdirOf,
} from './core.ts'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { everythingSearch, type GlobalHit, type GlobalLookup } from './global-index.ts'

function failure(error: string): { error: string } {
  return { error }
}
function isFailure<T>(value: T | ToolFailure): value is ToolFailure {
  return typeof (value as ToolFailure).error === 'string'
}
function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

function displayPath(workdir: string, root: string, relative: string): string {
  const absolute = path.resolve(root, relative)
  const local = path.relative(workdir, absolute)
  return (local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)
    ? absolute : local).split(path.sep).join('/')
}

/** Resolve a `path` tool parameter against the session workspace. */
/**
 * Turn `path=` into a lease plus an optional filter.
 *
 * One index, one rule: **the workspace is the only long-lived index**. A `path`
 * inside it is answered by filtering that index, never by building a second one
 * over a subdirectory — the pages are already there, and a second finder was
 * both a memory leak and (in fff 0.11.0) a way to break every later finder in
 * the process. A `path` outside it borrows a one-shot finder from the pool,
 * which is size-capped and expires.
 */
async function resolveScope(
  pool: FinderPool,
  workdir: string,
  rawPath: string | undefined,
): Promise<{ lease: FinderLease; prefixFilter?: (rel: string) => boolean } | ToolFailure> {
  const main = await pool.main(workdir)
  if (isFailure(main)) return main
  const root = main.basePath
  if (!rawPath || rawPath.trim() === '') return { lease: main }

  const trimmed = rawPath.trim()
  // `path.resolve` is load-bearing, not cosmetic: the single-file branch below
  // compares a resolved path against this value with `===`. Keeping the
  // caller's separators meant `F:/x/file.ts` never equalled the engine's
  // `F:\x\file.ts`, so `path` pointing at one file matched nothing on Windows
  // — measured 8/8 deterministic. Normalizing here makes both spellings work.
  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed)

  // Glob-style constraint: keep the main index, filter by glob on relative paths.
  if (/[*?{[]/.test(trimmed)) {
    const filter = compileConstraintFilter(trimmed)
    if (!filter) return failure(`could not parse constraint ${trimmed}`)
    return { lease: main, prefixFilter: filter }
  }

  let st: { isDirectory(): boolean; isFile(): boolean }
  try {
    st = statSync(absolute)
  } catch {
    return failure(`path not found: ${absolute}`)
  }
  const inside = isInsideRoot(root, absolute)
  if (st.isDirectory()) {
    if (inside) {
      const filter = directoryFilter(root, absolute)
      return filter === undefined ? { lease: main } : { lease: main, prefixFilter: filter }
    }
    const borrowed = await pool.temporary(absolute, { retain: true })
    if (isFailure(borrowed)) return borrowed
    return { lease: borrowed }
  }
  if (st.isFile()) {
    if (inside) return { lease: main, prefixFilter: (rel) => path.resolve(root, rel) === absolute }
    const borrowed = await pool.temporary(path.dirname(absolute), { retain: true })
    if (isFailure(borrowed)) return borrowed
    return { lease: borrowed, prefixFilter: (rel) => path.resolve(borrowed.basePath, rel) === absolute }
  }
  return failure(`unsupported path kind: ${absolute}`)
}

/** True when `absolute` is `root` itself or sits below it. */
function isInsideRoot(root: string, absolute: string): boolean {
  const rel = path.relative(root, absolute)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Filter for "everything under this directory of the workspace", expressed in
 * the workspace index's relative paths. `undefined` means no filter is needed
 * (the directory *is* the root).
 */
function directoryFilter(root: string, absolute: string): ((rel: string) => boolean) | undefined {
  const prefix = path.relative(root, absolute).split(path.sep).join('/')
  if (prefix === '') return undefined
  return (rel) => rel === prefix || rel.startsWith(`${prefix}/`)
}

// ---------------------------------------------------------------------------
// Empty-page diagnostics
// ---------------------------------------------------------------------------

/** Extra wait granted to a finder still scanning when a page came back empty. */
const WARM_RETRY_MS = 4_000

/**
 * An empty page is ambiguous (see src/absence.ts). Attach the disk-level
 * explanation so "not visible to the index" is never presented as "not there".
 *
 * The `canList` probe is a real engine read, so the note only claims an
 * exclusion the index actually has for this scope.
 */
function absenceNote(
  scope: { lease: FinderLease },
  query: string,
  extra: { rescanned?: boolean; walk?: AbsenceWalk } = {},
): string | undefined {
  const canList = (segment: string): boolean => {
    try {
      const probe = scope.lease.finder.glob(`${segment}/**`, { pageSize: 1, pageIndex: 0 })
      return probe.ok && probe.value.items.length > 0
    } catch {
      return false
    }
  }
  return explainAbsence({
    scopeRoot: scope.lease.basePath,
    query,
    canList,
    ...(extra.rescanned === true ? { rescanned: true } : {}),
    ...(extra.walk === undefined ? {} : { walk: extra.walk }),
  })
}

/**
 * A scan that has not finished is a temporary empty page, not an answer. Wait
 * once for it: aux roots get a 5 s budget, and a root that was evicted from the
 * LRU pool and recreated can easily lose that race on a large tree.
 */
async function waitForWarm(scope: { lease: FinderLease }): Promise<void> {
  if (!scope.lease.warming) return
  try {
    await scope.lease.finder.waitForScan(WARM_RETRY_MS)
  } catch {
    // best-effort; a still-warming finder is reported through the warming flag
  }
  try { scope.lease.warming = scope.lease.finder.isScanning() } catch { scope.lease.warming = true }
}

/**
 * Ask the disk what the index will not answer, once per empty page.
 *
 * This is both the absence evidence and the staleness check, so it runs at most
 * once and its result is threaded to whichever of the two needs it.
 *
 * @returns `undefined` when the query has no checkable literal run.
 */
function diskProbe(lease: FinderLease, pattern: string): AbsenceWalk | undefined {
  // A glob, or a query with no 3-character literal run, is not something a name
  // walk can validate.
  const needle = literalNeedle(pattern)
  if (needle === '') return undefined
  try {
    return walkForName(lease.basePath, needle)
  } catch {
    return undefined
  }
}

/**
 * Could the index be missing a file created since it last scanned?
 *
 * The name path answers this with a disk walk that found the file by name. A
 * content search has no name to look for, so the equivalent evidence is
 * structural: a directory whose mtime is newer than the last scan is a directory
 * whose current shape the index has not seen. Creating or deleting a file bumps
 * its parent, which is the case that matters here — a file that exists but is
 * not indexed at all.
 *
 * No time window skips this check. Suppressing it was tried and reverted: the
 * empty page that prompts a write is followed within the same second by the
 * `ffgrep` that must see it, so any "we just scanned" window hides exactly the
 * query this exists to rescue. The walk is what an empty page already cost
 * before (the absence note ran one too); the rebuild it may trigger is the part
 * that is throttled.
 */
function contentIndexIsStale(lease: FinderLease): boolean {
  try {
    return walkNewerThan(lease.basePath, lease.scannedAt).newer.length > 0
  } catch {
    return false
  }
}

interface GrepCallOptions {
  mode: GrepMode
  beforeContext: number
  afterContext: number
  pageSize: number
  timeBudgetMs: number
  /**
   * The engine's `smartCase`, whose name is misleading: `true` is "insensitive
   * only for an all-lowercase query", `false` is "always sensitive". ffgrep
   * serves `true` (lowercase patterns ignore case, as its description says);
   * the built-in `grep` serves `false`, because ripgrep's default is a
   * case-sensitive regular expression and a takeover must not soften that.
   */
  smartCase: boolean
}

function grepCallOptions(mode: string | undefined, context: number, limit: number, timeBudgetMs: number, smartCase = true): GrepCallOptions {
  const resolvedMode: GrepMode = mode === 'regex' || mode === 'fuzzy' ? mode : 'plain'
  return {
    mode: resolvedMode,
    beforeContext: context,
    afterContext: context,
    pageSize: limit,
    timeBudgetMs,
    smartCase,
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
  /** Files whose matches were cut off by the per-file cap (see {@link GREP_MAX_MATCHES_PER_FILE}). */
  cappedFiles: string[]
}

/**
 * Run engine grep, applying an optional post-filter. When a filter is active
 * the cursor is advanced transparently (bounded) so the page the model sees
 * is actually filled with in-scope hits.
 */
function runGrep(
  lease: FinderLease,
  pattern: string | string[],
  options: GrepCallOptions,
  cursorId: string | undefined,
  filter: ((rel: string) => boolean) | undefined,
): { value: GrepOutcome } | ToolFailure {
  const engineCursor = takeCursor(cursorId)
  if (cursorId && engineCursor === null) return failure('engine cursor expired; restart without cursor')
  let nextEngineCursor = engineCursor
  const collected: GrepItem[] = []
  let filteredFrom = 0
  let filesSearched = 0
  let eligibleFiles = 0
  let regexFallbackError: string | undefined
  // Files that came back holding exactly the per-file cap: the engine stopped
  // collecting there and does not resume inside that file, so whatever else
  // matched it is not in this result and not behind the cursor either.
  const cappedFiles: string[] = []

  for (let page = 0; page <= (filter ? FILTER_MAX_EXTRA_PAGES : 0); page++) {
    const callOptions = {
      ...options,
      cursor: nextEngineCursor,
      maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
      smartCase: options.smartCase,
      // `enforceTimeBudget` is deliberately left at its engine default (false).
      // Turning it on makes `timeBudgetMs` apply *before* the first match too,
      // and the engine then reports the cut as a finished scan: measured on the
      // 5.8k-file tree, an absent token with `timeBudgetMs: 1, enforce: true`
      // returned 0 hits with `nextCursor: null` after opening 63 of 5667
      // candidate files. Nothing in `GrepResult` distinguishes that from a real
      // absence — there is no truncation field, and `totalFilesSearched` stops
      // at the files actually opened, so it cannot be compared to
      // `filteredFileCount` to infer a cut. Since "0 hits" is the one answer a
      // caller acts on by giving up, it must stay trustworthy.
    }
    const result = Array.isArray(pattern)
      ? lease.finder.multiGrep({ ...callOptions, patterns: pattern })
      : lease.finder.grep(pattern, callOptions)
    if (!result.ok) return failure(`fff grep failed: ${result.error}`)
    const value = result.value
    filesSearched += value.totalFilesSearched
    eligibleFiles = value.filteredFileCount
    if (value.regexFallbackError) regexFallbackError = value.regexFallbackError
    filteredFrom += value.items.length
    const perFile = new Map<string, number>()
    for (const match of value.items) {
      perFile.set(match.relativePath, (perFile.get(match.relativePath) ?? 0) + 1)
      if (filter && !filter(match.relativePath)) continue
      collected.push(shapeGrepItem(match))
    }
    for (const [file, count] of perFile) {
      if (count >= GREP_MAX_MATCHES_PER_FILE && !cappedFiles.includes(file)) cappedFiles.push(file)
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
      cappedFiles,
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

/**
 * ffgrep's surface: the two operations the built-in grep cannot express.
 *
 * Plain and regex search belong to the built-in `grep` — it is always present,
 * it owns the host's render/spill/timeout contract, and duplicating its modes
 * here only buys the model a choice it does not need. What is left is fuzzy
 * content search and 2-16 literals OR-matched in one pass.
 */
const FORGE_GREP_PARAMETERS: ParameterSchemaSpec = {
  pattern: { type: 'string', description: 'One nonempty fuzzy search text; use this for typos or frecency-ranked content search.' },
  patterns: { type: 'array', items: { type: 'string' }, description: '2-16 nonempty literals, OR-matched in one pass.' },
  path: { type: 'string', description: 'Directory or file, absolute or workspace-relative, default workspace.' },
  context: { type: 'integer', description: `Lines around each hit, 0-${CONTEXT_MAX}; positive context forces literal matching; default 0.` },
  limit: { type: 'integer', description: `Hits per page (default ${GREP_LIMIT_DEFAULT}, max ${GREP_LIMIT_MAX}).` },
  cursor: { type: 'string', description: 'Previous nextCursor; keep search arguments unchanged.' },
}

/** ffgrep — fuzzy and multi-literal content search in frecency order, no subprocess. */
export function createGrepTool(pool: FinderPool) {
  const pages = new Map<string, { key: string; finder: FinderLease['finder']; outcome: GrepOutcome; shadowed: Set<string>; overlayIdentity: string; bytes: number; at: number }>()
  const pageBudget = 8 * 1024 * 1024
  return {
    name: 'ff_grep',
    description: 'Fuzzy content search (typos tolerated, frecency-ranked) and 2-16 literal patterns in one OR pass. '
      + 'For plain or regex searches use the built-in grep. '
      + 'Pass path at any directory and the engine re-roots onto it — node_modules, another drive and another checkout included. '
      + 'For definitions use ff_symbols view=definitions. Lowercase patterns ignore case; positive context and non-ASCII queries use literal matching. Warming pages may be partial; paginate with cursor.',
    parameters: FORGE_GREP_PARAMETERS,
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
        // Headers first, then the empty case — see renderGlobPage for why.
        if (value.items.length === 0) {
          const header: string[] = []
          // A scanning finder has no answer yet. Printing "no matches" under
          // the sentence that says the page is not an answer is a contradiction
          // the caller has to resolve; emit only the fact that nothing is known.
          if (value.warming) {
            header.push('[index still scanning — an empty page here is not an answer; retry]')
            if (value.note) header.push(`[${value.note}]`)
            return text(header.join('\n'))
          }
          if (value.note) header.push(`[${value.note}]`)
          return text([...header, 'no matches'].join('\n'))
        }
        const header: string[] = []
        if (value.warming) header.push('[index still warming — results may be partial]')
        if (value.note) header.push(`[${value.note}]`)
        return text(renderGrepItems(value.items, header))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      const patterns = Array.isArray(args.patterns)
        ? args.patterns.filter((p): p is string => typeof p === 'string' && p !== '')
        : []
      if (pattern !== '' && patterns.length > 0) return failure('provide either pattern or patterns, not both')
      if (pattern === '' && patterns.length === 0) return failure('pattern is required (or patterns with 2-16 literals)')
      // Neither key is in the schema. They are refused rather than ignored so a
      // caller that learned them from an older surface is told where the
      // built-in already answers: plain/regex search, and symbol attachment.
      if (args.mode !== undefined) return failure('no mode: use the built-in grep for plain or regex search')
      if (args.enclosing !== undefined) return failure('does not attach symbols; use ff_symbols for structure')
      const context = clampInt(args.context, 0, 0, CONTEXT_MAX)
      // Fuzzy is the default because a typo is what this tool is for, but two
      // requests override it, both because fuzzy cannot serve them and would
      // answer something else without saying so:
      //
      // - A non-ASCII query: fff 0.11.0's fuzzy matcher returns nothing at all
      //   for CJK (measured: "中文标记" → 0 hits, the same text as a literal →
      //   1), and subsequence matching across ideographs is not a useful answer
      //   anyway.
      // - `context`: fuzzy hits carry no context lines at all (measured: the
      //   same putBlob call returns contextBefore/After length 0 in fuzzy, 2 in
      //   plain). Asking for context is asking to see the lines around a match,
      //   so a page without them is a failed answer — run the literal match the
      //   caller is clearly describing.
      const mode: GrepMode | undefined = patterns.length === 0
        ? (/[^\x00-\x7F]/.test(pattern) || context > 0 ? 'plain' : 'fuzzy')
        : undefined
      // Multi-literal OR mode. Absorbed from the former fff_multi_grep: same
      // engine call, same page/cursor contract, so a caller that used
      // `patterns` keeps working — it just has one fewer tool to choose from.
      if (patterns.length === 1) return failure('patterns requires at least 2 literals (use pattern for a single one)')
      if (patterns.length > 16) return failure('patterns accepts at most 16 patterns')
      const query = patterns.length > 0 ? patterns : pattern
      const limit = clampInt(args.limit, GREP_LIMIT_DEFAULT, 1, GREP_LIMIT_MAX)
      const timeBudgetMs = TIME_BUDGET_DEFAULT_MS
      const scope = await resolveScope(pool, workdirOf(exec), typeof args.path === 'string' ? args.path : undefined)
      if (isFailure(scope)) return scope
      try {
      const options = grepCallOptions(mode, context, limit, timeBudgetMs)
      const overlay = overlaySnapshot(scope.lease.basePath)
      const key = JSON.stringify([workdirOf(exec), scope.lease.basePath, args.path ?? null, query, context, limit])
      const cursor = typeof args.cursor === 'string' ? args.cursor : ''
      const saved = cursor ? pages.get(cursor) : undefined
      if (cursor && (!saved || saved.key !== key || saved.finder !== scope.lease.finder || saved.overlayIdentity !== overlay.identity || Date.now() - saved.at > 300_000)) {
        return failure('cursor expired or belongs to another query/index; restart without cursor')
      }
      const buffered = saved && saved.outcome.items.length > 0
      const result = buffered ? { value: saved.outcome }
        : runGrep(scope.lease, query, options, saved?.outcome.nextCursorId ?? undefined, scope.prefixFilter)
      if (isFailure(result)) return result
      let value = result.value
      // Files committed by this process are authoritative: the index still holds
      // their pre-write content (it needs a 2.3 s rescan or a 3.4-4.3 s watcher
      // round trip to notice, and ff exposes no per-file rebuild). So drop index
      // hits under those paths — keeping them would print a deleted line next to
      // its replacement — and answer for them from the bytes just written.
      const shadowed = saved?.shadowed ?? overlay.shadowed
      let liveHits = 0
      const withLive = (outcome: typeof value, liveMode: GrepMode): typeof value => {
        liveHits = 0
        if (buffered) return outcome
        const kept = outcome.items.filter((item) => !shadowed.has(item.file))
        const files = overlay.files.filter(file => !scope.prefixFilter || scope.prefixFilter(file.rel))
        const live = saved ? [] : searchOverlay(files, query, {
          mode: Array.isArray(query) ? 'plain' : liveMode,
          smartCase: options.smartCase,
          context,
          limit: Number.MAX_SAFE_INTEGER,
        })
        liveHits = live.length
        return { ...outcome, items: [...live, ...kept], totalMatched: live.length + kept.length }
      }
      value = withLive(value, options.mode)

      const paginating = typeof args.cursor === 'string' && args.cursor.trim() !== ''
      const notes: string[] = []
      // An empty page gets the same treatment as the glob page: wait out a scan that
      // is still running, then say what the disk holds if it is still empty.
      if (value.items.length === 0 && !paginating) {
        await waitForWarm(scope)
        if (value.items.length === 0) {
          const retry = runGrep(scope.lease, query, options, undefined, scope.prefixFilter)
          if (!isFailure(retry)) value = withLive(retry.value, options.mode)
        }
        if (value.items.length === 0) {
          // Two different empty pages, and they need opposite advice.
          //
          // If the index did hand back hits and the `path=` constraint dropped
          // all of them, the answer is "your constraint is too narrow". Running
          // a disk walk here would instead say something about a *name*, which
          // is not the question a content search asked.
          const outside = value.filteredFrom
          if (outside > 0) {
            notes.push(`${outside} line(s) matched outside path="${String(args.path ?? '')}" — widen or drop path to see them`)
          } else if (contentIndexIsStale(scope.lease) && await pool.rescan(scope.lease)) {
            // The index was demonstrably behind (a directory changed after the
            // last scan), so the empty page was not an answer. Retry once.
            const retry = runGrep(scope.lease, query, options, undefined, scope.prefixFilter)
            if (!isFailure(retry)) value = withLive(retry.value, options.mode)
          }
        }
      }
      if (value.regexFallbackError) notes.push(`regex failed to compile (${value.regexFallbackError}); literal fallback used`)
      // The engine stops collecting inside a file at the per-file cap and never
      // resumes it — `nextCursor` skips to the following file. So a capped file
      // is an incomplete answer that looks complete; name it, because "read the
      // file instead / narrow the pattern" is the only way to see the rest.
      if (value.cappedFiles.length > 0) {
        const shown = value.cappedFiles.slice(0, 3).map(file => `"${file}"`).join(', ')
        const more = value.cappedFiles.length > 3 ? ` and ${value.cappedFiles.length - 3} more file(s)` : ''
        notes.push(`${shown}${more} at the ${GREP_MAX_MATCHES_PER_FILE}-per-file cap — rest not paged; narrow the pattern or read the file`)
      }
      // Never let a live answer pass as an indexed one: the two disagree for a
      // few seconds, and the model is the one who decides whether to trust it.
      if (liveHits > 0) {
        notes.push(`${liveHits} hit(s) come from live content of file(s) written by this session — the index has not caught up yet`)
      }
      if (scope.prefixFilter && value.filteredFrom > value.items.length) {
        notes.push(`page filled from ${value.filteredFrom} raw hits before constraint filtering`)
      }
      const shown = value.items.slice(0, limit)
      const rest = value.items.slice(limit)
      let nextCursor: string | undefined
      if (rest.length > 0 || value.nextCursorId) {
        const outcome = { ...value, items: rest, totalMatched: rest.length }
        const bytes = Buffer.byteLength(JSON.stringify(outcome))
        if (bytes > pageBudget) return failure('search page exceeds the 8 MiB cursor budget; narrow path or pattern')
        nextCursor = randomUUID()
        pages.set(nextCursor, { key, finder: scope.lease.finder, outcome, shadowed, overlayIdentity: overlay.identity, bytes, at: Date.now() })
        let used = 0
        for (const page of pages.values()) used += page.bytes
        while (pages.size > 200 || used > pageBudget) {
          const oldest = pages.keys().next().value!
          used -= pages.get(oldest)!.bytes
          pages.delete(oldest)
        }
      }
      // Query→file memory for the ledger→fff feedback: when ffedit later
      // writes one of these files, the (query, file) pair is replayed into
      // trackQuery. Main leases only — aux finders persist no learning data.
      if (!scope.lease.temporary) {
        for (const item of shown.slice(0, 20)) {
          noteQueryHit(path.resolve(scope.lease.basePath, item.file), Array.isArray(query) ? query.join(' | ') : query)
        }
      }
      return {
        items: shown.map(item => ({ ...item, file: displayPath(workdirOf(exec), scope.lease.basePath, item.file) })),
        totalMatched: shown.length,
        ...(nextCursor ? { nextCursor } : {}),
        ...(scope.lease.warming ? { warming: true } : {}),
        ...(notes.length ? { note: notes.join('; ') } : {}),
      }
      } finally { scope.lease.release?.() }
    },
  } as const
}

// ---------------------------------------------------------------------------
// fffind — fuzzy file-name search; path patterns belong to the built-in glob
// ---------------------------------------------------------------------------

/**
 * One row of a fuzzy name page. Every field is filled: the ranked fields exist
 * because this is a fuzzy answer, where "how well did it match" is part of the
 * result rather than decoration.
 */
const FIND_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    size: { type: 'integer', required: true },
    modified: { type: 'string', required: true },
    git: { type: 'string', required: true },
    name: { type: 'string' },
    score: { type: 'number' },
    match: { type: 'string' },
    frecency: { type: 'number' },
  },
} as const

interface FindRenderValue {
  items: FindItem[]
  totalMatched?: number
  warming?: boolean
  note?: string
}

/**
 * The built-in glob tool takes shell patterns, so models habitually paste globs
 * into the fuzzy name search. Say so even when fuzzy hits exist — a
 * plausible-looking coincidence is worse than zero hits. Post-merge the steer
 * stays *inside* this tool, which is the point of folding the two together.
 */
const GLOB_LOOKING_PATTERN_NOTE =
  '[pattern looks like a glob — use the built-in glob for path patterns; fffind only matches names fuzzily]'

function renderNamePage(args: unknown, value: FindRenderValue): Array<{ type: 'text'; text: string }> {
  // Headers first, then the empty case — see renderGlobPage for why.
  if (value.items.length === 0) {
    if (value.warming) {
      // Nothing is known yet, so nothing may be claimed. "no files matched"
      // under a line that calls the page inconclusive is read as an answer.
      const header = ['[index still scanning — an empty page here is not an answer; retry]']
      if (value.note) header.push(`[${value.note}]`)
      return text(header.join('\n'))
    }
    const header: string[] = []
    // A name search only answers a name question. Say so when the query hit no
    // file name at all, rather than letting one fuzzy coincidence read as a hit
    // — a real session took such a result at face value and dropped the tool
    // for the rest of the run (see core.ts weakNameMatch).
    const query = typeof (args as { pattern?: unknown } | undefined)?.pattern === 'string'
      ? (args as { pattern: string }).pattern
      : ''
    if (query !== '' && /[*?\[]/.test(query)) header.push(GLOB_LOOKING_PATTERN_NOTE)
    if (value.note) header.push(`[${value.note}]`)
    return text([...header, 'no files matched'].join('\n'))
  }
  const header: string[] = []
  if (value.warming) header.push('[index still warming — results may be partial]')
  const items = value.items as FindItem[]
  const pattern = typeof (args as { pattern?: unknown } | undefined)?.pattern === 'string'
    ? (args as { pattern: string }).pattern
    : ''
  // A name search only answers a name question — see core.ts weakNameMatch.
  if (weakNameMatch(pattern, items)) {
    header.push(`[no file name contains "${pattern}" — fuzzy coincidences only. For file contents, symbols or config values use ff_grep.]`)
  }
  if (/[*?\[]/.test(pattern)) header.push(GLOB_LOOKING_PATTERN_NOTE)
  // The cap is invisible otherwise: the caller cannot tell a complete result
  // set from a truncated one.
  if (typeof value.totalMatched === 'number' && value.totalMatched > items.length) {
    header.push(`[showing ${items.length} of ${value.totalMatched} name matches]`)
  }
  if (value.note) header.push(`[${value.note}]`)
  return text(renderFindItems(items, header))
}

/** Fuzzy file-name search, ranked by match score and frecency. */
async function nameSearch(
  pool: FinderPool,
  args: Record<string, unknown>,
  pattern: string,
  exec: ForgeExec | undefined,
  globalSearch: typeof everythingSearch,
) {
  const limit = clampInt(args.limit, FIND_LIMIT_DEFAULT, 1, FIND_LIMIT_MAX)
  const workdir = workdirOf(exec)
  // Inside the workspace fff is already warm, and it is the only finder that
  // honours .gitignore — so the machine index answers first only when the
  // target root is outside the workspace (where fff has to cold-scan anyway),
  // or when the caller explicitly opted in.
  const preferGlobal = outsideWorkspace(args.path, workdir) || globalIndexMode() === 'everything'
  let fallbackNote: string | undefined
  if (preferGlobal) {
    const global = await globalLookup(pattern, args.path, workdir, limit, globalSearch)
    if (global.status === 'hit') {
      return {
        items: global.hits.map((hit) => globalItem(hit, workdir)),
        totalMatched: global.hits.length,
      }
    }
    fallbackNote = global.status === 'miss'
      ? 'everything: no literal filename hit'
      : global.status === 'unavailable' ? `everything unavailable: ${global.reason}` : undefined
  }
  // fffind used to resolve `path` itself, duplicating resolveScope — including
  // its Windows separator bug. One resolver, one fix.
  const scope = await resolveScope(pool, workdir, typeof args.path === 'string' ? args.path : undefined)
  if (isFailure(scope)) return scope
  try {
  const lease = scope.lease
  const filter = scope.prefixFilter
  const result = lease.finder.fileSearch(pattern, { pageSize: filter ? FIND_LIMIT_MAX : limit })
  if (!result.ok) return failure(`fff file search failed: ${result.error}`)
  let items = result.value.items.map((item, i) => shapeFindItem(item, result.value.scores[i]))
  // How many names the index actually offered, before the `path=` constraint
  // was applied — the difference between "no such file" and "not under that
  // path" decides which note is honest below.
  let offered = result.value.items.length
  if (filter) {
    items = items.filter((item) => filter(item.path))
    // An explicit file must not disappear merely because other files rank higher.
    for (let pageIndex = 1; items.length < limit && pageIndex * FIND_LIMIT_MAX < result.value.totalMatched; pageIndex++) {
      const page = lease.finder.fileSearch(pattern, { pageSize: FIND_LIMIT_MAX, pageIndex })
      if (!page.ok) return failure(`fff file search failed: ${page.error}`)
      offered += page.value.items.length
      items.push(...page.value.items.map((item, i) => shapeFindItem(item, page.value.scores[i])).filter(item => filter!(item.path)))
      if (!page.value.items.length) break
    }
  }
  let note: string | undefined = fallbackNote
  if (items.length === 0) {
    await waitForWarm(scope)
    if (items.length === 0) {
      const retry = lease.finder.fileSearch(pattern, { pageSize: filter ? FIND_LIMIT_MAX : limit })
      if (retry.ok) {
        offered = retry.value.items.length
        items = retry.value.items
          .map((item, i) => shapeFindItem(item, retry.value.scores[i]))
          .filter(item => filter === undefined || filter(item.path))
      }
    }
    // An empty page can mean the index is *behind* rather than the name being
    // absent. One disk walk answers both questions: if it names a file, the
    // index is stale and gets rebuilt; if it names nothing, it is already the
    // evidence the absence note needs.
    let rescanned = false
    let walk: AbsenceWalk | undefined
    if (items.length === 0 && !lease.warming) {
      walk = diskProbe(lease, pattern)
      // Directory hits are not evidence: name search reports files, and the
      // note already answers a directory with the `path=` that opens it.
      if (walk !== undefined && walk.hits.some((hit) => !hit.dir)) {
        rescanned = await pool.rescan(lease)
        if (rescanned) {
          const again = lease.finder.fileSearch(pattern, { pageSize: filter ? FIND_LIMIT_MAX : limit })
          if (again.ok) {
            offered = again.value.items.length
            items = again.value.items
              .map((item, i) => shapeFindItem(item, again.value.scores[i]))
              .filter(item => filter === undefined || filter(item.path))
          }
        }
      }
    }
    if (items.length === 0) {
      // Same split as ffgrep: a name the index returned but the constraint
      // dropped is not an absence on disk, and the disk walk would mislabel it.
      note = joinNotes(fallbackNote, filter !== undefined && offered > 0
        ? `${offered} name match(es) fell outside path="${String(args.path ?? '')}" — widen or drop path to see them`
        // The walk costs up to 400 ms and would explain a page that is not
        // final yet; a scanning finder gets the retry header instead.
        : lease.warming ? undefined
          : absenceNote(scope, pattern, { rescanned, ...(walk === undefined ? {} : { walk }) }))
    }
  }
  // A weak fuzzy page is the signal to ask the machine index: this is exactly
  // the shape (six scattered-subsequence rows, not one of them containing the
  // query) that made a caller believe a name existed under the wrong root.
  // Only inside the workspace — the outside-root case already asked first.
  //
  // The machine index *annotates* this page, it does not replace it. Replacing
  // was measured and reverted: a two-letter-off abbreviation is a legitimate
  // fuzzy query (`utls` → `utils.py`), and a literal backend answers it with
  // every unrelated path that happens to contain the substring (`gnutls/`),
  // which buries the file the caller wanted. fff's ranking is the better
  // answer; what it lacks is the *doubt signal*, so the note carries both.
  if (!preferGlobal && items.length > 0 && globalIndexMode() !== 'off'
    && !rootNameMatch(pattern, lease.basePath) && weakNameMatch(pattern, items)) {
    const escalated = await globalLookup(pattern, args.path, workdir, limit, globalSearch, true)
    const hint = escalated.status === 'hit'
      ? `; machine index: ${escalated.hits.slice(0, 2).map((hit) => clipPath(hit.path, 72)).join(', ')}`
      : ''
    note = joinNotes(
      note,
      `[fuzzy only — none of these names contains "${pattern}"${hint}]`,
    )
  }
  if (!lease.temporary) {
    for (const item of items.slice(0, 20)) {
      noteQueryHit(path.resolve(lease.basePath, item.path), pattern)
    }
  }
  return {
    items: items.slice(0, limit).map(item => ({ ...item, path: displayPath(workdirOf(exec), lease.basePath, item.path) })),
    totalMatched: filter ? items.length : result.value.totalMatched,
    ...(lease.warming ? { warming: true } : {}),
    ...(note ? { note } : {}),
  }
  } finally { scope.lease.release?.() }
}
/**
 * True when the query is (part of) the root's own name.
 *
 * `weakNameMatch` decides "no returned path contains the query" from *relative*
 * paths, and those have the root stripped: asking for `dsh-forge` inside
 * `D:\AI\dsh-plugins\dsh-forge` returned eleven `docs/forge-*.md` rows reachable
 * only as fuzzy matches, so the detector called a correct answer a coincidence
 * and offered a machine-index hint instead. The root name is the one literal
 * occurrence the page cannot show, so it has to be checked here.
 */
function rootNameMatch(query: string, basePath: string): boolean {
  const root = path.basename(basePath).toLowerCase()
  const needle = query.trim().toLowerCase()
  return root !== '' && needle !== '' && (root.includes(needle) || needle.includes(root))
}

function joinNotes(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part !== '')
  return kept.length === 0 ? undefined : kept.join('; ')
}

/**
 * Shorten a path for a one-line note, keeping the tail (the part that names the
 * thing). A note is a hint, not a result row — the full path is one `fffind`
 * away, and a truncated head is what makes the tail readable.
 */
function clipPath(value: string, max: number): string {
  const flat = value.replace(/[\\/]+/g, '/')
  if (flat.length <= max) return flat
  return `…${flat.slice(flat.length - max + 1)}`
}

/** `auto` (default) | `everything` (opt-in, announce failures) | `off`. */
function globalIndexMode(): string {
  return (process.env.FORGE_GLOBAL_INDEX ?? 'auto').trim().toLowerCase()
}

/** True when `path` names a directory outside the session workspace. */
function outsideWorkspace(rawPath: unknown, workdir: string): boolean {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return false
  return !isInsideRoot(workdir, path.resolve(workdir, rawPath.trim()))
}

/**
 * The directory the machine index should be constrained to, or `undefined` for
 * the workspace. `null` means "do not use the machine index at all" — a `path`
 * that points at one file is fff's job (it has the exact-name filter).
 */
function globalRoot(rawPath: unknown, workdir: string): string | undefined | null {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return workdir
  const absolute = path.resolve(workdir, rawPath.trim())
  try {
    return statSync(absolute).isDirectory() ? absolute : null
  } catch {
    return null
  }
}

/** Machine-index hits, shaped like fff's rows so one renderer serves both. */
function globalItem(hit: GlobalHit, workdir: string): FindItem {
  const absolute = hit.path.replace(/[\\/]+$/, '')
  const local = path.relative(workdir, absolute)
  const shown = (local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)
    ? absolute : local).split(path.sep).join('/')
  return {
    path: hit.isDirectory ? `${shown}/` : shown,
    name: path.basename(absolute),
    score: 0,
    match: 'everything',
    git: '',
    frecency: 0,
    size: hit.size,
    modified: hit.modified,
  }
}

type GlobalGate = GlobalLookup | { status: 'skip' }

/**
 * Decide whether the literal backend may answer this query, then ask it.
 *
 * Only a **literal name** is eligible: globs and brace lists are fff's, and a
 * query shorter than two characters would turn a machine-wide index into a
 * dump. `FORGE_GLOBAL_INDEX=off` disables it; `everything` turns "binary or
 * service missing" into a visible note instead of a silent fallback.
 */
async function globalLookup(
  pattern: string,
  rawPath: unknown,
  workdir: string,
  limit: number,
  search: typeof everythingSearch,
  machineWide = false,
): Promise<GlobalGate> {
  const mode = globalIndexMode()
  if (mode === 'off' || pattern.trim().length < 2) return { status: 'skip' }
  if (/[*?[\]{}]/.test(pattern)) return { status: 'skip' }
  // Escalation is the opposite question — "this name is nowhere under this
  // root, where is it?" — so it must not re-apply the same constraint.
  const candidate = machineWide ? undefined : globalRoot(rawPath, workdir)
  if (candidate === null) return { status: 'skip' }
  const root: string | undefined = candidate
  const lookup = await search(pattern, {
    root,
    limit,
    mode: mode === 'everything' ? 'everything' : 'auto',
    esPath: process.env.FORGE_ES_PATH,
  })
  if (lookup.status !== 'unavailable') return lookup
  // Auto mode on a machine without Everything (or off Windows) is the normal
  // case, not an event worth a note on every single query.
  return mode === 'everything' ? lookup : { status: 'skip' }
}

/**
 * fffind's surface: the typo-tolerant filename query the built-in glob cannot
 * express. Path patterns, pages and their sort/limit contract belong to the
 * built-in `glob`, which every host already renders and spills.
 */
const FORGE_FIND_PARAMETERS: ParameterSchemaSpec = {
  pattern: { type: 'string', required: true, description: 'Fuzzy file-name or path query; use this for typos. For path patterns use the built-in glob.' },
  path: { type: 'string', description: 'Directory; absolute or workspace-relative, default workspace.' },
  limit: { type: 'integer', description: `Maximum fuzzy name results (default ${FIND_LIMIT_DEFAULT}, max ${FIND_LIMIT_MAX}).` },
}

export interface FindToolOptions {
  /** Test seam: production uses the Everything backend from global-index.ts. */
  globalSearch?: typeof everythingSearch
}

/** fffind — fuzzy file-name and path search. */
export function createFindTool(pool: FinderPool, options: FindToolOptions = {}) {
  const globalSearch = options.globalSearch ?? everythingSearch
  return {
    name: 'ff_find',
    description: 'Find files by fuzzy name or path, tolerating typos. For path-pattern listing use the built-in glob. '
      + 'Returns a directory too (trailing "/") when the machine index answers, files only from the fuzzy fallback. '
      + 'Pass path at any directory on the host — node_modules, another drive, another checkout — and the index re-roots onto it, reaching subtrees the workspace excludes. '
      + 'An empty page names what it found on disk. For contents use ff_grep.',
    parameters: FORGE_FIND_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: FIND_ITEM_SCHEMA },
          totalMatched: { type: 'integer', required: true },
          warming: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (args: unknown, value: FindRenderValue) => renderNamePage(args, value),
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (pattern === '') return failure('pattern is required')
      // `mode`/`page` are not in the schema; refused, not ignored, so a caller
      // that learned them from an older surface is pointed at the built-in.
      if (args.mode !== undefined) return failure('no mode: use the built-in glob for path patterns')
      if (args.page !== undefined) return failure('no page: use the built-in glob for path patterns')
      return nameSearch(pool, args, pattern, exec, globalSearch)
    },
  } as const
}
