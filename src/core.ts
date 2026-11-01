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
import { readdirSync } from 'node:fs'
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
/** Cap for the scan of a one-shot root outside the workspace. */
const TEMP_SCAN_WAIT_MS = 8_000
/**
 * Entries a root may hold before a one-shot index is refused outright.
 *
 * A root outside the workspace is indexed only to answer one question, and the
 * cost of that scales with size: measured here, 30,736 files scan in 302 ms
 * (`D:\AI\云服务器`) while 208,904 scan in 21.3 s (`C:\Users`). Twenty-one
 * seconds behind a tool call is indistinguishable from a hang, and the caller
 * can always narrow `path` or use the machine index — so above this ceiling the
 * index is not built and the call fails with that instruction instead.
 */
const TEMP_MAX_ENTRIES = 50_000
/**
 * How long a one-shot index survives after it is built.
 *
 * It cannot be torn down the moment the query returns: `ffgrep` pages with a
 * cursor, and every page replays the same query against the same finder —
 * rebuilding per page would make pagination quadratic. A short TTL covers the
 * follow-up calls and then releases both the memory and the watch handles,
 * which is the difference between "borrowed for a query" and "kept forever".
 */
const TEMP_TTL_MS = 30_000
/**
 * Budget for counting a root's entries before indexing it.
 *
 * Bounded by the ceiling itself: the count stops as soon as it proves the root
 * is too big, so refusing `C:\Users` costs about one fifth of a second instead
 * of the 21 s a scan would.
 */
const TEMP_PROBE_MS = 250

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

/** How long a self-heal rescan may take before the retry reads what exists. */
const RESCAN_WAIT_MS = 3_000
/**
 * Minimum gap between two evidence-driven rebuilds of the same root.
 *
 * An empty page is the trigger, and empty pages are routine, so a rebuild that
 * ran a moment ago cannot have been invalidated yet. Kept close to the engine's
 * own watcher round trip (3.4–4.3 s measured here) rather than to a human sense
 * of "recently": a longer window would swallow the write-then-search sequence
 * this exists to rescue, which completes in well under a second.
 */
const RESCAN_THROTTLE_MS = 3_000

/**
 * Cheap pre-flight: can this root be indexed without a long scan?
 *
 * Counts entries breadth-first, no stat, and stops as soon as the answer is
 * decided. Two ways to be refused: the count passes the ceiling, or the budget
 * runs out before the count finished — an unfinished count is not a promise
 * that the root is small, and the roots that fail to enumerate in a quarter of
 * a second are exactly the 200k-entry ones this ceiling exists for.
 *
 * @returns `over` true when the root must not be indexed.
 */
function countEntries(root: string, limit: number, budgetMs: number): { count: number; over: boolean } {
  const queue: string[] = [root]
  const started = Date.now()
  let count = 0
  while (queue.length > 0) {
    if (Date.now() - started > budgetMs) return { count, over: true }
    const dir = queue.shift()
    if (dir === undefined) break
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++count > limit) return { count, over: true }
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name))
    }
  }
  return { count, over: false }
}

export interface FinderLease {
  finder: FileFinderApi
  /** Root the engine actually indexed. */
  basePath: string
  /** True when still warming up — results may be partial. */
  warming: boolean
  /**
   * True for a one-shot index of a root outside the workspace.
   *
   * Such a finder learns nothing worth keeping: no frecency rows, no query
   * history, and an expiry. Only the workspace index is long-lived.
   */
  temporary: boolean
  /**
   * Epoch ms when this root last finished a scan (creation or rescan).
   *
   * The engine's watcher demonstrably loses events (see `rescan`), so "nothing
   * matched" is only trustworthy relative to how current the scan is. A caller
   * compares this against directory mtimes to decide whether to rebuild before
   * claiming a file or a line is absent.
   */
  scannedAt: number
  /** Release an explicitly retained temporary finder after the complete tool call. */
  release?: () => void
}

export class FinderPool {
  readonly #main = new Map<string, FileFinderApi>()
  /**
   * The single one-shot finder allowed at a time. There is no pool: a root
   * outside the workspace is collateral for one question, and a pool of them is
   * how eight entries used to sit in memory long after anyone asked about them.
   */
  #temp: { basePath: string; finder: FileFinderApi; timer: ReturnType<typeof setTimeout>; readers: number } | null = null
  readonly #initing = new Map<string, Promise<FinderLease | ToolFailure>>()
  #tempIniting: { root: string; promise: Promise<FinderLease | ToolFailure> } | null = null
  /** `scannedAt` per root — kept beside the finders so leases stay snapshots. */
  readonly #scannedAt = new Map<string, number>()
  /** `last rescan` epoch ms per root — the throttle for evidence-driven rebuilds. */
  readonly #rescannedAt = new Map<string, number>()
  #destroyed = false

  /** Diagnostics for /forge-status: every live finder with its root. */
  live(): Array<{ finder: FileFinderApi; basePath: string; temporary: boolean }> {
    const rows: Array<{ finder: FileFinderApi; basePath: string; temporary: boolean }> = []
    for (const [basePath, finder] of this.#main) rows.push({ finder, basePath, temporary: false })
    if (this.#temp !== null) rows.push({ finder: this.#temp.finder, basePath: this.#temp.basePath, temporary: true })
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
    const inFlight = this.#initing.get(resolved)
    if (inFlight) return inFlight
    const existing = this.#main.get(resolved)
    if (existing && !existing.isDestroyed) return this.#lease(existing, resolved, false)
    const created = this.#create(resolved, true, MAIN_SCAN_WAIT_MS)
    this.#initing.set(resolved, created)
    try {
      return await created
    } finally {
      this.#initing.delete(resolved)
    }
  }

  /**
   * One-shot finder for a root outside the workspace.
   *
   * Three limits, all of them earned by measurement:
   *
   * 1. **Size ceiling.** Indexing cost scales with the tree, and the tail is a
   *    cliff: 30,736 files scan in 302 ms, 208,904 files in 21.3 s. Above
   *    `TEMP_MAX_ENTRIES` no index is built — the call fails with an
   *    instruction ("narrow path / use the machine index") instead of parking
   *    behind a scan nobody asked to wait for. The refusal itself costs the
   *    `TEMP_PROBE_MS` budget, not the scan.
   * 2. **One at a time.** A second root replaces an idle finder; active queries
   *    retain their lease and a competing root receives a retryable error.
   * 3. **Expiry.** `TEMP_TTL_MS` after the last touch the finder is destroyed,
   *    releasing its memory and its watch handles. The window exists because
   *    `ffgrep` pages with a cursor against the same finder.
   *
   * No frecency or history DBs: learning data derived from a narrowed root
   * would be noise for the workspace index.
   */
  async temporary(constraintRoot: string, options: { retain?: boolean } = {}): Promise<FinderLease | ToolFailure> {
    if (this.#destroyed) return { error: 'dsh-forge finder pool was disposed' }
    const resolved = path.resolve(constraintRoot)
    if (isFsRoot(resolved)) return { error: `refusing to index the filesystem root ${resolved}` }
    if (this.#temp !== null && this.#temp.basePath === resolved && !this.#temp.finder.isDestroyed) {
      this.#touchTemp()
      return this.#retainTemporary(this.#lease(this.#temp.finder, resolved, true), options.retain)
    }
    if (this.#tempIniting !== null) {
      if (this.#tempIniting.root !== resolved) return { error: 'another temporary index is initializing; retry after it finishes or narrow path= to the workspace' }
      return this.#retainTemporary(await this.#tempIniting.promise, options.retain)
    }
    const pending = this.#createTemporary(resolved)
    this.#tempIniting = { root: resolved, promise: pending }
    try { return this.#retainTemporary(await pending, options.retain) } finally {
      if (this.#tempIniting?.promise === pending) this.#tempIniting = null
    }
  }

  async #createTemporary(resolved: string): Promise<FinderLease | ToolFailure> {
    if (this.#temp && this.#temp.readers > 0) return { error: 'temporary index has active readers; retry after the current query finishes' }
    const probe = countEntries(resolved, TEMP_MAX_ENTRIES, TEMP_PROBE_MS)
    if (probe.over) {
      return {
        error: `refusing to index ${resolved}: more than ${TEMP_MAX_ENTRIES.toLocaleString('en-US')} entries`
          + ` — narrow path= to a subdirectory, or use the machine index (fffind answers names outside the workspace without an index)`,
      }
    }
    this.#dropTemp()
    const created = await this.#create(resolved, false, TEMP_SCAN_WAIT_MS)
    if ('error' in created) return created
    this.#temp = {
      basePath: resolved,
      finder: created.finder,
      readers: 0,
      timer: setTimeout(() => this.#expireTemp(), TEMP_TTL_MS),
    }
    // Never the reason the process stays alive.
    ;(this.#temp.timer as { unref?: () => void }).unref?.()
    return created
  }

  #retainTemporary(lease: FinderLease | ToolFailure, retain = false): FinderLease | ToolFailure {
    if ('error' in lease || !retain) return lease
    const entry = this.#temp
    if (!entry || entry.finder !== lease.finder || entry.finder.isDestroyed) return { error: 'temporary index expired during initialization; retry' }
    entry.readers++
    let released = false
    return { ...lease, release: () => {
      if (released) return
      released = true
      entry.readers--
      if (this.#temp === entry) this.#touchTemp()
    } }
  }

  #expireTemp(): void {
    if (this.#temp && this.#temp.readers > 0) this.#touchTemp()
    else this.#dropTemp()
  }

  /** Restart the expiry clock so a paging cursor keeps its finder. */
  #touchTemp(): void {
    if (this.#temp === null) return
    clearTimeout(this.#temp.timer)
    this.#temp.timer = setTimeout(() => this.#expireTemp(), TEMP_TTL_MS)
    ;(this.#temp.timer as { unref?: () => void }).unref?.()
  }

  #dropTemp(): void {
    if (this.#temp === null) return
    clearTimeout(this.#temp.timer)
    this.#safeDestroy(this.#temp.finder)
    this.#scannedAt.delete(this.#temp.basePath)
    this.#rescannedAt.delete(this.#temp.basePath)
    this.#temp = null
  }

  disposeAll(): void {
    this.#destroyed = true
    for (const finder of this.#main.values()) this.#safeDestroy(finder)
    this.#dropTemp()
    this.#main.clear()
    this.#initing.clear()
    this.#scannedAt.clear()
    this.#rescannedAt.clear()
  }

  /**
   * Rebuild a root's index on evidence that it is behind, and say whether the
   * caller should retry the query.
   *
   * The engine watches the tree, but the watch is not a guarantee: measured on
   * this repo, a file created inside the workspace stayed invisible to
   * `fileSearch` for the whole 2.5 s probe window (`isScanning()` false, four
   * retries), while `scanFiles()` listed it 1.2 s later — reproduced with the
   * engine defaults as well as with `disableMmapCache` /
   * `disableContentIndexing`, so events are simply lost sometimes. A page that
   * is silently one file behind reads exactly like "that file does not exist".
   *
   * Throttled per root: callers ask on every empty page, and an empty page is
   * common, so a rebuild that just ran is not repeated until the tree has had
   * time to change again.
   *
   * @returns true when a rebuild actually ran, i.e. a retry is worth it.
   */
  async rescan(lease: FinderLease, options: { waitMs?: number; throttleMs?: number } = {}): Promise<boolean> {
    if (this.#destroyed) return false
    const throttle = options.throttleMs ?? RESCAN_THROTTLE_MS
    const previous = this.#rescannedAt.get(lease.basePath) ?? 0
    if (Date.now() - previous < throttle) return false
    try {
      lease.finder.scanFiles()
    } catch {
      return false
    }
    this.#rescannedAt.set(lease.basePath, Date.now())
    try {
      await lease.finder.waitForScan(options.waitMs ?? RESCAN_WAIT_MS)
    } catch {
      // A wait cap, not a requirement — the retry reports what the engine has.
    }
    lease.warming = true
    try { lease.warming = lease.finder.isScanning() } catch { /* unknown completion stays partial */ }
    if (!lease.warming) {
      const now = Date.now()
      this.#scannedAt.set(lease.basePath, now)
      lease.scannedAt = now
    }
    return true
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

  #lease(finder: FileFinderApi, basePath: string, temporary: boolean): FinderLease {
    let warming = false
    try {
      warming = finder.isScanning()
    } catch {
      warming = false
    }
    return { finder, basePath, warming, temporary, scannedAt: this.#scannedAt.get(basePath) ?? 0 }
  }

  async #create(basePath: string, persistent: boolean, waitMs: number): Promise<FinderLease | ToolFailure> {
    let finder: FileFinderApi
    // Engine defect (fff 0.11.0, measured 2026-10-31): when the **first**
    // finder in a process runs with the mmap cache + content index enabled,
    // every later finder never completes its scan — `scannedFilesCount` stays
    // 0, `isScanning()` stays true, and all queries return empty forever. That
    // silent empty is worse than an error: it reads as "no such file", and it
    // is why `fffind path=<outside the workspace>` could look broken while the
    // workspace index was live. Bisected: disabling either option fixes it,
    // `disableWatch` does not. Measured on this repo (3.4k files): grep is
    // 22 ms with both disabled vs 102–139 ms with them on, so the engine's
    // "content index" is a cost here, not a win. `FORGE_CONTENT_INDEX=1`
    // restores the old behaviour for single-root users who want it.
    const engineOptions = process.env.FORGE_CONTENT_INDEX === '1'
      ? {}
      : { disableContentIndexing: true, disableMmapCache: true }
    try {
      const created = FileFinder.create({
        basePath,
        aiMode: true,
        enableFsRootScanning: false,
        enableHomeDirScanning: true,
        followSymlinks: true,
        ...engineOptions,
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
    // Only the workspace index is registered here; a one-shot finder is held by
    // `#temp` instead, which owns its expiry.
    if (persistent) this.#main.set(basePath, finder)
    try {
      await finder.waitForScan(waitMs)
    } catch {
      // waitForScan is a wait cap, not a success requirement; partial results
      // are surfaced via the `warming` flag on the lease.
    }
    if (this.#destroyed) {
      this.#safeDestroy(finder)
      return { error: 'dsh-forge finder pool was disposed during initialization' }
    }
    const lease = this.#lease(finder, basePath, !persistent)
    if (!lease.warming) {
      lease.scannedAt = Date.now()
      this.#scannedAt.set(basePath, lease.scannedAt)
    }
    return lease
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
  // Grouping is a byte trade, not a style choice: a path costs its own length on
  // every row, while a heading costs one line per file. So a file with two or
  // more hits drops its path from each row after the first, and a lone hit keeps
  // the inline `path:line: text` form — there a heading would add a line instead
  // of saving any. Same bytes on a one-hit page, ~30% fewer on a 250-row one.
  const perFile = new Map<string, number>()
  for (const item of items) perFile.set(item.file, (perFile.get(item.file) ?? 0) + 1)
  let heading: string | undefined
  for (const item of items) {
    const grouped = (perFile.get(item.file) ?? 0) > 1
    if (!grouped) {
      heading = undefined
      lines.push(`${item.file}:${item.line}: ${item.text}`)
    } else {
      if (heading !== item.file) {
        heading = item.file
        lines.push(item.file)
      }
      lines.push(`  ${item.line}: ${item.text}`)
    }
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
 * Three conditions, all measured rather than tuned:
 *
 * 1. **No literal occurrence.** No returned path contains the query (or, for a
 *    multi-term query, every term) as a case-insensitive substring. This is a
 *    fact about the result, not a threshold: a genuine prefix query such as
 *    `guidanc` → `src/guidance.ts` matches literally and stays silent.
 * 2. **A handful of hits at most.** A genuine typo query produces a *ranked
 *    list* of dozens of candidates — the ranking is the answer. The window is
 *    12 rather than 3 because a real session got exactly **6** weak hits for a
 *    name that exists nowhere in that tree (`reverse-workbench` under a
 *    Windows user folder): all 6 were scattered-subsequence coincidences at
 *    score 80–96, and the old 3-item ceiling let them through unlabelled.
 * 3. **Scores in coincidence territory.** Measured on this corpus: junk hits
 *    parked at 80–96, while a literal name under the right root scores 220–296
 *    and an exact filename 610. A floor of 150 separates them with margin, so
 *    a short ranked list of *plausible* typos is still not annotated.
 *
 * @param query - the raw pattern the caller passed.
 * @param items - the shaped results, in engine rank order.
 * @returns true when the caller should be told the name surface has no answer.
 */
export function weakNameMatch(
  query: string,
  items: FindItem[],
  limits: { maxItems?: number; scoreFloor?: number } = {},
): boolean {
  const maxItems = limits.maxItems ?? 12
  const scoreFloor = limits.scoreFloor ?? 150
  if (items.length === 0 || items.length > maxItems) return false
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
  if (terms.length === 0) return false
  const literal = items.some((item) => {
    const path = item.path.toLowerCase()
    return terms.every((term) => path.includes(term))
  })
  if (literal) return false
  return Math.max(...items.map((item) => item.score)) < scoreFloor
}

// ---------------------------------------------------------------------------
// Temp-dir guard helper (re-exported for tests)
// ---------------------------------------------------------------------------

export function tempRoot(): string {
  return tmpdir()
}

export type { FileFinderApi, GrepMode, GrepResult, SearchResult }
