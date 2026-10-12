/**
 * dsh-forge core: dependency-free wrapper over @ff-labs/fff-node.
 *
 * Everything in this module stays free of @deepseek-ai imports so the tests
 * can drive it directly on built output, mirroring the dsh-blackhole split
 * (compiler module / thin cordis glue).
 *
 * Design constraints carried over from the forge plan:
 * - Zero startup cost: the engine is created lazily on the first tool call,
 *   keyed by workspace root; nothing happens on session start.
 * - One main finder per workspace root (with persisted frecency + query
 *   history), a small LRU of auxiliary finders for explicit subdirectory /
 *   out-of-root constraints (no persistence — they never write the shared
 *   frecency DBs).
 * - Learning and correctness live on separate data planes: frecency ranking
 *   only ever reorders *discovery* results. Edit coordinates are out of scope
 *   here (stage 3), and when they arrive they must come from parsing current
 *   content, never from this layer's indices.
 * - The fs root is refused as an index root (same guard as pi-fff); the user
 *   home directory is allowed but flagged in /forge-status.
 *
 * @module dsh-forge/core
 */

import { FileFinder } from '@ff-labs/fff-node'
import type {
  FileFinderApi,
  FileItem,
  GrepCursor,
  GrepMatch,
  GrepMode,
  GrepResult,
  Score,
  SearchResult,
} from '@ff-labs/fff-node'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

/** Result shape every tool execute() returns to DSH. */
export interface ToolFailure {
  readonly error: string
}

// ---------------------------------------------------------------------------
// Data directories
// ---------------------------------------------------------------------------

/**
 * Persistent data root. Default keeps fff's own convention (pi-fff uses
 * ~/.pi/agent/fff; here ~/.dsh/forge/fff) so frecency learned across DSH
 * sessions accumulates in one place. Override with DSH_FORGE_DATA_DIR.
 */
export function dataDir(): string {
  const override = process.env.DSH_FORGE_DATA_DIR
  if (override && override.trim() !== '') return path.resolve(override)
  return path.join(homedir(), '.dsh', 'forge')
}

export function frecencyDbPath(): string {
  return path.join(dataDir(), 'fff', 'frecency')
}

export function historyDbPath(): string {
  return path.join(dataDir(), 'fff', 'history')
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Windows drives, UNC roots, and POSIX `/` are all refused as index roots. */
export function isFsRoot(dir: string): boolean {
  const parsed = path.parse(path.resolve(dir))
  return parsed.root === parsed.dir
}

export function isHomeDir(dir: string): boolean {
  try {
    return path.resolve(dir) === path.resolve(homedir())
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Session workspace resolution
// ---------------------------------------------------------------------------

/** Structural slice of the DSH tool-execution context this module reads. */
export interface ForgeExec {
  agent?: { session?: { header?: { cwd?: string; id?: string } } }
  signal?: AbortSignal
  /** Host-owned capability; revalidates persisted ticket/history targets. */
  authorizeNativePaths?: (files: readonly string[]) => Promise<void>
  prepareNativeWrite?: (files: readonly string[]) => Promise<void>
  withNativeWrite?: <T>(files: readonly string[], operation: () => Promise<T> | T) => Promise<T>
  /** Capture provider versions around the actual file read, including batch targets. */
  beginNativeRead?: (file: string) => Promise<{ path: string; finish: () => Promise<void> }>
}

/** Hold DSH's provider locks from write-intent validation through publication. */
export async function withNativeWrite<T>(exec: ForgeExec | undefined, files: readonly string[], operation: () => Promise<T> | T): Promise<T> {
  if (exec?.withNativeWrite) return exec.withNativeWrite(files, operation)
  await exec?.prepareNativeWrite?.(files)
  exec?.signal?.throwIfAborted()
  return operation()
}

/** Same resolution the built-in fs-search tools use. */
export function workdirOf(exec: ForgeExec | undefined): string {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

// ---------------------------------------------------------------------------
// Finder pool
// ---------------------------------------------------------------------------

const MAIN_SCAN_WAIT_MS = 20_000
const AUX_SCAN_WAIT_MS = 5_000
const AUX_POOL_MAX = 4

export interface FinderLease {
  finder: FileFinderApi
  /** Root the engine actually indexed (aux finders re-root at constraints). */
  basePath: string
  /** True when still warming up — results may be partial. */
  warming: boolean
  /** True for LRU aux finders (no frecency persistence). */
  aux: boolean
}

export class FinderPool {
  readonly #main = new Map<string, FileFinderApi>()
  readonly #aux = new Map<string, FileFinderApi>()
  readonly #initing = new Map<string, Promise<FinderLease | ToolFailure>>()
  #destroyed = false

  /** Diagnostics for /forge-status: every live finder with its root. */
  live(): Array<{ finder: FileFinderApi; basePath: string; aux: boolean }> {
    const rows: Array<{ finder: FileFinderApi; basePath: string; aux: boolean }> = []
    for (const [basePath, finder] of this.#main) rows.push({ finder, basePath, aux: false })
    for (const [basePath, finder] of this.#aux) rows.push({ finder, basePath, aux: true })
    return rows
  }

  /** Non-creating accessor for an existing main finder — lets the edit layer
   *  feed trackQuery without ever triggering an index build. */
  peekMain(basePath: string): FileFinderApi | null {
    const resolved = path.resolve(basePath)
    const finder = this.#main.get(resolved)
    return finder && !finder.isDestroyed ? finder : null
  }

  /**
   * Main finder for a workspace root, created lazily and awaited up to
   * `MAIN_SCAN_WAIT_MS` so the first call of a session returns useful results
   * without ever blocking session startup. The engine keeps warming
   * (content index, bigrams) in the background after the wait cap.
   */
  async main(basePath: string): Promise<FinderLease | ToolFailure> {
    if (this.#destroyed) return { error: 'dsh-forge finder pool was disposed' }
    const resolved = path.resolve(basePath)
    if (isFsRoot(resolved)) {
      return { error: `refusing to index the filesystem root ${resolved}; open a session in a project directory` }
    }
    const existing = this.#main.get(resolved)
    if (existing && !existing.isDestroyed) return this.#lease(existing, resolved, false)
    const inFlight = this.#initing.get(resolved)
    if (inFlight) return inFlight
    const created = this.#create(resolved, true, MAIN_SCAN_WAIT_MS)
    this.#initing.set(resolved, created)
    try {
      return await created
    } finally {
      this.#initing.delete(resolved)
    }
  }

  /**
   * Auxiliary finder for an explicit constraint root (subdirectory of the
   * workspace, an out-of-root absolute directory, or a single file's parent).
   * No frecency DBs: aux finders must not write learning data derived from a
   * narrowed root. LRU-capped.
   */
  async aux(constraintRoot: string): Promise<FinderLease | ToolFailure> {
    if (this.#destroyed) return { error: 'dsh-forge finder pool was disposed' }
    const resolved = path.resolve(constraintRoot)
    if (isFsRoot(resolved)) return { error: `refusing to index the filesystem root ${resolved}` }
    const existing = this.#aux.get(resolved)
    if (existing && !existing.isDestroyed) {
      // LRU touch
      this.#aux.delete(resolved)
      this.#aux.set(resolved, existing)
      return this.#lease(existing, resolved, true)
    }
    while (this.#aux.size >= AUX_POOL_MAX) {
      const oldest = this.#aux.keys().next().value
      if (oldest === undefined) break
      const evicted = this.#aux.get(oldest)
      this.#aux.delete(oldest)
      try {
        evicted?.destroy()
      } catch {
        // eviction is best-effort; a leaked native picker is disposed with the pool
      }
    }
    return await this.#create(resolved, false, AUX_SCAN_WAIT_MS, true)
  }

  disposeAll(): void {
    this.#destroyed = true
    for (const finder of this.#main.values()) this.#safeDestroy(finder)
    for (const finder of this.#aux.values()) this.#safeDestroy(finder)
    this.#main.clear()
    this.#aux.clear()
    this.#initing.clear()
  }

  #safeDestroy(finder: FileFinderApi): void {
    try {
      finder.destroy()
    } catch {
      // dispose is best-effort
    }
  }

  #lease(finder: FileFinderApi, basePath: string, aux: boolean): FinderLease {
    let warming = false
    try {
      warming = finder.isScanning()
    } catch {
      warming = false
    }
    return { finder, basePath, warming, aux }
  }

  async #create(basePath: string, persistent: boolean, waitMs: number, aux = false): Promise<FinderLease | ToolFailure> {
    let finder: FileFinderApi
    try {
      const created = FileFinder.create({
        basePath,
        aiMode: true,
        enableFsRootScanning: false,
        enableHomeDirScanning: true,
        followSymlinks: true,
        ...(persistent ? { frecencyDbPath: frecencyDbPath(), historyDbPath: historyDbPath() } : {}),
      })
      if (!created.ok) {
        return { error: `fff engine init failed for ${basePath}: ${created.error} — the built-in search tools remain available` }
      }
      finder = created.value
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { error: `fff native library failed to load: ${message} — the built-in search tools remain available` }
    }
    if (persistent) this.#main.set(basePath, finder)
    else this.#aux.set(basePath, finder)
    try {
      await finder.waitForScan(waitMs)
    } catch {
      // waitForScan is a wait cap, not a success requirement; partial results
      // are surfaced via the `warming` flag on the lease.
    }
    return this.#lease(finder, basePath, aux)
  }
}

// ---------------------------------------------------------------------------
// Shared caps (mirroring pi-fff's token-economy limits)
// ---------------------------------------------------------------------------

export const GREP_LIMIT_DEFAULT = 30
export const GREP_LIMIT_MAX = 200
export const FIND_LIMIT_DEFAULT = 30
export const FIND_LIMIT_MAX = 200
export const CONTEXT_MAX = 20
export const LINE_MAX_CHARS = 500
export const TIME_BUDGET_DEFAULT_MS = 10_000
export const FILTER_MAX_EXTRA_PAGES = 20

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number.NaN
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// ---------------------------------------------------------------------------
// Query→file memory (ledger → fff feedback, the 1+1>2 weld)
// ---------------------------------------------------------------------------

/**
 * fff-node exposes no recordAccess API — the one honest learning channel is
 * trackQuery(query, selectedFilePath). When a search surfaces a file we note
 * the query; when ffedit then writes that file, the pairing is replayed into
 * the finder's query-history DB. Query and selection both genuinely happened,
 * so nothing synthetic enters the learning data. Bounded, in-memory, per
 * process.
 */
const queryMemory = new Map<string, { query: string; ts: number }>()
const QUERY_MEMORY_MAX = 200

export function noteQueryHit(absPath: string, query: string): void {
  const key = path.resolve(absPath).toLowerCase()
  queryMemory.delete(key)
  queryMemory.set(key, { query, ts: Date.now() })
  if (queryMemory.size > QUERY_MEMORY_MAX) {
    const first = queryMemory.keys().next().value
    if (first !== undefined) queryMemory.delete(first)
  }
}

export function takeQueryFor(absPath: string): string | null {
  const key = path.resolve(absPath).toLowerCase()
  return queryMemory.get(key)?.query ?? null
}

// ---------------------------------------------------------------------------
// Per-file write lock (same-file edit serialization)
// ---------------------------------------------------------------------------

const fileLocks = new Map<string, Promise<unknown>>()

/** Serialize mutations on one file across concurrent tool calls. */
export function withFileLock<T>(absPath: string, fn: () => Promise<T> | T): Promise<T> {
  const key = path.resolve(absPath).toLowerCase()
  const prev = fileLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => {})
  fileLocks.set(key, tail)
  void tail.then(() => {
    if (fileLocks.get(key) === tail) fileLocks.delete(key)
  })
  return next
}

/** Stable order prevents deadlocks when a batch spans several files. */
export function withFileLocks<T>(paths: string[], fn: () => Promise<T> | T): Promise<T> {
  const keys = [...new Set(paths.map(p => path.resolve(p).toLowerCase()))].sort()
  const lock = (index: number): Promise<T> => index === keys.length
    ? Promise.resolve().then(fn)
    : withFileLock(keys[index], () => lock(index + 1))
  return lock(0)
}

// ---------------------------------------------------------------------------
// Cursor store (bounded, in-memory — cursors are opaque to the model)
// ---------------------------------------------------------------------------

const cursorCache = new Map<string, GrepCursor>()
let cursorCounter = 0

export function storeCursor(cursor: GrepCursor): string {
  const id = `forge_c${++cursorCounter}`
  cursorCache.set(id, cursor)
  if (cursorCache.size > 200) {
    const first = cursorCache.keys().next().value
    if (first !== undefined) cursorCache.delete(first)
  }
  return id
}

export function takeCursor(id: string | undefined): GrepCursor | null {
  if (!id) return null
  return cursorCache.get(id) ?? null
}

// ---------------------------------------------------------------------------
// Path constraints
// ---------------------------------------------------------------------------

/** Split a pi-fff style constraint string: `*.ts !test/ docs/` */
export function parseConstraints(raw: string | undefined): { includes: string[]; excludes: string[] } {
  const includes: string[] = []
  const excludes: string[] = []
  for (const token of (raw ?? '').split(/\s+/).filter(Boolean)) {
    if (token.startsWith('!')) {
      if (token.length > 1) excludes.push(token.slice(1))
    } else {
      includes.push(token)
    }
  }
  return { includes, excludes }
}

/** Glob → RegExp supporting `**`, `*`, `?`, and `{a,b}` alternation. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*'
        i++
        if (glob[i + 1] === '/') i++ // `**/` also matches zero segments
      } else {
        source += '[^/\\\\]*'
      }
    } else if (ch === '?') {
      source += '[^/\\\\]'
    } else if (ch === '{') {
      source += '(?:'
    } else if (ch === '}') {
      source += ')'
    } else if (ch === ',') {
      source += '|'
    } else if ('\\^$.|+()[]'.includes(ch)) {
      source += `\\${ch}`
    } else {
      source += ch
    }
  }
  return new RegExp(`^(?:${source})$`, 'i')
}

/** Parse `L10-20` / `L10` / `10-20` into a 1-based inclusive range; null when malformed. */
export function parseLineRange(raw: string): { start: number; end: number } | null {
  const match = /^L?(\d+)(?:\s*-\s*(\d+))?$/i.exec(raw.trim())
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] === undefined ? start : Number(match[2])
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null
  return { start, end }
}

export interface ConstraintFilter {
  (relativePath: string): boolean
}

/** Compile include/exclude globs into one predicate over relative paths. */
export function compileConstraintFilter(raw: string | undefined): ConstraintFilter | undefined {
  const { includes, excludes } = parseConstraints(raw)
  if (includes.length === 0 && excludes.length === 0) return undefined
  const includeRes = includes.map(globToRegExp)
  const excludeRes = excludes.map(globToRegExp)
  const normalized = (p: string) => p.split(path.sep).join('/')
  return (relativePath: string) => {
    const p = normalized(relativePath)
    if (excludeRes.some((re) => re.test(p))) return false
    if (includeRes.length === 0) return true
    return includeRes.some((re) => re.test(p))
  }
}

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

export interface GrepItem {
  file: string
  line: number
  col: number
  text: string
  git: string
  frecency: number
  /** Enclosing symbol (grep→symbol weld), present when requested + resolvable. */
  in?: { name: string; startLine: number; endLine: number }
  context?: Array<{ line: number; text: string; before: boolean }>
}

export interface FindItem {
  path: string
  name: string
  score: number
  match: string
  git: string
  frecency: number
  size: number
  modified: string
}

function clip(text: string): string {
  return text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text
}

// Engine note: GrepOptions.classifyDefinitions exists in fff 0.11.0 but its
// classifier is unreliable for JS-family files (definition lines left unmarked,
// call sites flagged) — probed on the fixture corpus. We do not surface `def`
// in v1; precise definition boundaries are stage 2's tree-sitter job.

export function shapeGrepItem(match: GrepMatch): GrepItem {
  const item: GrepItem = {
    file: match.relativePath,
    line: match.lineNumber,
    col: match.col,
    text: clip(match.lineContent),
    git: match.gitStatus,
    frecency: match.totalFrecencyScore,
  }
  const before = match.contextBefore ?? []
  const after = match.contextAfter ?? []
  if (before.length > 0 || after.length > 0) {
    const context: Array<{ line: number; text: string; before: boolean }> = []
    before.forEach((text, i) => context.push({ line: match.lineNumber - before.length + i, text: clip(text), before: true }))
    after.forEach((text, i) => context.push({ line: match.lineNumber + i + 1, text: clip(text), before: false }))
    item.context = context
  }
  return item
}

export function shapeFindItem(item: FileItem, score: Score | undefined): FindItem {
  return {
    path: item.relativePath,
    name: item.fileName,
    score: score ? Math.round(score.total * 100) / 100 : 0,
    match: score?.matchType ?? '',
    git: item.gitStatus,
    frecency: item.totalFrecencyScore,
    size: item.size,
    modified: Number.isFinite(item.modified) && item.modified > 0 ? new Date(item.modified * 1000).toISOString().slice(0, 10) : '',
  }
}

// ---------------------------------------------------------------------------
// Rendering (the text the desktop UI shows for a tool result)
// ---------------------------------------------------------------------------

export function renderGrepItems(items: GrepItem[], header: string[]): string {
  const lines: string[] = [...header]
  for (const item of items) {
    const tag = item.in ? `  ⊙ ${item.in.name} L${item.in.startLine}-${item.in.endLine}` : ''
    lines.push(`${item.file}:${item.line}: ${item.text}${tag}`)
    for (const ctx of item.context ?? []) {
      lines.push(`  ${ctx.line} | ${ctx.text}`)
    }
  }
  return lines.join('\n')
}

export function renderFindItems(items: FindItem[], header: string[]): string {
  const lines: string[] = [...header]
  for (const item of items) {
    const bits = [item.match, item.git !== '' ? item.git : undefined, item.modified].filter(Boolean)
    lines.push(`${item.path}${bits.length > 0 ? `  (${bits.join(', ')})` : ''}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Temp-dir guard helper (re-exported for tests)
// ---------------------------------------------------------------------------

export function tempRoot(): string {
  return tmpdir()
}

export type { FileFinderApi, GrepMode, GrepResult, SearchResult }
