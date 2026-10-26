/**
 * Write-through overlay: what this process just wrote, searchable before the
 * index catches up.
 *
 * ## Why this exists
 *
 * fff's index becomes consistent only through a scan: `scanFiles()` costs
 * ~2.3 s on a 5.7k-file tree, and the background watcher takes 3.4-4.3 s to
 * surface a write (both measured). The engine exposes no per-file incremental
 * rebuild — `scanFiles()`, `watch()` and `refreshGitStatus()` are the whole
 * surface.
 *
 * So "write a file, then search what I just wrote" — the most frequent two-step
 * in a coding session — could answer *wrongly*, not merely slowly. Measured on
 * the 5.8k-file tree: a file created a moment earlier yields 0 hits (173 ms
 * spent searching a file list that does not contain it yet), and an overwritten
 * file keeps answering with the symbol that was just deleted.
 *
 * The overlay closes exactly that window without touching the engine: it keeps
 * the bytes this process committed and answers for those files from memory
 * (the created-file query above: 4 ms and 2 hits, against 173 ms and 0).
 *
 * ## Contract
 *
 * - Only files this process wrote are overlaid, and only for
 *   {@link OVERLAY_TTL_MS}. Outside that window the overlay is empty and
 *   behaviour is byte-for-byte what it was before.
 * - The overlay is *authoritative* for its files: index hits from an overlaid
 *   path are dropped, because the index cannot tell which of them are stale.
 *   Keeping both would show a line that no longer exists next to its
 *   replacement.
 * - It never invents hits the engine would not have found: the same bytes on
 *   disk, the same pattern semantics, the same limits.
 *
 * ## Matching semantics are copied, not invented
 *
 * The engine's `grep` has two behaviours that are not what their names suggest,
 * both probed on 5.8k files (see `docs`/memory for the numbers):
 *
 *   smartCase: true   all-lowercase query matches case-insensitively
 *                     (`createreadtool` → 67 hits incl. 57 camelCase)
 *   smartCase: false  ALWAYS case-sensitive — the opposite of "always
 *                     insensitive". 5 hits, all lowercase-only.
 *
 * An overlay that guessed "false means insensitive" would return a different
 * answer from the engine for the same query on a neighbouring file, in the same
 * page. {@link matchesCase} therefore reproduces the measured behaviour.
 *
 * @module dsh-forge/overlay
 */

import path from 'node:path'
import { GREP_MAX_MATCHES_PER_FILE, LINE_MAX_CHARS, type GrepItem } from './core.ts'

/**
 * How long a committed file stays authoritative.
 *
 * Must exceed the slowest path by which the index learns about a write (the
 * watcher, measured 3.4-4.3 s), with room for a slow machine. It is deliberately
 * not infinite: an overlaid file eventually has to stop shadowing the index, or
 * a long session would keep answering from memory for files it no longer holds
 * (external edits, a revert from another process).
 */
export const OVERLAY_TTL_MS = 15_000

/** Engine defaults this layer has to mirror for the overlay and the index to agree. */
const MAX_FILE_BYTES = 10 * 1024 * 1024

interface Entry {
  /** Absolute path, as committed. */
  abs: string
  /** Exactly the bytes written — not a re-read, so a concurrent writer cannot slip in. */
  bytes: Buffer
  /** When it was committed (epoch ms). */
  at: number
  /**
   * True for a deletion. The index keeps serving the file's old lines until a
   * scan catches up, so "I deleted that" has to shadow the index too — otherwise
   * a deleted file keeps showing up in search results, which is worse than a
   * stale line.
   */
  removed: boolean
}

/** Keyed by normalized absolute path, so `D:/X` and `d:\x` are one file. */
const entries = new Map<string, Entry>()

function key(absPath: string): string {
  const resolved = path.resolve(absPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Remember the bytes just committed to `absPath`.
 *
 * Called from `commitFiles`, which is the single write funnel for ffedit,
 * ff_file and rollback — so every path that can make a file disagree with the
 * index is covered by one hook.
 *
 * @param absPath - the file that was written.
 * @param bytes - the exact bytes written, or `null` when the file was deleted.
 */
export function markWritten(absPath: string, bytes: Buffer | string | null): void {
  const buf = bytes === null ? Buffer.alloc(0) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8')
  entries.set(key(absPath), { abs: path.resolve(absPath), bytes: buf, at: Date.now(), removed: bytes === null })
}

/** One overlaid file, resolved against the caller's index root. */
export interface OverlayFile {
  /** Absolute path (original spelling). */
  abs: string
  /** Slash-separated path relative to the requested root. */
  rel: string
  bytes: Buffer
}

/** What the overlay says about one index root. */
export interface OverlaySnapshot {
  /** Files whose committed content is authoritative and searchable, newest first. */
  files: OverlayFile[]
  /**
   * Every relative path the index must not be trusted for — written *or*
   * deleted. Index hits under these paths are dropped before the overlay's own
   * results are merged in.
   */
  shadowed: Set<string>
}

/**
 * Resolve the overlay against `basePath`, dropping expired entries.
 *
 * @param basePath - the index root the caller is searching.
 * @param now - clock override for tests.
 */
export function overlaySnapshot(basePath: string, now = Date.now()): OverlaySnapshot {
  const root = path.resolve(basePath)
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root
  const prefix = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep
  const live: Array<{ entry: Entry; rel: string }> = []
  for (const [k, entry] of entries) {
    if (now - entry.at > OVERLAY_TTL_MS) {
      entries.delete(k)
      continue
    }
    if (k !== rootKey && !k.startsWith(prefix)) continue
    live.push({ entry, rel: path.relative(root, entry.abs).split(path.sep).join('/') })
  }
  // Newest first: the file just edited is the likeliest answer to "where is it".
  live.sort((a, b) => b.entry.at - a.entry.at)
  const files: OverlayFile[] = []
  const shadowed = new Set<string>()
  for (const { entry, rel } of live) {
    shadowed.add(rel)
    if (!entry.removed) files.push({ abs: entry.abs, rel, bytes: entry.bytes })
  }
  return { files, shadowed }
}

/** Test hook: forget everything. */
export function clearOverlay(): void {
  entries.clear()
}

/**
 * The engine's case rule, measured rather than assumed.
 *
 * @param pattern - the raw query.
 * @param smartCase - the engine option (this layer always passes `true`).
 * @returns whether matching ignores case.
 */
export function matchesCase(pattern: string, smartCase: boolean): boolean {
  if (!smartCase) return false
  return pattern === pattern.toLowerCase()
}

/** Build the matcher for one query, or `null` when the mode cannot be mirrored. */
function matcherFor(
  pattern: string,
  mode: 'plain' | 'regex' | 'fuzzy',
  smartCase: boolean,
): ((line: string) => number) | null {
  // `fuzzy` scores by an algorithm this file does not have, and a rough
  // approximation would put hits in the page that the index would never
  // produce. Refusing the mode is honest; the caller then keeps index-only
  // results for this query, which is exactly the previous behaviour.
  if (mode === 'fuzzy') return null
  const flags = matchesCase(pattern, smartCase) ? 'i' : ''
  if (mode === 'regex') {
    let re: RegExp
    try {
      re = new RegExp(pattern, flags)
    } catch {
      // The engine falls back to literal matching on an uncompilable pattern and
      // reports it in `regexFallbackError`; mirror the fallback, not the error.
      return literalMatcher(pattern, flags)
    }
    return (line) => {
      const m = re.exec(line)
      return m === null ? -1 : m.index
    }
  }
  return literalMatcher(pattern, flags)
}

function literalMatcher(needle: string, flags: string): (line: string) => number {
  if (needle === '') return () => -1
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  return (line) => {
    const m = re.exec(line)
    return m === null ? -1 : m.index
  }
}

function clip(text: string): string {
  return text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text
}

/**
 * Search the overlaid files with the engine's semantics.
 *
 * @param files - output of {@link overlayFiles}.
 * @param pattern - the raw query.
 * @param options - the same values the caller passed to the engine.
 * @returns items shaped exactly like {@link GrepItem}, in file order.
 */
export function searchOverlay(
  files: OverlayFile[],
  pattern: string,
  options: { mode: 'plain' | 'regex' | 'fuzzy'; smartCase: boolean; context: number; limit: number },
): GrepItem[] {
  const match = matcherFor(pattern, options.mode, options.smartCase)
  if (match === null || files.length === 0 || pattern === '') return []
  const items: GrepItem[] = []
  for (const file of files) {
    // `limit` is applied at a FILE boundary, never mid-file: the engine collects
    // a whole file before it checks `pageSize`, which is why `pageSize: 5` on a
    // 500-match file still returns 501 items. Cutting mid-file here would make an
    // overlaid file answer differently from an identical file the index knows.
    if (items.length >= options.limit) break
    if (file.bytes.length > MAX_FILE_BYTES) continue
    // The engine skips binary files; a NUL byte is its own tell.
    if (file.bytes.includes(0)) continue
    const lines = file.bytes.toString('utf8').split(/\r?\n/)
    let inFile = 0
    for (let i = 0; i < lines.length; i++) {
      if (inFile >= GREP_MAX_MATCHES_PER_FILE) break
      const line = lines[i]
      const at = match(line)
      if (at < 0) continue
      inFile++
      // The engine reports a 0-based BYTE column; count bytes, not code units.
      const col = Buffer.byteLength(line.slice(0, at), 'utf8')
      const item: GrepItem = {
        file: file.rel,
        line: i + 1,
        col,
        text: clip(line),
        // Git status is the index's business and the index has not seen this
        // write yet; claiming 'M' here would be a guess the caller cannot check.
        git: '',
        frecency: 0,
      }
      const radius = Math.max(0, options.context)
      if (radius > 0) {
        const context: Array<{ line: number; text: string; before: boolean }> = []
        for (let k = Math.max(0, i - radius); k < i; k++) context.push({ line: k + 1, text: clip(lines[k]), before: true })
        for (let k = i + 1; k <= Math.min(lines.length - 1, i + radius); k++) {
          context.push({ line: k + 1, text: clip(lines[k]), before: false })
        }
        if (context.length > 0) item.context = context
      }
      items.push(item)
    }
  }
  return items
}
