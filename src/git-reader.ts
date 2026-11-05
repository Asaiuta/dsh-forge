/**
 * Read-only git facts for the Git page: branch state, changed paths, and the
 * two text sides of one file.
 *
 * Every command is planned here and executed by an injected runner, so the
 * execution policy — sandboxed subprocess, scrubbed environment, timeout,
 * bounded output — stays outside this module. There is no mutation path at all:
 * nothing stages, commits, checks out, or writes an index.
 *
 * @module dsh-forge/git-reader
 */

import path from 'node:path'

/** One settled command: exit facts plus the text this module parses. */
export interface GitRunResult { exitCode: number; stdout: string; stderr: string }
/** Executes one `git <args>`; the caller owns sandboxing, timeouts and output caps. */
export type GitRun = (args: string[], options?: { cwd?: string }) => Promise<GitRunResult>
/** Reads one worktree file as text; returns null when it cannot be decoded. */
export type ReadWorktree = (absolute: string) => Promise<string | null>

/** A refusal or failure the Git page must show instead of guessing. */
export class GitReadError extends Error {
  constructor(message: string) { super(message); this.name = 'GitReadError' }
}

export interface GitBranch {
  head: string | null; oid: string | null; upstream: string | null
  ahead: number; behind: number; detached: boolean; initial: boolean
}
export interface GitEntry {
  path: string; origPath: string | null; status: string; x: string; y: string
  kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked'
  added: number | null; removed: number | null; binary: boolean
}
export interface GitStatus {
  isRepo: true; root: string; toplevel: string; prefix: string
  branch: GitBranch; remotes: string[]
  staged: GitEntry[]; changes: GitEntry[]; conflicts: GitEntry[]
  total: number; truncated: boolean
}
export interface GitDiffSide {
  exists: boolean; binary: boolean; oversized: boolean; text: string | null; bytes: number
}
export interface GitDiff { path: string; before: GitDiffSide; after: GitDiffSide }

/** Upper bound on one side shipped to the browser, matching the snapshot reader. */
const DEFAULT_MAX_SIDE_BYTES = 1024 * 1024
/** Matches how git words a path that simply has no such revision. */
const ABSENT_PATTERNS = /exists on disk, but not in|does not exist in|Path '.*' does not exist|but not in 'HEAD'|ambiguous argument 'HEAD'/i

/**
 * Whether one path segment is `.git` under any NTFS spelling.
 *
 * `.git`, `GIT~1` (8.3 short name), a trailing dot or space, and an alternate
 * data stream name all reach the same directory — the aliases behind
 * CVE-2014-9390 and CVE-2019-1352.
 */
export function isDotGitSegment(segment: string): boolean {
  const name = String(segment).toLowerCase().split(':')[0].replace(/[. ]+$/, '')
  return name === '.git' || /^git~\d+$/.test(name)
}

/**
 * Resolve a repository-relative path and refuse anything that escapes the root.
 *
 * @param root - absolute repository top level.
 * @param relative - the requested path, as git reports it.
 * @returns the normalised posix-style relative path.
 * @throws {GitReadError} when the path is absolute, escapes the root, or names `.git`.
 */
export function resolveInside(root: string, relative: string): string {
  if (typeof relative !== 'string' || !relative) throw new GitReadError('路径不能为空')
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) throw new GitReadError('路径必须是仓库相对路径')
  const normalised = path.posix.normalize(relative.replaceAll('\\', '/'))
  if (normalised === '..' || normalised.startsWith('../')) throw new GitReadError('路径不能超出仓库根目录')
  const segments = normalised.split('/').filter(Boolean)
  if (segments.some(isDotGitSegment)) throw new GitReadError('路径不能指向 .git')
  return normalised
}

/** Split `count` space-separated fields off the front of one NUL record. */
function takeFields(record: string, count: number): { fields: string[]; rest: string } | null {
  const fields: string[] = []
  let cursor = 0
  for (let index = 0; index < count; index += 1) {
    const next = record.indexOf(' ', cursor)
    if (next === -1) return null
    fields.push(record.slice(cursor, next))
    cursor = next + 1
  }
  return { fields, rest: record.slice(cursor) }
}

/**
 * Parse `git status --porcelain=v2 -z --branch`.
 *
 * Field counts, not splitting on whitespace, decide where a path begins, so
 * paths containing spaces stay whole. A rename record stores its original path
 * in the following NUL record.
 */
export function parsePorcelainV2(text: string): { branch: GitBranch; entries: GitEntry[] } {
  const records = String(text ?? '').split('\0')
  const branch: GitBranch = { head: null, oid: null, upstream: null, ahead: 0, behind: 0, detached: false, initial: false }
  const entries: GitEntry[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const kind = record[0]
    if (kind === '#') {
      const [, key, ...rest] = record.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') branch.oid = value
      else if (key === 'branch.head') { branch.head = value; branch.detached = value === '(detached)'; branch.initial = value === '(initial)' }
      else if (key === 'branch.upstream') branch.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) { branch.ahead = Number(match[1]); branch.behind = Number(match[2]) }
      }
      continue
    }
    if (kind === '?') { entries.push({ kind: 'untracked', path: record.slice(2), origPath: null, status: 'U', x: '?', y: '?', added: null, removed: null, binary: false }); continue }
    if (kind === '1') {
      const parsed = takeFields(record, 8)
      if (parsed) entries.push({ kind: 'ordinary', path: parsed.rest, origPath: null, status: parsed.fields[1], x: parsed.fields[1][0], y: parsed.fields[1][1], added: null, removed: null, binary: false })
      continue
    }
    if (kind === '2') {
      const parsed = takeFields(record, 9)
      const origPath = records[index + 1] || null
      index += 1
      if (parsed) entries.push({ kind: 'renamed', path: parsed.rest, origPath, status: parsed.fields[1], x: parsed.fields[1][0], y: parsed.fields[1][1], added: null, removed: null, binary: false })
      continue
    }
    if (kind === 'u') {
      const parsed = takeFields(record, 10)
      if (parsed) entries.push({ kind: 'unmerged', path: parsed.rest, origPath: null, status: parsed.fields[1], x: parsed.fields[1][0], y: parsed.fields[1][1], added: null, removed: null, binary: false })
    }
  }
  return { branch, entries }
}

/**
 * Parse `git diff --numstat -z`.
 *
 * A `-`/`-` pair marks a binary file, which carries no line counts — never NaN.
 *
 * @returns path to counts, with `null` for binary.
 */
export function parseNumstat(text: string): Map<string, { added: number; removed: number } | null> {
  const counts = new Map<string, { added: number; removed: number } | null>()
  for (const record of String(text ?? '').split('\0')) {
    if (!record) continue
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first === -1 || second === -1) continue
    const added = record.slice(0, first), removed = record.slice(first + 1, second), file = record.slice(second + 1)
    if (!file) continue
    counts.set(file, added === '-' || removed === '-' ? null : { added: Number(added), removed: Number(removed) })
  }
  return counts
}

/** Split entries the way editors do: staged, worktree changes, and conflicts. */
export function groupEntries(entries: GitEntry[]): { staged: GitEntry[]; changes: GitEntry[]; conflicts: GitEntry[] } {
  const staged: GitEntry[] = [], changes: GitEntry[] = [], conflicts: GitEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'unmerged') { conflicts.push(entry); continue }
    if (entry.kind === 'untracked') { changes.push(entry); continue }
    if (entry.x !== '.') staged.push(entry)
    if (entry.y !== '.') changes.push(entry)
  }
  const byPath = (a: GitEntry, b: GitEntry) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  staged.sort(byPath); changes.sort(byPath); conflicts.sort(byPath)
  return { staged, changes, conflicts }
}

/**
 * Read the repository state for one directory.
 *
 * @param workspace - absolute directory; may sit inside a repository.
 * @param run - command runner owned by the caller.
 * @returns `{isRepo: false}` when the directory is simply not in a repository.
 * @throws {GitReadError} on any other git failure, so a broken repository is
 *   never disguised as "no repository".
 */
export async function readGitStatus(workspace: string, run: GitRun): Promise<GitStatus | { isRepo: false }> {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new GitReadError('workspace 必须是绝对路径')
  const root = path.resolve(workspace)
  const found = await run(['rev-parse', '--show-toplevel'], { cwd: root })
  if (found.exitCode === 128 && /not a git repository/i.test(found.stderr)) return { isRepo: false }
  if (found.exitCode !== 0) throw new GitReadError(`git rev-parse 失败：${found.stderr.trim() || found.exitCode}`)
  const toplevel = path.resolve(found.stdout.trim())
  const prefix = path.relative(toplevel, root).replaceAll('\\', '/')
  const [statusResult, countsResult, remotesResult] = await Promise.all([
    run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { cwd: toplevel }),
    run(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff'], { cwd: toplevel }),
    run(['remote'], { cwd: toplevel }),
  ])
  if (statusResult.exitCode !== 0) throw new GitReadError(`git status 失败：${statusResult.stderr.trim() || statusResult.exitCode}`)
  const { branch, entries } = parsePorcelainV2(statusResult.stdout)
  const counts = countsResult.exitCode === 0 ? parseNumstat(countsResult.stdout) : new Map<string, { added: number; removed: number } | null>()
  for (const entry of entries) {
    const counted = counts.get(entry.path)
    if (counted) { entry.added = counted.added; entry.removed = counted.removed }
    else if (counted === null) entry.binary = true
  }
  const grouped = groupEntries(entries)
  return {
    isRepo: true, root, toplevel, prefix,
    branch, remotes: remotesResult.exitCode === 0 ? remotesResult.stdout.split('\n').map(line => line.trim()).filter(Boolean) : [],
    ...grouped, total: entries.length, truncated: false,
  }
}

/** Describe one side, refusing to ship bytes that are not text. */
function side(text: string | null, maxBytes: number): GitDiffSide {
  if (text === null) return { exists: true, binary: true, oversized: false, text: null, bytes: 0 }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (text.includes('\0')) return { exists: true, binary: true, oversized: false, text: null, bytes }
  if (bytes > maxBytes) return { exists: true, binary: false, oversized: true, text: null, bytes }
  return { exists: true, binary: false, oversized: false, text, bytes }
}

/**
 * Read both text sides of one file: the index revision and the worktree.
 *
 * @param workspace - absolute directory inside the repository.
 * @param relative - repository-relative path; escapes are refused.
 * @param run - command runner.
 * @param readWorktree - reads the worktree file; `null` for undecodable bytes.
 * @param options - `maxBytes` caps one side.
 * @returns the two sides, with `exists: false` for a side git has no revision for.
 */
export async function readGitDiff(
  workspace: string, relative: string, run: GitRun, readWorktree: ReadWorktree,
  options: { maxBytes?: number } = {},
): Promise<GitDiff> {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new GitReadError('workspace 必须是绝对路径')
  const root = path.resolve(workspace)
  const found = await run(['rev-parse', '--show-toplevel'], { cwd: root })
  if (found.exitCode !== 0) throw new GitReadError(`git rev-parse 失败：${found.stderr.trim() || found.exitCode}`)
  const toplevel = path.resolve(found.stdout.trim())
  const inside = resolveInside(toplevel, relative)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SIDE_BYTES
  const staged = await run(['show', `:${inside}`], { cwd: toplevel })
  const before: GitDiffSide = staged.exitCode === 0
    ? side(staged.stdout, maxBytes)
    : ABSENT_PATTERNS.test(staged.stderr) ? { exists: false, binary: false, oversized: false, text: null, bytes: 0 }
    : (() => { throw new GitReadError(`读取 ${inside} 的索引版本失败：${staged.stderr.trim() || staged.exitCode}`) })()
  const text = await readWorktree(path.join(toplevel, ...inside.split('/')))
  const after: GitDiffSide = text === null ? { exists: false, binary: false, oversized: false, text: null, bytes: 0 } : side(text, maxBytes)
  return { path: inside, before, after }
}
