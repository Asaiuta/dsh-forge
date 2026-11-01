/**
 * Everything (es.exe) as the literal-name backend for `fffind mode=name`.
 *
 * Why a backend and not a tool: a machine-wide MFT index answers "where is this
 * name" in ~0.3 s and, unlike the fff engine, it also returns **directories** —
 * a skill folder is exactly the case that motivated this. But Everything has no
 * fuzzy tolerance, no frecency, no git status and no glob semantics, so it can
 * only ever be the *literal* half of the search. Keep it behind the existing
 * tool so the model never has to choose between two finders.
 *
 * Every failure path here is a *fallback*, never an empty answer: a missing
 * binary, a stopped Everything process, a timeout and a genuine zero-hit page
 * all hand control back to fff, with the reason kept for the caller.
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** es.exe answers in ~0.3 s; anything past this is a stopped IPC endpoint. */
const DEFAULT_TIMEOUT_MS = 2_500
const MAX_LIMIT = 200

export interface GlobalHit {
  /** Absolute path; directories end with a separator. */
  path: string
  size: number
  /** `YYYY-MM-DD`, empty when the file could not be stat'ed. */
  modified: string
  isDirectory: boolean
}

export type GlobalLookup =
  | { status: 'hit'; hits: GlobalHit[] }
  | { status: 'miss' }
  | { status: 'unavailable'; reason: string }

export type EsRunner = (
  esPath: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>

export interface GlobalSearchOptions {
  /** Directory to constrain the search to (`-path`). */
  root?: string
  limit?: number
  timeoutMs?: number
  /** `auto`: Windows + es.exe found. `everything`: caller explicitly asked. */
  mode?: 'auto' | 'everything' | 'off'
  /** Explicit binary path (config wins over discovery). */
  esPath?: string
  /** Test seam; production uses execFile. */
  run?: EsRunner
  /** Test seam for the platform gate. */
  platform?: NodeJS.Platform
}

const defaultRunner: EsRunner = async (esPath, args, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(esPath, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (cause) {
    const e = cause as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (e.killed ? 'timeout' : String(cause)),
    }
  }
}

/**
 * Locate `es.exe`. Order is deliberate: an explicit path must win (the binary
 * is not on PATH on a default Everything install — that is the common case),
 * then PATH, then the two default install roots.
 */
export function resolveEsPath(override?: string): string | undefined {
  const explicit = [override, process.env.FORGE_ES_PATH].filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  for (const candidate of explicit) {
    if (existsSync(candidate)) return candidate
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, 'es.exe')
    if (existsSync(candidate)) return candidate
  }
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter((v): v is string => typeof v === 'string' && v !== '')
  for (const root of roots) {
    const candidate = path.join(root, 'Everything', 'es.exe')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** es prints one absolute path per line; blank lines and duplicates are noise. */
export function parseEsOutput(stdout: string): string[] {
  const seen = new Set<string>()
  const rows: string[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || seen.has(line)) continue
    seen.add(line)
    rows.push(line)
  }
  return rows
}

function hydrate(absolute: string): GlobalHit {
  let size = 0
  let modified = ''
  let isDirectory = false
  try {
    const st = statSync(absolute)
    isDirectory = st.isDirectory()
    size = st.isDirectory() ? 0 : st.size
    if (Number.isFinite(st.mtimeMs) && st.mtimeMs > 0) modified = new Date(st.mtimeMs).toISOString().slice(0, 10)
  } catch {
    // A path the index knows but the disk does not: keep the row, it is still
    // the honest answer to "where did the index see this name".
  }
  return {
    path: isDirectory ? `${absolute.replace(/[\\/]+$/, '')}${path.sep}` : absolute,
    size,
    modified,
    isDirectory,
  }
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '').trim().slice(0, 200)
}

/**
 * Query the machine index for a **literal** name.
 *
 * Callers must pre-filter: a glob or a typo belongs to fff. `miss` means the
 * index is healthy and holds nothing under that literal string; every other
 * failure is `unavailable` so the caller can say why it fell back.
 */
export async function everythingSearch(query: string, options: GlobalSearchOptions = {}): Promise<GlobalLookup> {
  const mode = options.mode ?? 'auto'
  if (mode === 'off') return { status: 'unavailable', reason: 'disabled' }
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { status: 'unavailable', reason: 'windows only' }

  const esPath = resolveEsPath(options.esPath)
  if (esPath === undefined) return { status: 'unavailable', reason: 'es.exe not found' }

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 30), 1), MAX_LIMIT)
  const args = ['-n', String(limit)]
  if (options.root) args.push('-path', options.root)
  args.push(query)

  const result = await (options.run ?? defaultRunner)(esPath, args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (result.code !== 0) {
    return { status: 'unavailable', reason: firstLine(result.stderr) || `exit ${result.code}` }
  }
  const rows = parseEsOutput(result.stdout)
  if (rows.length === 0) return { status: 'miss' }
  return { status: 'hit', hits: rows.slice(0, limit).map(hydrate) }
}
