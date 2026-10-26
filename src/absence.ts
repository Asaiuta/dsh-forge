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

import { readdirSync } from 'node:fs'
import path from 'node:path'

/** Depth of the diagnostic walk. Deep enough for `node_modules/@scope/pkg/…`. */
const MAX_DEPTH = 6
/** Visited-entry budget. A 23k-file `node_modules` finishes well inside this. */
const MAX_ENTRIES = 60_000
/** Wall-clock budget. Bounds the added latency of a failed call. */
const MAX_MS = 400
/** Matches are evidence, not an enumeration; three is enough to fix the call. */
const MAX_HITS = 3
/** Directories never worth entering (pseudo-filesystems, VCS metadata). */
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '$RECYCLE.BIN', 'System Volume Information', 'lost+found'])
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
 */
export function walkForName(root: string, needle: string): AbsenceWalk {
  const lower = needle.toLowerCase()
  const hits: AbsenceHit[] = []
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }]
  const started = Date.now()
  let visited = 0
  let truncated = false

  walk: while (queue.length > 0) {
    if (Date.now() - started > MAX_MS || visited >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const current = queue.shift()
    if (current === undefined) break
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited >= MAX_ENTRIES || Date.now() - started > MAX_MS) {
        truncated = true
        break walk
      }
      const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`
      const dir = entry.isDirectory()
      if (entry.name.toLowerCase().includes(lower)) {
        hits.push({ rel, dir })
        if (hits.length >= MAX_HITS) break walk
      }
      if (dir && current.depth + 1 <= MAX_DEPTH && !SKIP_DIRS.has(entry.name)) {
        queue.push({ dir: path.join(current.dir, entry.name), rel, depth: current.depth + 1 })
      }
    }
  }
  return { hits, truncated }
}

function clip(value: string, max = 72): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - (max - 1 - head))}`
}

/**
 * One clause per hit, phrased as the call that would have found it.
 *
 * A path is only called "not indexed" after `canList` — a real engine probe —
 * says its containing segment is invisible. A top-level entry is never called
 * excluded: it is simply a directory, or a name the pattern did not match.
 */
function describe(hit: AbsenceHit, canList: (segment: string) => boolean): { text: string; excluded: string | null } {
  const nested = hit.rel.includes('/')
  const segment = nested ? (hit.rel.split('/')[0] ?? hit.rel) : ''
  // Only a nested path can be invisible because a *container* is unindexed.
  const hidden = nested && !canList(segment)
  const shown = clip(hit.rel, 58)
  if (hit.dir) {
    return hidden
      ? { text: `"${shown}/" is a directory, not indexed at this scope — use path="${shown}"`, excluded: segment }
      : { text: `"${shown}/" is a directory (these tools list files only) — use path="${shown}"`, excluded: null }
  }
  return hidden
    ? { text: `"${shown}" exists on disk, not indexed at this scope`, excluded: segment }
    : { text: `"${shown}" exists on disk — matching is case-sensitive`, excluded: null }
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
}

/**
 * Explain an empty page, or return `undefined` when the disk agrees that there
 * is nothing to find (or nothing specific enough to search for).
 *
 * Clauses are added until the budget runs out rather than truncated, so the
 * note never ends mid-sentence.
 */
export function explainAbsence(lookup: AbsenceLookup): string | undefined {
  const needle = literalNeedle(lookup.query)
  if (needle === '') return undefined
  const { hits, truncated } = walkForName(lookup.scopeRoot, needle)
  if (hits.length === 0) return undefined

  const head = `no match for "${needle}", but the tree on disk contains it:`
  const described = hits.map(hit => describe(hit, lookup.canList))
  const excluded = new Set<string>()
  for (const item of described) {
    if (item.excluded !== null && item.excluded !== needle) excluded.add(item.excluded)
  }
  // The "why" is worth more than the third example, so the closing sentence is
  // fixed first and example clauses are dropped from the end until it fits.
  const tails: string[] = []
  if (excluded.size > 0) {
    tails.push(`${[...excluded].map(name => `"${name}"`).join(', ')} is not indexed at this scope — point path inside it to search there`)
  }
  if (truncated) tails.push('the disk walk stopped early, so this list is partial')

  const chosen = described.map(item => item.text)
  while (chosen.length > 0) {
    const note = [head, chosen.join('; '), ...tails].join(' ').trim()
    if (note.length <= MAX_NOTE) return note
    chosen.pop()
  }
  return [head, ...tails].join(' ').trim()
}
