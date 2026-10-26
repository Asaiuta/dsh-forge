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

/**
 * Windows drives, UNC roots, and POSIX `/` are all refused as index roots.
 *
 * The test is equality against the parsed root, NOT `root === dir`: for a
 * single-segment absolute path (`C:\Users`, `D:\work`) `path.dir`
 * *is* the drive root, so the older form refused every top-level directory on a
 * drive. That is precisely the case the guidance promises — "pass path at any
 * directory (another checkout, another drive)" — and it was measured failing in
 * three real sessions (`refusing to index the filesystem root C:\Users`,
 * `… D:\work`).
 */
export function isFsRoot(dir: string): boolean {
  const resolved = path.resolve(dir)
  return resolved === path.parse(resolved).root
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
  agent?: {
    session?: { header?: { cwd?: string; id?: string } }
    /** Present on the real host agent (blackhole reads the same fields for
     *  compaction routing); optional here — provenance labels degrade to
     *  "session" when absent. */
    options?: { provider?: string; model?: string }
  }
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

/**
 * Read a file through the host's observation channel before any write.
 *
 * DSH's write-intent policy refuses a mutation whose target this session has
 * not observed (`fs/observed`). A bare `readFileSync` reads the bytes but
 * publishes nothing, so the write is refused with "read the current file
 * through DSH/forge before editing" — measured on seven `ff_file` removals in
 * one session, all of which succeeded once the model had run `ff_read` over the
 * same paths first. `finish()` publishes the version the write is then checked
 * against; for a file that does not exist yet it publishes `absent`, which is
 * what the host's `createIfAbsent` guard needs.
 *
 * @param exec - tool execution context; without a host channel this degrades to
 *   a plain read of `file`.
 * @param file - absolute path of the file about to be read (and later written).
 * @param read - reader taking the resolved path the host wants read.
 * @returns whatever `read` returned.
 */
export async function observedRead<T>(
  exec: ForgeExec | undefined,
  file: string,
  read: (path: string) => T | Promise<T>,
): Promise<T> {
  if (!exec?.beginNativeRead) return read(file)
  const observed = await exec.beginNativeRead(file)
  const value = await read(observed.path)
  await observed.finish()
  return value
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
// Raised from 4. A single session that scoped into `app`, `app/node_modules`,
// `.../@deepseek-ai`, `.../dsh-compaction`, `.../dsh-compaction-basic` and
// `tests` created six distinct aux roots, so roots were evicted and recreated
// cold mid-run — each rebuild racing a 5 s budget on a 23k-file tree. That race
// is what made the same call return 3816 matches once and 0 the next time.
const AUX_POOL_MAX = 8

/**
 * Ceiling for a background pre-warm to reach the *fully ready* state.
 *
 * `main()` waits for the file scan only (`MAIN_SCAN_WAIT_MS`); the content
 * index and bigram warmup keep running afterwards, and a query issued during
 * that window is answered by a live fallback pass — measured on a 5k-file tree:
 * the scan-only path still cost ~1.9 s per query, while the fully ready index
 * answered in 1 ms. Pre-warming therefore has to wait for readiness, not for the
 * scan, and it may take its time because nothing is blocked on it.
 */
const PREWARM_READY_WAIT_MS = 120_000

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

  /**
   * Build — or finish building — the index for a workspace root in the
   * background, and resolve once queries are at steady state.
   *
   * The plugin is otherwise lazy ("nothing at session start"), which is correct
   * for a profile that never searches but leaves the *first* real query paying
   * for everything: measured on a 5k-file tree, 2.9 s cold, ~2.0 s on a second
   * session even with the index already on disk (because only the scan was
   * awaited, not the warmup), then 4 ms once a pre-warm had finished the same
   * work off the critical path. Pre-warming moves that cost into idle time.
   *
   * Everything here is best-effort by construction: a destroyed pool, a refused
   * root (filesystem root), or a slow engine all resolve quietly. The tool path
   * rebuilds or reports the real failure when a query actually needs it, and a
   * background failure must never surface as an unhandled rejection in the host.
   *
   * @param basePath - workspace root to index.
   */
  async warm(basePath: string): Promise<void> {
    if (this.#destroyed) return
    try {
      const lease = await this.main(basePath)
      if ('error' in lease) return
      const ready = (lease.finder as { waitForIndexReady?: (timeoutMs?: number) => Promise<unknown> }).waitForIndexReady
      if (typeof ready === 'function') await ready.call(lease.finder, PREWARM_READY_WAIT_MS)
    } catch {
      // Best-effort: see the doc comment.
    }
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
/**
 * Per-file match cap handed to the engine.
 *
 * The engine collects matches a whole file at a time and only then stops at
 * `pageSize`, so this cap — not `limit` — is what bounds a page when one file
 * matches a lot: measured on a 500-match file, `pageSize: 5` still returned 501
 * items. A cap of 200 (the engine default) therefore drops the rest of that file
 * with `nextCursor: null`, i.e. the lines are gone and nothing says so. Raised
 * an order of magnitude so only a genuinely pathological file reaches it; when
 * one does, the page carries a note naming it.
 */
export const GREP_MAX_MATCHES_PER_FILE = 2_000
export const FIND_LIMIT_DEFAULT = 30
export const FIND_LIMIT_MAX = 200
export const GLOB_LIMIT_DEFAULT = 100
export const GLOB_LIMIT_MAX = 1000
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

/**
 * Glob → RegExp supporting `**`, `*`, `?`, and `{a,b}` alternation.
 *
 * @param glob - the pattern.
 * @param insensitive - `i` flag. True for forge's own constraints (a Windows
 *   model typing `*.TS` means `*.ts`); **false** when the result has to answer
 *   for ripgrep's `--glob`, whose case sensitivity follows the filesystem.
 */
export function globToRegExp(glob: string, insensitive = true): RegExp {
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
  return new RegExp(`^(?:${source})$`, insensitive ? 'i' : '')
}

/** Parse `L10-20` / `L10` / `10-20` into a 1-based inclusive range; null when malformed. */
export function parseLineRange(raw: string): { start: number; end: number } | null {
  // The second bound may carry its own "L" too. Models write "L180-L420" as
  // naturally as "L180-420" (the "L" reads as "line"), and a real session hit
  // the rejection in exactly that form before retrying — the prefix is noise
  // either way, so accept both.
  const match = /^L?(\d+)(?:\s*-\s*L?(\d+))?$/i.exec(raw.trim())
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
  // Wrapped, not passed by reference: `map` would hand the array index in as
  // `insensitive`, and index 0 is falsy — which silently made the first glob
  // case-SENSITIVE.
  const includeRes = includes.map((glob) => globToRegExp(glob))
  const excludeRes = excludes.map((glob) => globToRegExp(glob))
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
  /**
   * 0-based **byte** offset of the match within the line, as the engine reports
   * it — not a 1-based character column. A caller that needs to point at the
   * text must index by bytes (`Buffer.byteLength(line.slice(0, at), 'utf8')`),
   * which is what `overlay.ts` does to stay in the same unit.
   */
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

/**
 * Detect the "looked in the wrong place" find result, so the tool can say so
 * instead of handing back a coincidence as if it were an answer.
 *
 * A name search only answers a name question. When the query names something
 * that is not a file — a package, a symbol, a config value — fff still returns
 * its best fuzzy coincidences, and a caller that gets one line back has no way
 * to tell "found it" from "nothing here, here is my least-bad guess".
 *
 * Two conditions, both required, both measured rather than tuned:
 *
 * 1. **No literal occurrence.** No returned path contains the query (or, for a
 *    multi-term query, every term) as a case-insensitive substring. This is a
 *    fact about the result, not a threshold: a genuine prefix query such as
 *    `guidanc` → `src/guidance.ts` matches literally and stays silent.
 * 2. **A handful of hits at most.** A genuine typo query produces a *ranked
 *    list* — the ranking is the answer, and annotating it is noise. Measured on
 *    this corpus: `stroe` returned 50 candidates, while a query naming a
 *    non-file (`dsh-forge`) returned exactly 1 coincidence at score 70 —
 *    against 116 for a real prefix match and 219 for an exact one.
 *
 * @param query - the raw pattern the caller passed.
 * @param items - the shaped results, in engine rank order.
 * @param maxItems - most hits that can still count as "a couple of coincidences".
 * @returns true when the caller should be told the name surface has no answer.
 */
export function weakNameMatch(query: string, items: FindItem[], maxItems = 3): boolean {
  if (items.length === 0 || items.length > maxItems) return false
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
  if (terms.length === 0) return false
  return items.every((item) => {
    const path = item.path.toLowerCase()
    return !terms.every((term) => path.includes(term))
  })
}

// ---------------------------------------------------------------------------
// Temp-dir guard helper (re-exported for tests)
// ---------------------------------------------------------------------------

export function tempRoot(): string {
  return tmpdir()
}

export type { FileFinderApi, GrepMode, GrepResult, SearchResult }
