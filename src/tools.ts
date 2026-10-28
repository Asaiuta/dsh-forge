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
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { NativeDelegate } from './delegate.ts'
import { explainAbsence } from './absence.ts'
import { overlaySnapshot, searchOverlay } from './overlay.ts'
import { attachEnclosingSymbols } from './tools-symbol.ts'
import { allStores, hasPendingTransaction, pruneOrphanedStores, gcStoreBlobs, purgeStore, statsFor, storeFor } from './ledger.ts'
import { cardsStatusFor, CARD_NAMES } from './cards.ts'
import { canonicalWorkspace } from './fs-paths.ts'
import { countTickets } from './tickets.ts'
import { peekIndexerStatus } from './indexer-client.ts'
import { TRACE_CAPABILITY_MATRIX, TRACE_BINARY_EVIDENCE } from './trace-capabilities.ts'
import { traceSnapshotStatus } from './tools-trace.ts'
import {
  CONTEXT_MAX,
  FILTER_MAX_EXTRA_PAGES,
  FIND_LIMIT_DEFAULT,
  FIND_LIMIT_MAX,
  GLOB_LIMIT_DEFAULT,
  GLOB_LIMIT_MAX,
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
  dataDir,
  globToRegExp,
  isHomeDir,
  noteQueryHit,
  renderFindItems,
  renderGrepItems,
  shapeFindItem,
  shapeGrepItem,
  storeCursor,
  takeCursor,
  weakNameMatch,
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
  // `path.resolve` is load-bearing, not cosmetic: the single-file branch below
  // compares a resolved path against this value with `===`. Keeping the
  // caller's separators meant `F:/x/file.ts` never equalled the engine's
  // `F:\x\file.ts`, so `path` pointing at one file matched nothing on Windows
  // — measured 8/8 deterministic. Normalizing here makes both spellings work.
  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(workdir, trimmed)

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
    const lease = await pool.aux(path.dirname(absolute))
    if (isFailure(lease)) return lease
    return { lease, prefixFilter: (rel) => path.resolve(lease.basePath, rel) === absolute }
  }
  return failure(`unsupported path kind: ${absolute}`)
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
function absenceNote(scope: { lease: FinderLease }, query: string): string | undefined {
  const canList = (segment: string): boolean => {
    try {
      const probe = scope.lease.finder.glob(`${segment}/**`, { pageSize: 1, pageIndex: 0 })
      return probe.ok && probe.value.items.length > 0
    } catch {
      return false
    }
  }
  return explainAbsence({ scopeRoot: scope.lease.basePath, query, canList })
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
  // Files that came back holding exactly the per-file cap: the engine stopped
  // collecting there and does not resume inside that file, so whatever else
  // matched it is not in this result and not behind the cursor either.
  const cappedFiles: string[] = []

  for (let page = 0; page <= (filter ? FILTER_MAX_EXTRA_PAGES : 0); page++) {
    const result = lease.finder.grep(pattern, {
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
    })
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

// ---------------------------------------------------------------------------
// Serving as the built-in `grep`
// ---------------------------------------------------------------------------

/**
 * The built-in `grep` name, and the only name this branch ever delegates to.
 */
const NATIVE_GREP_NAME = 'grep'

/**
 * How many lines the built-in `grep` shows before it stops (`GREP_MAX_MATCHES`
 * in `dsh-tool-fs-search`). Not a tunable: it is the number the built-in's own
 * callers are used to, so a takeover that showed a different amount would be a
 * third behaviour rather than the one it replaced.
 */
const NATIVE_GREP_LIMIT = 250

/**
 * The built-in `grep` arguments, verbatim: a regular expression, a path and one
 * include glob. `mode` is absent on purpose — the built-in's `pattern` is
 * ripgrep syntax and always case-sensitive, and this branch serves exactly that.
 */
const NATIVE_GREP_PARAMETERS: ParameterSchemaSpec = {
  pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep syntax). Case-sensitive.' },
  path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
  include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
}

/**
 * Compile one ripgrep `--glob` into a predicate.
 *
 * Three details are ripgrep's, not forge's, and each of them is a wrong answer
 * if borrowed from {@link compileConstraintFilter}:
 *
 *   basename   a glob with no `/` matches the file NAME at any depth, so
 *              `*.ts` must not be anchored to the whole relative path.
 *   case       rg's globs follow the filesystem: sensitive on Linux, insensitive
 *              elsewhere. Forge's own constraints are case-insensitive everywhere.
 *   slash      a glob WITH a `/` is matched against the path as rg walked it,
 *              which for a `path=` subdirectory is relative to that subdirectory
 *              — the documented reason `path=src` + `include=src/*.ts` finds
 *              nothing here and the empty page says so instead of inventing hits.
 *
 * @param glob - the `include` argument.
 * @returns a predicate over lease-relative paths.
 */
function compileRipgrepGlob(glob: string): (relativePath: string) => boolean {
  const pattern = glob.trim()
  const anchored = pattern.includes('/')
  const re = globToRegExp(pattern, process.platform !== 'linux')
  return (relativePath: string) => {
    const normalized = relativePath.split(path.sep).join('/')
    return re.test(anchored ? normalized : normalized.slice(normalized.lastIndexOf('/') + 1))
  }
}

/**
 * Why the built-in would refuse this `include`, or `undefined` when it would
 * take it. Rejecting here rather than silently over-matching keeps an
 * unsupported glob from becoming an answer.
 */
function includeProblem(include: string): string | undefined {
  if (include.startsWith('!')) return 'include does not support negation — pass the glob to search, not the one to skip'
  // `{a,b}` is alternation; a comma outside braces is the "list" the built-in
  // refuses (it would otherwise search for a file literally named `*.ts,*.js`).
  if (include.replace(/\{[^{}]*\}/g, '').includes(',')) {
    return 'include must be one glob, not a comma-separated list (use {a,b} alternation instead)'
  }
  return undefined
}

/**
 * The engine's column unit: a 0-based **byte** offset into the line.
 *
 * Computed, not guessed. A JS match index is a UTF-16 code-unit offset, so on a
 * line with non-ASCII text (this repository has plenty) handing it back as `col`
 * would point at the wrong byte. `overlay.ts` measures the same way for the same
 * reason; both feed one schema, so both must agree on the unit.
 */
function columnOf(re: RegExp | null, line: string): number {
  if (re === null) return 0
  re.lastIndex = 0
  const found = re.exec(line)
  return found === null ? 0 : Buffer.byteLength(line.slice(0, found.index), 'utf8')
}

/** The JS-regex view of `pattern`, for column recovery only. */
function columnRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    // ripgrep's dialect is not JavaScript's; a pattern this engine cannot
    // compile still matches on disk, it just loses its column.
    return null
  }
}

/**
 * Turn a built-in `grep` value into this tool's page.
 *
 * The built-in answers `{matches: [{path, lineNumber, line}]}` — no column, no
 * git status, no frecency. Those three fields are filled with their honest
 * zero values rather than guessed, and the column is recovered from the line
 * because a wrong column is worse than an absent one.
 *
 * @param value - the built-in's returned value (untrusted shape).
 * @param pattern - the pattern that produced it, for column recovery.
 * @returns the page plus the cap note when the built-in returned more lines
 *   than it would have shown.
 */
function nativeGrepPage(value: unknown, pattern: string): { items: GrepItem[]; totalMatched: number; note?: string } {
  const raw = (value as { matches?: unknown } | null | undefined)?.matches
  if (!Array.isArray(raw)) return { items: [], totalMatched: 0 }
  const re = columnRegex(pattern)
  const items: GrepItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const match = entry as { path?: unknown; lineNumber?: unknown; line?: unknown }
    if (typeof match.path !== 'string' || typeof match.lineNumber !== 'number') continue
    const line = typeof match.line === 'string' ? match.line : ''
    items.push({ file: match.path, line: match.lineNumber, col: columnOf(re, line), text: line, git: '', frecency: 0 })
  }
  if (items.length <= NATIVE_GREP_LIMIT) return { items, totalMatched: items.length }
  // The built-in shows the same number and saves the rest to a file; there is
  // no file here, so the count is the only part of that promise this can keep.
  return {
    items: items.slice(0, NATIVE_GREP_LIMIT),
    totalMatched: NATIVE_GREP_LIMIT,
    note: `more than ${NATIVE_GREP_LIMIT} lines match; the first ${NATIVE_GREP_LIMIT} are shown — narrow pattern, path or include`,
  }
}

/** AND two path predicates, tolerating either being absent. */
function combineFilters(
  first: ((relativePath: string) => boolean) | undefined,
  second: ((relativePath: string) => boolean) | undefined,
): ((relativePath: string) => boolean) | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return (relativePath) => first(relativePath) && second(relativePath)
}

/**
 * The built-in `grep` as this tool serves it: index first, ripgrep on disk
 * whenever the index's answer could be wrong or incomplete.
 *
 * Delegation is not a speed path. It is entered on the four occasions where the
 * index cannot be trusted, and every one of them ends with a note naming who
 * answered:
 *
 *   warming      a scan is still running, so a page is a sample, not an answer
 *   unavailable  the finder could not start for this root at all
 *   no match     the index found nothing — and the index is a snapshot, so a
 *                file written by another process since it caught up is invisible
 *   bad path     `path` holds a glob, which the built-in refuses as a path
 *
 * The no-match case is the one that matters: "0 matches" is the only answer a
 * caller acts on by giving up, and the built-in makes it verifiable instead of
 * merely probable.
 */
async function nativeGrep(
  pool: FinderPool,
  args: Record<string, unknown>,
  exec: ForgeExec | undefined,
  raw: ForgeExec | undefined,
  delegate: NativeDelegate | undefined,
): Promise<unknown> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  if (pattern === '') return failure('pattern is required')
  const rawPath = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
  const include = typeof args.include === 'string' && args.include.trim() !== '' ? args.include.trim() : undefined
  if (include !== undefined) {
    const problem = includeProblem(include)
    if (problem !== undefined) return failure(problem)
  }
  // The built-in's own argument shape — never this tool's.
  const builtin = { pattern, ...(rawPath === undefined ? {} : { path: rawPath }), ...(include === undefined ? {} : { include }) }
  const canDelegate = delegate !== undefined && delegate.available(NATIVE_GREP_NAME)

  // A glob in `path` is not a path. The built-in answers with an error and so
  // does this; treating it as a constraint would answer a different question.
  if (canDelegate && rawPath !== undefined && /[*?{[]/.test(rawPath)) {
    const delegated = await delegate.run(NATIVE_GREP_NAME, builtin, raw)
    if (delegated.ok) return nativeGrepPage(delegated.value, pattern)
    return failure(delegated.error)
  }

  const scope = await resolveScope(pool, workdirOf(exec), rawPath)
  if (isFailure(scope)) {
    if (!canDelegate) return scope
    const delegated = await delegate.run(NATIVE_GREP_NAME, builtin, raw)
    if (delegated.ok) return nativeGrepPage(delegated.value, pattern)
    return scope
  }
  if (canDelegate && scope.lease.warming) {
    const delegated = await delegate.run(NATIVE_GREP_NAME, builtin, raw)
    // A failed disk search still leaves a partial index page, which is more
    // than an error message; fall through and let the warming flag say so.
    if (delegated.ok) return nativeGrepPage(delegated.value, pattern)
  }

  const filter = combineFilters(scope.prefixFilter, include === undefined ? undefined : compileRipgrepGlob(include))
  // `mode: 'regex'` and `smartCase: false` are the built-in's contract, not a
  // preference: ripgrep's default is a case-sensitive regular expression.
  // `timeBudgetMs: 0` is the other half of it — the built-in has no partial
  // result, it has a timeout that fails the call, and this tool exposes no
  // cursor to continue a cut scan with, so a budget here would truncate a
  // takeover answer with nothing to point at.
  const options: GrepCallOptions = { mode: 'regex', beforeContext: 0, afterContext: 0, pageSize: NATIVE_GREP_LIMIT, timeBudgetMs: 0, smartCase: false }
  const result = runGrep(scope.lease, pattern, options, undefined, filter)
  if (isFailure(result)) {
    if (canDelegate) {
      const delegated = await delegate.run(NATIVE_GREP_NAME, builtin, raw)
      if (delegated.ok) return nativeGrepPage(delegated.value, pattern)
    }
    return result
  }
  const value = result.value
  const notes: string[] = []

  if (value.items.length === 0) {
    if (value.filteredFrom > 0) {
      // The index matched and `include` dropped it — not an absence on disk,
      // and delegating here would answer "no such file" for a file it can see.
      notes.push(`${value.filteredFrom} line(s) matched outside include="${String(include)}" — widen or drop include to see them`)
    } else if (canDelegate) {
      const delegated = await delegate.run(NATIVE_GREP_NAME, builtin, raw)
      if (delegated.ok) {
        const disk = nativeGrepPage(delegated.value, pattern)
        if (disk.items.length > 0) {
          return { ...disk, note: ['the index had no match — these lines come from ripgrep on disk, so the index has not caught up', ...(disk.note === undefined ? [] : [disk.note])].join('; ') }
        }
        return { items: [], totalMatched: 0, note: 'no match in the index and none on disk' }
      }
      notes.push(`no match in the index; the on-disk check could not run (${delegated.error})`)
    } else {
      const hint = absenceNote(scope, pattern)
      if (hint !== undefined) notes.push(hint)
    }
  }
  if (value.regexFallbackError) notes.push(`regex failed to compile (${value.regexFallbackError}); literal fallback used`)
  if (value.cappedFiles.length > 0) {
    const shown = value.cappedFiles.slice(0, 3).map(file => `"${file}"`).join(', ')
    notes.push(`${shown} hit the ${GREP_MAX_MATCHES_PER_FILE}-matches-per-file cap — more lines there are not shown; narrow the pattern or read the file directly`)
  }
  const page = value.items.slice(0, NATIVE_GREP_LIMIT)
  if (value.items.length > NATIVE_GREP_LIMIT) {
    notes.push(`more than ${NATIVE_GREP_LIMIT} lines match; the first ${NATIVE_GREP_LIMIT} are shown — narrow pattern, path or include`)
  }
  if (!scope.lease.aux) {
    for (const item of page.slice(0, 20)) noteQueryHit(path.resolve(scope.lease.basePath, item.file), pattern)
  }
  return {
    items: page.map(item => ({ ...item, file: displayPath(workdirOf(exec), scope.lease.basePath, item.file) })),
    totalMatched: page.length,
    ...(scope.lease.warming ? { warming: true } : {}),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  }
}

/** ffgrep's own surface — every mode, both search shapes, paging. */
const FORGE_GREP_PARAMETERS: ParameterSchemaSpec = {
  pattern: { type: 'string', description: 'One nonempty search text.' },
  patterns: { type: 'array', items: { type: 'string' }, description: '2-16 nonempty literals, OR-matched in one pass; always literal — no mode applies.' },
  path: { type: 'string', description: 'Directory, file, or globs "*.ts !test/"; absolute or workspace-relative, default workspace. With patterns: filter files only.' },
  mode: { type: 'string', enum: ['plain', 'regex', 'fuzzy'], description: 'plain (default) = literal; regex (invalid expressions fall back); fuzzy (typos). pattern only.' },
  context: { type: 'integer', description: `Lines around hits, 0-${CONTEXT_MAX}; default 0.` },
  limit: { type: 'integer', description: `Hits per page (default ${GREP_LIMIT_DEFAULT}, max ${GREP_LIMIT_MAX}); file boundaries may exceed it.` },
  cursor: { type: 'string', description: 'Previous nextCursor; keep search arguments unchanged.' },
  timeBudgetMs: { type: 'integer', description: `Soft cap on scan time in ms (default ${TIME_BUDGET_DEFAULT_MS}, max 60000; 0 = unlimited). It can only cut a scan that is already matching: a query with no hits always reads every candidate file, so an empty page means "absent", not "gave up". A cut scan returns nextCursor — continue with cursor to get the rest.` },
  enclosing: { type: 'boolean', description: 'Attach enclosing symbol + range for ff_read (file#Symbol); default false. pattern only.' },
}

/** ffgrep — SIMD content search in frecency order, no subprocess. */
export function createGrepTool(pool: FinderPool, nativeName?: 'grep', delegate?: NativeDelegate) {
  const native = nativeName === 'grep'
  return {
    name: native ? NATIVE_GREP_NAME : 'ffgrep',
    description: native
      ? 'Search file contents with a ripgrep regular expression. Case-sensitive; returns matching lines as "path:line: text". ' +
        'Searches the workspace index, which holds no .gitignore\'d paths and no node_modules — point path at one to search it — and does hold dot-directories, which the built-in ripgrep skips. ' +
        'When the index cannot answer — still scanning, fails to start, or finds no match — the same pattern is re-run with ripgrep over the disk, and the note says which one answered. ' +
        `Returns up to ${NATIVE_GREP_LIMIT} lines; narrow pattern, path or include to see more.`
      : 'Search text, including references. Use pattern (one plain/regex/fuzzy search) or patterns (2-16 literals, one OR pass) — exactly one of the two. ' +
        'Pass path at any directory and the index re-roots onto it — node_modules, another drive and another checkout included. ' +
        'For definitions use ff_read view=definitions. Lowercase patterns ignore case. Warming/timeout pages may be partial; paginate with cursor.',
    parameters: native ? NATIVE_GREP_PARAMETERS : FORGE_GREP_PARAMETERS,
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
          if (value.warming) header.push('[index still warming — this page is not an answer; retry]')
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
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined, raw?: ForgeExec) {
      if (native) return nativeGrep(pool, args, exec, raw, delegate)
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      const patterns = Array.isArray(args.patterns)
        ? args.patterns.filter((p): p is string => typeof p === 'string' && p !== '')
        : []
      const mode = typeof args.mode === 'string' ? args.mode : undefined
      if (pattern !== '' && patterns.length > 0) return failure('provide either pattern or patterns, not both')
      if (pattern === '' && patterns.length === 0) return failure('pattern is required (or patterns with 2-16 literals)')
      // Multi-literal OR mode. Absorbed from the former fff_multi_grep: same
      // engine call, same page/cursor contract, so a caller that used
      // `patterns` keeps working — it just has one fewer tool to choose from.
      if (patterns.length > 0) {
        if (patterns.length === 1) return failure('patterns requires at least 2 literals (use pattern for a single one)')
        if (patterns.length > 16) return failure('patterns accepts at most 16 patterns')
        if (mode !== undefined) return failure('mode applies to pattern only; patterns are always literal')
        if (args.enclosing === true) return failure('enclosing applies to pattern only; patterns carries no enclosing-symbol annotation')
        const multiContext = clampInt(args.context, 0, 0, CONTEXT_MAX)
        const multiLimit = clampInt(args.limit, GREP_LIMIT_DEFAULT, 1, GREP_LIMIT_MAX)
        const multiBudget = clampInt(args.timeBudgetMs, TIME_BUDGET_DEFAULT_MS, 0, 60_000)
        const multiLease = await pool.main(workdirOf(exec))
        if (isFailure(multiLease)) return multiLease
        const multi = multiLease.finder.multiGrep({
          patterns,
          constraints: typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined,
          beforeContext: multiContext,
          afterContext: multiContext,
          pageSize: multiLimit,
          maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
          smartCase: true,
          timeBudgetMs: multiBudget,
          cursor: takeCursor(typeof args.cursor === 'string' ? args.cursor : undefined),
        })
        if (!multi.ok) return failure(`fff multi-grep failed: ${multi.error}`)
        for (const item of multi.value.items.slice(0, 20)) {
          noteQueryHit(path.resolve(multiLease.basePath, item.relativePath), patterns.join(' | '))
        }
        // Same silent-loss risk as single-pattern grep: the per-file cap drops
        // the rest of a hot file and the cursor skips past it.
        const multiPerFile = new Map<string, number>()
        for (const item of multi.value.items) {
          multiPerFile.set(item.relativePath, (multiPerFile.get(item.relativePath) ?? 0) + 1)
        }
        const multiCapped = [...multiPerFile].filter(([, n]) => n >= GREP_MAX_MATCHES_PER_FILE).map(([file]) => file)
        const multiNotes: string[] = []
        if (multiCapped.length > 0) {
          multiNotes.push(`${multiCapped.slice(0, 3).map(file => `"${file}"`).join(', ')} hit the ${GREP_MAX_MATCHES_PER_FILE}-matches-per-file cap — more lines there are not shown and no cursor reaches them; narrow the pattern or read the file directly`)
        }
        return {
          items: multi.value.items.map(shapeGrepItem),
          totalMatched: multi.value.totalMatched,
          ...(multi.value.nextCursor ? { nextCursor: storeCursor(multi.value.nextCursor) } : {}),
          ...(multiLease.warming ? { warming: true } : {}),
          ...(multiNotes.length ? { note: multiNotes.join('; ') } : {}),
        }
      }
      const context = clampInt(args.context, 0, 0, CONTEXT_MAX)
      const limit = clampInt(args.limit, GREP_LIMIT_DEFAULT, 1, GREP_LIMIT_MAX)
      const timeBudgetMs = clampInt(args.timeBudgetMs, TIME_BUDGET_DEFAULT_MS, 0, 60_000)
      const scope = await resolveScope(pool, workdirOf(exec), typeof args.path === 'string' ? args.path : undefined)
      if (isFailure(scope)) return scope
      const options = grepCallOptions(mode, context, limit, timeBudgetMs)
      const result = runGrep(scope.lease, pattern, options, typeof args.cursor === 'string' ? args.cursor : undefined, scope.prefixFilter)
      if (isFailure(result)) return result
      let value = result.value
      // Files committed by this process are authoritative: the index still holds
      // their pre-write content (it needs a 2.3 s rescan or a 3.4-4.3 s watcher
      // round trip to notice, and ff exposes no per-file rebuild). So drop index
      // hits under those paths — keeping them would print a deleted line next to
      // its replacement — and answer for them from the bytes just written.
      const overlay = overlaySnapshot(scope.lease.basePath)
      let liveHits = 0
      const withLive = (outcome: typeof value, liveMode: GrepMode): typeof value => {
        liveHits = 0
        if (overlay.shadowed.size === 0) return outcome
        const kept = outcome.items.filter((item) => !overlay.shadowed.has(item.file))
        const live = searchOverlay(overlay.files, pattern, {
          mode: liveMode,
          smartCase: options.smartCase,
          context,
          limit,
        })
        liveHits = live.length
        return { ...outcome, items: [...live, ...kept], totalMatched: live.length + kept.length }
      }
      value = withLive(value, options.mode)
      // Zero-hit literal→regex escalation: the built-in grep treats patterns as
      // regex, so the model freely writes \d+ or a|b into a tool whose default
      // mode is literal — and a zero-hit page reads as "not in the repo".
      // When a first-page literal search matched nothing and the pattern is
      // regex-shaped, retry once in regex mode (the engine already falls back
      // literal on invalid regex). First page only: cursor pagination replays
      // the same query, and re-escalating mid-pagination would skip hits.
      const paginating = typeof args.cursor === 'string' && args.cursor.trim() !== ''
      const notes: string[] = []
      if ((mode === undefined || mode === 'plain') && !paginating && value.items.length === 0
        && /[$^.*+?()[\]{}|\\]/.test(pattern)) {
        const retry = runGrep(scope.lease, pattern, { ...options, mode: 'regex' }, undefined, scope.prefixFilter)
        if (!isFailure(retry) && retry.value.items.length > 0) {
          value = withLive(retry.value, 'regex')
          notes.push('no literal matches — automatically retried as regex')
        }
      }
      if (args.enclosing === true && value.items.length > 0) {
        await attachEnclosingSymbols(value.items, scope.lease.basePath)
      }
      // An empty page gets the same treatment as the glob page: wait out a scan that
      // is still running, then say what the disk holds if it is still empty.
      if (value.items.length === 0 && !paginating) {
        await waitForWarm(scope)
        if (scope.lease.warming && value.items.length === 0) {
          const retry = runGrep(scope.lease, pattern, options, undefined, scope.prefixFilter)
          if (!isFailure(retry)) value = withLive(retry.value, options.mode)
        }
        if (value.items.length === 0) {
          // Two different empty pages, and they need opposite advice.
          //
          // If the index did hand back hits and the `path=` constraint dropped
          // all of them, the answer is "your constraint is too narrow". Running
          // the disk walk here would instead report "exists on disk — matching
          // is case-sensitive" or "not indexed at this scope": a wrong root
          // cause that sends the caller off to rewrite the pattern while the
          // real fix is to widen the path.
          const outside = value.filteredFrom
          if (outside > 0) {
            notes.push(`${outside} line(s) matched outside path="${String(args.path ?? '')}" — widen or drop path to see them`)
          } else {
            const hint = absenceNote(scope, pattern)
            if (hint !== undefined) notes.push(hint)
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
        notes.push(`${shown}${more} hit the ${GREP_MAX_MATCHES_PER_FILE}-matches-per-file cap — more lines there are not shown and no cursor reaches them; narrow the pattern or read the file directly`)
      }
      // Never let a live answer pass as an indexed one: the two disagree for a
      // few seconds, and the model is the one who decides whether to trust it.
      if (liveHits > 0) {
        notes.push(`${liveHits} hit(s) come from live content of file(s) written by this session — the index has not caught up yet`)
      }
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

// ---------------------------------------------------------------------------
// fffind — fuzzy file-name search (mode=name) and glob path listing (mode=glob)
// ---------------------------------------------------------------------------

const FIND_MODES = ['name', 'glob'] as const
type FindMode = (typeof FIND_MODES)[number]

/** One row of a `mode=glob` page: the four shared fields, none of the ranking ones. */
interface FindGlobRow {
  path: string
  size: number
  modified: string
  git: string
}

/**
 * Absent or unrecognised `mode` reads as `name` — i.e. exactly what this tool did
 * before `ffglob` was folded into it, so every pre-merge `fffind` call is
 * unchanged. Validation of an explicit-but-wrong value happens in `execute`.
 */
function findModeOf(args: unknown): FindMode {
  const raw = (args as { mode?: unknown } | undefined)?.mode
  return typeof raw === 'string' && raw.trim() === 'glob' ? 'glob' : 'name'
}

/**
 * The two modes return different row shapes, so the output schema is their flat
 * union with the ranking fields optional: `defineForgeTool` spreads the root
 * `properties`, so a top-level `oneOf` cannot survive — the same constraint that
 * shaped `ff_read`'s three views. `mode=name` always fills all eight fields.
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
  items: Array<FindItem | FindGlobRow>
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
  '[pattern looks like a glob — mode=name matches file names fuzzily; for path patterns pass mode=glob, or use ff_read with glob= to read the matches directly]'

function renderNamePage(args: unknown, value: FindRenderValue): Array<{ type: 'text'; text: string }> {
  // Headers first, then the empty case — see renderGlobPage for why.
  if (value.items.length === 0) {
    const header: string[] = []
    if (value.warming) header.push('[index still warming — this page is not an answer; retry]')
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
    header.push(`[no file name contains "${pattern}" — fuzzy coincidences only. For file contents, symbols or config values use ffgrep.]`)
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

/**
 * The built-in `glob` page: a bare path list, no page cursor.
 *
 * The built-in takes no pagination argument, so a cap here cannot be escaped by
 * asking for the next page — the only honest move is to say the list is capped
 * and name the two arguments that narrow it.
 */
function renderNativeGlobPage(value: FindRenderValue): Array<{ type: 'text'; text: string }> {
  const header: string[] = []
  if (value.items.length === 0) {
    if (value.warming) header.push('[index still warming — this page is not an answer; retry]')
    if (value.note) header.push(`[${value.note}]`)
    return text([...header, 'no files matched'].join('\n'))
  }
  if (value.warming) header.push('[index still warming — results may be partial]')
  if ((value.totalMatched ?? 0) > value.items.length) {
    header.push(`[showing ${value.items.length} of ${value.totalMatched} matches — narrow the pattern or pass path=]`)
  }
  if (value.note) header.push(`[${value.note}]`)
  return text([...header, ...value.items.map((item) => item.path)].join('\n'))
}

function renderGlobPage(value: FindRenderValue): Array<{ type: 'text'; text: string }> {  // The headers are assembled before the empty case returns. Ordering was the
  // bug: returning on `items.length === 0` first threw away exactly the flag
  // that explains an empty page ("still warming"), so a finder that had not
  // finished scanning was indistinguishable from a tree that genuinely holds
  // nothing.
  const header: string[] = []
  if (value.items.length === 0) {
    if (value.warming) header.push('[index still warming — this page is not an answer; retry]')
    if (value.note) header.push(`[${value.note}]`)
    return text([...header, 'no files matched'].join('\n'))
  }
  if (value.warming) header.push('[index still warming — results may be partial]')
  // The cap must be visible: a caller cannot tell a complete list from a
  // truncated page (same discipline as the name page).
  if ((value.totalMatched ?? 0) > value.items.length) {
    header.push(`[showing ${value.items.length} of ${value.totalMatched} glob matches — paginate with page=<n>]`)
  }
  if (value.note) header.push(`[${value.note}]`)
  return text([...header, ...value.items.map((item) => item.path)].join('\n'))
}

/** `mode=name` — fuzzy file-name search, ranked by match score and frecency. */
async function nameSearch(pool: FinderPool, args: Record<string, unknown>, pattern: string, exec: ForgeExec | undefined) {
  const limit = clampInt(args.limit, FIND_LIMIT_DEFAULT, 1, FIND_LIMIT_MAX)
  // fffind used to resolve `path` itself, duplicating resolveScope — including
  // its Windows separator bug. One resolver, one fix.
  const scope = await resolveScope(pool, workdirOf(exec), typeof args.path === 'string' ? args.path : undefined)
  if (isFailure(scope)) return scope
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
    for (let pageIndex = 1; !items.length && pageIndex * FIND_LIMIT_MAX < result.value.totalMatched; pageIndex++) {
      const page = lease.finder.fileSearch(pattern, { pageSize: FIND_LIMIT_MAX, pageIndex })
      if (!page.ok) return failure(`fff file search failed: ${page.error}`)
      offered += page.value.items.length
      items = page.value.items.map((item, i) => shapeFindItem(item, page.value.scores[i])).filter(item => filter!(item.path))
      if (!page.value.items.length) break
    }
  }
  let note: string | undefined
  if (items.length === 0) {
    await waitForWarm(scope)
    if (scope.lease.warming) {
      const retry = lease.finder.fileSearch(pattern, { pageSize: filter ? FIND_LIMIT_MAX : limit })
      if (retry.ok) {
        offered = retry.value.items.length
        items = retry.value.items
          .map((item, i) => shapeFindItem(item, retry.value.scores[i]))
          .filter(item => filter === undefined || filter(item.path))
      }
    }
    if (items.length === 0) {
      // Same split as ffgrep: a name the index returned but the constraint
      // dropped is not an absence on disk, and the disk walk would mislabel it.
      note = filter !== undefined && offered > 0
        ? `${offered} name match(es) fell outside path="${String(args.path ?? '')}" — widen or drop path to see them`
        : absenceNote(scope, pattern)
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
    ...(note ? { note } : {}),
  }
}

/**
 * The built-in `glob` arguments, verbatim: a pattern and a directory, nothing
 * else. Kept as a typed constant so the native branch is checked against the
 * same schema spec as the forge branch instead of collapsing into a union.
 */
const NATIVE_GLOB_PARAMETERS: ParameterSchemaSpec = {
  pattern: { type: 'string', required: true, description: 'Glob to match paths against, e.g. "**/*.ts" or "src/**/*.test.js". With no "/" it matches the file NAME at any depth, so "*" and "*.ts" both cover the whole tree.' },
  path: { type: 'string', description: 'Directory to search, absolute or workspace-relative; defaults to the workspace. Point it at a .gitignore\'d directory to search that subtree.' },
}

const FORGE_FIND_PARAMETERS: ParameterSchemaSpec = {
  pattern: { type: 'string', required: true, description: 'name: fuzzy query, e.g. "store.js" or "src/ config"; not a glob. glob: path pattern, e.g. "src/**/*.ts" or "*.{js,mjs}"; Case-sensitive — without "/" it matches the file NAME at any depth ("*.md" ≙ "**/*.md").' },
  mode: { type: 'string', enum: ['name', 'glob'], description: 'Default name: fuzzy file-name match. glob: path-pattern listing.' },
  path: { type: 'string', description: 'Directory; absolute or workspace-relative, default workspace.' },
  limit: { type: 'integer', description: `name: max files (default ${FIND_LIMIT_DEFAULT}, max ${FIND_LIMIT_MAX}). glob: paths per page (default ${GLOB_LIMIT_DEFAULT}, max ${GLOB_LIMIT_MAX}).` },
  page: { type: 'integer', description: 'glob only: 0-based page when totalMatched exceeds limit.' },
}

/** fffind — fuzzy file-name search, plus glob path listing under `mode=glob`. */
export function createFindTool(pool: FinderPool, nativeName?: 'glob') {
  // Serving as the built-in `glob`: its argument contract is `{pattern, path}`
  // and nothing else — no mode, no page, no limit — and its answer is a plain
  // path list. Admitting the rest would let the built-in guidance (which stays
  // visible under takeover) describe arguments this tool does not have.
  const native = nativeName === 'glob'
  const nativeGlob = (args: Record<string, unknown>, exec: ForgeExec | undefined) => {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
    if (pattern === '') return failure('pattern is required')
    // One page's worth is the whole answer here: there is no `page` argument to
    // continue with, so asking for the maximum keeps the cap from being the
    // thing that silently decides what the caller sees.
    return globSearch(pool, { ...args, limit: GLOB_LIMIT_MAX, page: 0 }, pattern, exec)
  }
  return {
    name: native ? 'glob' : 'fffind',
    description: native
      ? 'List files whose paths match a glob pattern. A pattern with no "/" matches the basename at any depth ("*.ts" ≙ "**/*.ts"); include a separator to anchor the depth. ' +
        'Files only — directories are never returned; descend with "dir/**". ' +
        'Searches the workspace index, so .gitignore\'d paths and node_modules are NOT covered — pass path at one of them to search it.'
      : 'Find files. mode=name (default) fuzzily matches file names and paths, tolerating typos; mode=glob lists files whose paths match a glob and paginates by page. ' +
        'Both list FILES only — directories are never returned; descend with "dir/**". ' +
        'Pass path at any directory on the host — node_modules, another drive, another checkout — and the index re-roots onto it, reaching subtrees the workspace excludes. ' +
        'An empty page names what it found on disk. For contents use ffgrep.',
    parameters: native ? NATIVE_GLOB_PARAMETERS : FORGE_FIND_PARAMETERS,
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
      render: (args: unknown, value: FindRenderValue) =>
        native
          ? renderNativeGlobPage(value)
          : findModeOf(args) === 'glob' ? renderGlobPage(value) : renderNamePage(args, value),
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      if (native) return nativeGlob(args, exec)
      const explicit = typeof args.mode === 'string' && args.mode.trim() !== '' ? args.mode.trim() : undefined
      if (explicit !== undefined && !(FIND_MODES as readonly string[]).includes(explicit)) {
        return failure(`mode must be one of ${FIND_MODES.join(', ')} (or omitted for name) — got: ${args.mode}`)
      }
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (findModeOf(args) === 'name') {
        if (pattern === '') return failure('pattern is required')
        // `page` belongs to the glob mode: the name mode pages internally so an
        // explicitly named file cannot be ranked off the first page.
        if (args.page !== undefined) return failure('page applies to mode=glob only; mode=name pages internally')
        return nameSearch(pool, args, pattern, exec)
      }
      const globPattern = pattern.trim()
      if (globPattern === '') return failure('pattern is required')
      return globSearch(pool, args, globPattern, exec)
    },
  } as const
}

/** `mode=glob` — native SIMD glob file listing, npm-glob compatible. */
async function globSearch(pool: FinderPool, args: Record<string, unknown>, rawPattern: string, exec: ForgeExec | undefined) {
  // Built-in glob convenience semantic, kept so the model's habit transfers: a
  // pattern without a separator matches the basename at any depth ("*.ts" ≙
  // "**/*.ts"); include a separator to anchor depth.
  const pattern = rawPattern.includes('/') ? rawPattern : `**/${rawPattern}`
  const limit = clampInt(args.limit, GLOB_LIMIT_DEFAULT, 1, GLOB_LIMIT_MAX)
  const page = clampInt(args.page, 0, 0, 10_000)
  const scope = await resolveScope(pool, workdirOf(exec), typeof args.path === 'string' ? args.path : undefined)
  if (isFailure(scope)) return scope
  let result = scope.lease.finder.glob(pattern, { pageSize: limit, pageIndex: page })
  if (!result.ok) return failure(`fff glob failed: ${result.error}`)
  // A still-scanning finder answers "nothing" while it is still reading the
  // tree. Wait once and ask again before reporting an empty page.
  let note: string | undefined
  if (result.value.items.length === 0) {
    await waitForWarm(scope)
    if (scope.lease.warming) result = scope.lease.finder.glob(pattern, { pageSize: limit, pageIndex: page })
    if (!result.ok) return failure(`fff glob failed: ${result.error}`)
    if (result.value.items.length === 0) note = absenceNote(scope, rawPattern)
  }
  const value = result.value
  return {
    items: value.items.map((item) => ({
      path: displayPath(workdirOf(exec), scope.lease.basePath, item.relativePath),
      size: item.size,
      modified: new Date(item.modified * 1000).toISOString().replace('T', ' ').slice(0, 19),
      git: item.gitStatus,
    })),
    totalMatched: value.totalMatched,
    ...(scope.lease.warming ? { warming: true } : {}),
    ...(note ? { note } : {}),
  }
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
export function createStatusCommand(
  pool: FinderPool,
  registration?: { mode: string; takenOver: readonly string[]; delegate?: NativeDelegate },
) {
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
      // Trace capability + snapshot section. Passive on purpose: no scan, no
      // sidecar spawn, no cargo, no network. Everything below is either a
      // static table, process state, or a directory listing (M0.5).
      {
        const traceCwd = invocation.agent?.session?.header?.cwd
        ledgerLines.push(...describeTraceStatus(traceCwd))
      }
      // Knowledge cards (sedimentation): read-only on purpose — this command
      // runs on the status path, so a stale anchor is reported, never repaired
      // here (no rebuild, no AST parse; ff_cards owns the repair).
      {
        const cardsCwd = invocation.agent?.session?.header?.cwd
        const cards = cardsCwd !== undefined ? cardsStatusFor(canonicalWorkspace(cardsCwd)) : null
        if (cards === null) {
          ledgerLines.push('知识卡片：当前工作区尚无施工台账（ffedit 首次写入后出现）。')
        } else {
          const readEntries = Object.entries(cards.reads).filter(([, stat]) => stat.count > 0)
            .sort((a, b) => b[1].count - a[1].count).slice(0, CARD_NAMES.length)
          ledgerLines.push(
            `知识卡片 ${cards.root}：` +
            (cards.anchor === null
              ? '未构建（ff_cards 首次调用时生成）'
              : `锚 batches=${cards.anchor.batches} lastId=${cards.anchor.lastId}${cards.fresh ? '（新鲜）' : '（已过期，ff_cards 调用时自动重建）'}`) +
            `，润色 ${cards.polished.length}/${CARD_NAMES.length}` +
            (readEntries.length > 0
              ? `，读取 ${readEntries.map(([name, stat]) => `${name} ${stat.count}次`).join('、')}`
              : '，尚未被读取'),
          )
        }
      }

      // Which registration mode this process actually runs in. Without it the
      // only way to answer "is takeover on?" is to re-read the profile config
      // and reason about loader layering — and a patch that failed to apply
      // looks exactly like one that was never written.
      const modeLine = registration === undefined
        ? undefined
        : registration.mode === 'takeover'
          ? `注册模式：takeover，已接管 ${registration.takenOver.join(', ') || '（无）'}`
          : '注册模式：additive（ff* 与内置并存）'
      // Whether the built-in handle actually resolves is not visible from any
      // config: it depends on which layer the host registered its fs tools in.
      // Without this line "the takeover silently stopped delegating" and "the
      // takeover is fine" look identical.
      const delegationLine = registration?.mode === 'takeover' && registration.takenOver.includes('grep')
        ? registration.delegate?.available('grep') === true
          ? '内置委托：可用（索引答不上时回退内置 grep）'
          : '内置委托：不可用（grep 只走索引，空结果未被磁盘复核）'
        : undefined
      const statusHead = [modeLine, delegationLine].filter((line): line is string => line !== undefined)

      if (live.length === 0) {
        return {
          kind: 'success',
          text: [
            'dsh-forge：尚未创建任何索引。',
            '引擎在首次调用 fffind / ffgrep 时按会话工作区懒启动，会话启动零开销。',
            ...statusHead,
            ...ledgerLines,
            `数据目录：${dataDir()}（frecency 与查询史跨会话累积）`,
          ].join('\n'),
        }
      }
      const lines: string[] = []
      lines.push(...statusHead)
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

/**
 * Passive Trace section for `/forge-status` (M0.5).
 *
 * Every line here is either a compile-time table, process state, or a registry
 * count. Nothing spawns the sidecar, runs cargo, executes project code or
 * touches the network — the status path must stay usable precisely when the
 * engine is what is broken. A capability that is merely unproven reads as
 * `not_probed`/`unavailable`, never as "available by default".
 */
function describeTraceStatus(workspace: string | undefined): string[] {
  const lines: string[] = []
  const indexer = peekIndexerStatus()
  const dependencyLanguages = TRACE_CAPABILITY_MATRIX.filter(row => row.fileDependency !== false).map(row => row.language)
  // Languages parsed but contributing no dependency edges are named, not just
  // counted: "13 of 14" leaves the reader to guess which one has no edges.
  const parseOnly = TRACE_CAPABILITY_MATRIX.filter(row => row.fileDependency === false).map(row => row.language)
  lines.push(
    `Trace 覆盖：${TRACE_CAPABILITY_MATRIX.length} 种语言，文件依赖 ${dependencyLanguages.length} 种（${dependencyLanguages.join('、')}）` +
    `${parseOnly.length ? `；仅解析不计依赖：${parseOnly.join('、')}` : ''}` +
    `；二进制证据 ${TRACE_BINARY_EVIDENCE.extensions.length} 类扩展名（仅元数据）`,
  )
  lines.push(
    `Trace 原生解析：${indexer.state}${indexer.binary ? `（${indexer.binary}）` : ''} · ${indexer.detail}` +
    `${indexer.version ? ` · 版本 ${indexer.version}` : ''}；未探测不等于可用`,
  )
  const snapshots = traceSnapshotStatus(workspace)
  lines.push(
    snapshots.snapshots === 0
      ? 'Trace 快照：本次进程内尚无（fftrace 首次查询后建立；仅内存，不落盘）'
      : `Trace 快照：${snapshots.snapshots} 个 · ${snapshots.configurations} 种配置 · 分页游标 ${snapshots.liveCursors} 个 · 最新 ${snapshots.newest}`,
  )
  // Stages the roadmap has not delivered yet say so explicitly. Leaving them
  // out would make "no line" and "supported" indistinguishable.
  lines.push('Trace 语义引用：unavailable（M2 计划，当前未实现；symbol: 只找定义，不是引用计数）')
  lines.push('Trace 运行时证据：unavailable（不做动态加载、不执行工程代码）')
  return lines
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
