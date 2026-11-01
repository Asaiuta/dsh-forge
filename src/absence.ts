/**
 * Why an empty page is empty.
 *
 * `no files matched` is ambiguous. The tree may genuinely not contain the
 * thing — or dsh-forge may simply not be able to *see* it. Two visibility
 * limits produce the second case, and neither is inferable from a tool
 * description:
 *
 *  1. The FFF index holds FILES only. A pattern that names a directory can
 *     never match it: `** /dsh-compaction*` and `** /dsh-compaction` both
 *     return 0, while `** /dsh-compaction/**` returns the files inside.
 *  2. The index prunes some trees unless the scope root is *inside* them.
 *     Observed on the DSH checkout (`resources/app`, which carries no
 *     `.gitignore` at any of three levels): `** / *` sees 54 files from `app`
 *     and 23,432 from `app/node_modules`, and ripgrep at `app` sees 25,893.
 *     So the SAME pattern returns 0 from the parent and 12 from the child.
 *
 * Measured on a real session (db0cb9db): five of eighteen tool calls came back
 * empty. Four of the five were the two limits above, not missing data — the
 * model spent five calls discovering a directory it had named correctly on the
 * first attempt.
 *
 * This module walks the scope root **directly, skipping nothing** (that is the
 * point) under a hard budget, then says what the index could not show. It runs
 * only when a page came back empty, so the cost is paid once per failed call.
 * It is evidence, not a guess: a path is only described as "not indexed" after
 * the engine itself fails to list it.
 *
 * @module dsh-forge/absence
 */

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Depth of every diagnostic walk.
 *
 * Three levels cover both jobs. For the note: the top-level segment the index
 * prunes (`node_modules/`) and the shape `src/client/foo.tsx`. For freshness:
 * the parent of any file a session realistically creates. Measured on this repo
 * with a name that is absent — depth 6 costs 416 ms (name walk) / 149 ms
 * (freshness walk), depth 3 costs 7 ms / 8 ms. The deep levels are almost
 * entirely build output and dependency trees, which `HEAVY_DIRS` skips anyway;
 * what is left in them is a name nobody searches for.
 */
const MAX_DEPTH = 3
/** Visited-entry budget. A 23k-file `node_modules` finishes well inside this. */
const MAX_ENTRIES = 60_000
/** Wall-clock budget for the freshness walk. */
const MAX_MS = 400
/** Wall-clock budget for the name walk. */
const NOTE_MS = 120
/** Matches are evidence, not an enumeration; three is enough to fix the call. */
const MAX_HITS = 3
/** Directories never worth entering (pseudo-filesystems, VCS metadata). */
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '$RECYCLE.BIN', 'System Volume Information', 'lost+found'])
/**
 * Dependency trees and build output.
 *
 * Two reasons, and only the second one is about speed. The index does not hold
 * these trees — fff honours `.gitignore` — so a name found here produces the
 * note "exists on disk" for a file the caller can never search; the honest
 * answer for `node_modules/x` is the visibility note, not a path. And they are
 * most of the tree: on this repo, entering them doubled the entries visited
 * (12,664 → 24,701) and took 300 of the 400 ms budget.
 */
const HEAVY_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages',
  'target', 'dist', 'build', 'out', 'obj',
  '.venv', 'venv', 'site-packages', '__pycache__', '.tox',
  '.next', '.nuxt', '.turbo', '.parcel-cache', 'coverage',
])
/** Longest reminder we are willing to add to a failed page. */
const MAX_NOTE = 360

export interface AbsenceHit {
  /** POSIX-style path relative to the scope root. */
  readonly rel: string
  readonly dir: boolean
}

export interface AbsenceWalk {
  readonly hits: AbsenceHit[]
  /** The walk stopped on a budget, so absence of further hits means nothing. */
  readonly truncated: boolean
}

/**
 * The longest run of literal characters in a pattern, ignoring separators and
 * glob/regex syntax. `** / *compaction*` → `compaction`; `** /dsh-compaction/**`
 * → `dsh-compaction`. Returns `''` when nothing is long enough to search for
 * without producing noise.
 */
export function literalNeedle(query: string): string {
  let best = ''
  for (const segment of query.split(/[/\\]/)) {
    const literal = segment.replace(/[^A-Za-z0-9_\-.]+/g, '').replace(/^\.+/, '')
    if (literal.length > best.length) best = literal
  }
  return best.length >= 3 ? best : ''
}

/**
 * Breadth-first, budgeted search for names containing `needle`.
 *
 * Breadth-first so a shallow match is found before the walk descends into a
 * large tree. Symlinks are not followed, which also rules out cycles.
 *
 * Bounded in depth as well as in time: the note only ever needs the top few
 * levels (see `MAX_DEPTH`), and an unbounded walk spends its budget
 * proving a negative across build output. Measured on this repo, a name that is
 * absent: 416 ms at depth 6 vs 7 ms at depth 3.
 */
export function walkForName(root: string, needle: string): AbsenceWalk {
  const lower = needle.toLowerCase()
  const hits: AbsenceHit[] = []
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }]
  const started = Date.now()
  let visited = 0
  let truncated = false

  walk: while (queue.length > 0) {
    if (Date.now() - started > NOTE_MS || visited >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const current = queue.shift()
    if (current === undefined) break
    if (current.depth + 1 > MAX_DEPTH) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited >= MAX_ENTRIES || Date.now() - started > NOTE_MS) {
        truncated = true
        break walk
      }
      const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`
      const dir = entry.isDirectory()
      if (entry.name.toLowerCase().includes(lower)) {
        hits.push({ rel, dir })
        if (hits.length >= MAX_HITS) break walk
      }
      if (dir && current.depth + 1 <= MAX_DEPTH && !SKIP_DIRS.has(entry.name) && !HEAVY_DIRS.has(entry.name)) {
        queue.push({ dir: path.join(current.dir, entry.name), rel, depth: current.depth + 1 })
      }
    }
  }
  return { hits, truncated }
}

/**
 * Did anything appear under this root since the index last scanned it?
 *
 * The counterpart of `walkForName` for content queries. A grep page that is
 * empty cannot be checked by name — the answer depends on bytes — so the only
 * honest question left is whether the index could still be *behind*. Directory
 * mtimes answer that: creating or deleting an entry bumps its parent, so a
 * directory newer than the scan is a directory the index has not seen the
 * current shape of.
 *
 * Deliberately cheap: one readdir per directory plus one stat per subdirectory,
 * no file reads. It cannot see a file whose *contents* changed in place (that
 * does not touch the parent's mtime) — the overlay in `tools.ts` covers the
 * files this session wrote, which is where that case actually bites.
 *
 * @param root - scope root of the lease that produced the empty page.
 * @param sinceMs - `lease.scannedAt`: epoch ms of the last completed scan.
 * @param budgetMs - wall-clock cap, same budget as the absence walk.
 */
export function walkNewerThan(root: string, sinceMs: number, budgetMs = MAX_MS): { newer: string[]; truncated: boolean } {
  const newer: string[] = []
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }]
  const started = Date.now()
  let visited = 0
  let truncated = false

  // The root itself: adding a file directly under it bumps only its own mtime.
  try {
    if (statSync(root).mtimeMs > sinceMs) newer.push('')
  } catch {
    // an unreadable root is not evidence of staleness
  }

  walk: while (queue.length > 0) {
    if (Date.now() - started > budgetMs || visited >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const current = queue.shift()
    if (current === undefined) break
    if (current.depth + 1 > MAX_DEPTH) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited >= MAX_ENTRIES || Date.now() - started > budgetMs) {
        truncated = true
        break walk
      }
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || HEAVY_DIRS.has(entry.name)) continue
      const abs = path.join(current.dir, entry.name)
      const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`
      let mtime = 0
      try {
        mtime = statSync(abs).mtimeMs
      } catch {
        continue
      }
      if (mtime > sinceMs) {
        newer.push(rel)
        if (newer.length >= MAX_HITS) break walk
      }
      queue.push({ dir: abs, rel, depth: current.depth + 1 })
    }
  }
  return { newer, truncated }
}

function clip(value: string, max = 72): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - (max - 1 - head))}`
}

/**
 * One clause, phrased as the call that would have found it.
 *
 * Earlier versions emitted one clause per hit — `"node_modules/" is a directory
 * (these tools list files only) — use path="node_modules"; "node_modules/accepts/
 * node_modules/" is a directory, not indexed at this scope — use path=…`. On a
 * real page that read as a debug dump: nested quotes, a suggestion that
 * repeated the segment the caller had already typed, and three different
 * explanations of one empty result. The first hit is the evidence; the rest is
 * a count. A path is only called invisible after `canList` — a real engine
 * probe — says its containing segment is pruned.
 *
 * @param hit - first name the disk walk found.
 * @param matches - how many names the walk found in total.
 * @param canList - engine probe for a top-level segment.
 * @param truncated - the walk hit a budget, so the list is not exhaustive.
 */
function clause(
  hit: AbsenceHit,
  matches: number,
  canList: (segment: string) => boolean,
  truncated: boolean,
  rescanned: boolean,
): string {
  const shown = clip(hit.rel, 58)
  const rest = matches > 1 ? ` (+${matches - 1} more)` : ''
  const partial = truncated ? '; disk walk stopped early, list is partial' : ''
  if (hit.dir) {
    const segment = hit.rel.includes('/') ? (hit.rel.split('/')[0] ?? '') : ''
    const hidden = segment !== '' && !canList(segment)
    return hidden
      ? `[directory "${shown}/" is not visible at this scope${rest} — search inside it with path="${shown}"${partial}]`
      : `[ffind lists files only: "${shown}/" is a directory${rest} — search inside it with path="${shown}"${partial}]`
  }
  // The file is on disk, the index was rebuilt, and it is still absent. That is
  // an exclusion (ignore rule, scope), not a spelling problem — and saying so
  // is the whole reason for rescanned.
  if (rescanned) {
    return `[no match — "${shown}" is on disk but the rebuilt index still excludes it${rest}${partial}]`
  }
  return `[no match, but "${shown}" exists on disk${rest} — the pattern matches case-sensitively${partial}]`
}

export interface AbsenceLookup {
  /** Absolute root of the finder lease that produced the empty page. */
  readonly scopeRoot: string
  /** What the caller was looking for (glob pattern, fuzzy query, grep text). */
  readonly query: string
  /**
   * Engine-backed probe: can the index see anything under this path segment?
   * Injected so the wording never claims an exclusion the engine does not have.
   */
  readonly canList: (segment: string) => boolean
  /**
   * The caller rebuilt the index after this name was found on disk. Turns the
   * note from "you may have mis-typed it" into "the index excludes it".
   */
  readonly rescanned?: boolean
  /**
   * A walk the caller already ran (it needed the same answer to decide whether
   * to rebuild the index). Passing it back keeps an empty page at one disk walk
   * instead of two — measured 805 ms vs 400 ms for a name that is simply absent.
   */
  readonly walk?: AbsenceWalk
}

/**
 * Explain an empty page, or return `undefined` when the disk agrees that there
 * is nothing to find (or nothing specific enough to search for).
 *
 * The note is a single sentence by construction — see `clause` — so there is no
 * budget-trimming loop and no possibility of ending mid-clause.
 */
export function explainAbsence(lookup: AbsenceLookup): string | undefined {
  const needle = literalNeedle(lookup.query)
  if (needle === '') return undefined
  const { hits, truncated } = lookup.walk ?? walkForName(lookup.scopeRoot, needle)
  if (hits.length === 0) return undefined
  const note = clause(hits[0], hits.length, lookup.canList, truncated, lookup.rescanned === true)
  return note.length <= MAX_NOTE ? note : `${note.slice(0, MAX_NOTE - 1)}…]`
}
