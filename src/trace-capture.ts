/**
 * Persisted capture baselines (M1.1).
 *
 * A snapshot in `trace-snapshot.ts` lives for one process and is bound to the
 * file *set*: enough to say "which graph answered", not enough to say "these
 * were the bytes". A baseline has to survive the process — the whole point is
 * to compare what the code looked like before an edit with what it looks like
 * after — so it is written to a private data area, keyed by workspace and
 * snapshot id, and each file carries the hash of the bytes that were parsed.
 *
 * Three rules this module exists to enforce:
 *
 *   - **Content-bound means bytes were hashed, not files were listed.** A
 *     baseline whose files were not all read is `observed`, and the caller must
 *     say so. There is no path here that upgrades an incomplete capture.
 *   - **No cap is paid for by silently dropping evidence.** Hitting the count or
 *     byte budget returns an explicit result; a truncated baseline would answer
 *     "no new problem" for files it never saw.
 *   - **Nothing is stored in the project.** The data area is outside the
 *     workspace, so a capture never dirties the repo it is measuring.
 *
 * Baselines are keyed by an unguessable snapshot id and scoped to a workspace;
 * loading one for another workspace is a miss, never a fallback.
 *
 * @module dsh-forge/trace-capture
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { dataDir } from './core.ts'
import type { TraceFileFacts } from './facts.ts'
import type { TraceConfigIdentity } from './trace-snapshot.ts'

/** Bumped when the stored shape changes; old files are then simply unusable. */
export const CAPTURE_SCHEMA = 'trace-capture/2'

/** Baseline lifetime. Short on purpose: a baseline answers "what did this look
 *  like during this edit session", not "what did the tree look like last week". */
export const CAPTURE_TTL_MS = 24 * 60 * 60 * 1000
/** Per workspace. Beyond this the oldest is rotated out and the caller is told. */
export const MAX_BASELINES_PER_WORKSPACE = 20
/** Per workspace, total on disk. A single oversized capture is refused. */
export const MAX_BASELINE_BYTES = 128 * 1024 * 1024

export interface CapturedFile {
  /** Workspace-relative, `/`-separated. */
  path: string
  /** SHA-256 of the exact bytes that were parsed. */
  rawHash: string
  /** SHA-256 of the canonical text derived from them. */
  textHash: string
  bytes: number
}

export interface CaptureBaseline {
  schema: typeof CAPTURE_SCHEMA
  snapshotId: string
  /** Absolute, canonical workspace root. Never crosses workspaces. */
  workspaceId: string
  configKey: string
  config: TraceConfigIdentity
  /** `wasm` until the sidecar can return a content identity for its input. */
  provider: 'wasm' | 'native'
  providerVersion: string
  createdAt: string
  strength: 'content-bound'
  files: CapturedFile[]
  fileSetDigest: string
  probes: number
  scanned: number
  truncated: boolean
  partialFiles: number
  parseErrors: number
  walkErrors: number
  /** Bytes actually read (source candidates only). */
  capturedBytes: number
  /** Canonical facts, keyed by workspace-relative path. */
  facts: Record<string, TraceFileFacts>
}

export type CaptureSave =
  | { ok: true; path: string; bytes: number; evicted?: string }
  | { ok: false; reason: 'too_large' | 'write_failed' | 'incomplete'; detail: string }

export type CaptureLoad =
  | { ok: true; baseline: CaptureBaseline; path: string }
  | { ok: false; reason: 'missing' | 'expired' | 'corrupt' | 'other_workspace'; detail: string }

/** One stable directory per workspace. The hash keeps distinct roots apart even
 *  when their basenames collide (`app` under two parents). */
function workspaceDir(workspaceId: string): string {
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 16)
  const label = path.basename(workspaceId).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 32) || 'workspace'
  return path.join(dataDir(), 'verification', `${label}-${digest}`)
}

function ttlMs(): number {
  const raw = process.env.DSH_FORGE_CAPTURE_TTL_MS
  if (raw === undefined) return CAPTURE_TTL_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : CAPTURE_TTL_MS
}

export function captureDirFor(workspaceId: string): string {
  return workspaceDir(workspaceId)
}

/** Every stored baseline for one workspace, newest last. */
function listFiles(workspaceId: string): Array<{ path: string; bytes: number; mtimeMs: number }> {
  const dir = workspaceDir(workspaceId)
  if (!existsSync(dir)) return []
  const out: Array<{ path: string; bytes: number; mtimeMs: number }> = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      const st = statSync(file)
      out.push({ path: file, bytes: st.size, mtimeMs: st.mtimeMs })
    } catch { /* vanished between listing and stat */ }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs)
}

/** Remove expired baselines. Returns what it freed, so a caller can report it. */
export function pruneBaselines(workspaceId: string, now: number = Date.now()): { removed: number; bytes: number } {
  let removed = 0, bytes = 0
  const ttl = ttlMs()
  for (const entry of listFiles(workspaceId)) {
    if (now - entry.mtimeMs <= ttl) continue
    try {
      rmSync(entry.path, { force: true })
      removed++
      bytes += entry.bytes
    } catch { /* another process owns it; the next prune retries */ }
  }
  return { removed, bytes }
}

export function baselineStats(workspaceId: string): { count: number; bytes: number; oldest: string | null; newest: string | null } {
  const files = listFiles(workspaceId)
  const bytes = files.reduce((sum, entry) => sum + entry.bytes, 0)
  return {
    count: files.length,
    bytes,
    oldest: files.length ? new Date(files[0].mtimeMs).toISOString() : null,
    newest: files.length ? new Date(files[files.length - 1].mtimeMs).toISOString() : null,
  }
}

/**
 * Persist one capture.
 *
 * Refuses anything that is not a complete content-bound record: a truncated
 * scan or a file that failed to read cannot be stored as a baseline, because a
 * later "no new problem" verdict would then cover files the baseline never saw.
 */
export function saveBaseline(baseline: CaptureBaseline): CaptureSave {
  if (!completeBaseline(baseline)) {
    return {
      ok: false,
      reason: 'incomplete',
      detail: `捕获不完整（截断=${baseline.truncated}，读取/解析失败=${baseline.parseErrors}，部分解析=${baseline.partialFiles}，遍历失败=${baseline.walkErrors}，覆盖=${baseline.files.length}/${baseline.scanned}）；不能作为内容基线保存`,
    }
  }
  const payload = JSON.stringify(baseline)
  const bytes = Buffer.byteLength(payload, 'utf8')
  const existing = listFiles(baseline.workspaceId)
  const used = existing.reduce((sum, entry) => sum + entry.bytes, 0)
  // A single oversized capture is not evictable: dropping older baselines to fit
  // it would destroy the evidence the user already had.
  if (bytes > MAX_BASELINE_BYTES) {
    return { ok: false, reason: 'too_large', detail: `单个基线 ${(bytes / 1048576).toFixed(1)} MiB 超过 ${MAX_BASELINE_BYTES / 1048576} MiB 预算` }
  }
  const dir = workspaceDir(baseline.workspaceId)
  let evicted: string | undefined
  try {
    mkdirSync(dir, { recursive: true })
    pruneBaselines(baseline.workspaceId)
    let budget = listFiles(baseline.workspaceId)
    while (budget.length >= MAX_BASELINES_PER_WORKSPACE || budget.reduce((sum, entry) => sum + entry.bytes, 0) + bytes > MAX_BASELINE_BYTES) {
      const oldest = budget.shift()
      if (!oldest) break
      rmSync(oldest.path, { force: true })
      evicted = path.basename(oldest.path, '.json')
    }
    const target = path.join(dir, `${baseline.snapshotId}.json`)
    const temp = `${target}.tmp-${randomBytes(4).toString('hex')}`
    writeFileSync(temp, payload, 'utf8')
    // Rename is the commit point: a reader never sees a half-written baseline.
    renameSync(temp, target)
    return { ok: true, path: target, bytes, ...(evicted ? { evicted } : {}) }
  } catch (cause) {
    return { ok: false, reason: 'write_failed', detail: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Load one baseline by snapshot id inside one workspace. */
export function loadBaseline(workspaceId: string, snapshotId: string, now: number = Date.now()): CaptureLoad {
  if (!/^[0-9a-f]{24}$/.test(snapshotId)) return { ok: false, reason: 'missing', detail: `快照 ID 格式无效：${snapshotId}` }
  const file = path.join(workspaceDir(workspaceId), `${snapshotId}.json`)
  if (!existsSync(file)) {
    return { ok: false, reason: 'missing', detail: '该快照不在本进程内存中，也没有落盘基线（可能已过期或被清理）' }
  }
  let parsed: CaptureBaseline
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as CaptureBaseline
  } catch (cause) {
    return { ok: false, reason: 'corrupt', detail: `基线无法解析：${cause instanceof Error ? cause.message : String(cause)}` }
  }
  // Shape first, then identity: a record that cannot describe itself must not be
  // used to compare anything.
  if (!parsed || parsed.schema !== CAPTURE_SCHEMA || !Array.isArray(parsed.files) || typeof parsed.facts !== 'object' || parsed.facts === null) {
    return { ok: false, reason: 'corrupt', detail: `基线版本或结构不符（期望 ${CAPTURE_SCHEMA}）` }
  }
  if (parsed.snapshotId !== snapshotId) {
    return { ok: false, reason: 'corrupt', detail: `文件 ${snapshotId} 内记录的快照是 ${String(parsed.snapshotId)}` }
  }
  if (parsed.workspaceId !== workspaceId) {
    return { ok: false, reason: 'other_workspace', detail: `基线属于 ${parsed.workspaceId}` }
  }
  if (fileSetDigestOf(parsed.files) !== parsed.fileSetDigest) {
    return { ok: false, reason: 'corrupt', detail: '文件清单与摘要不一致' }
  }
  if (!completeBaseline(parsed)) return { ok: false, reason: 'corrupt', detail: '基线没有完整的读取、解析与遍历证据' }
  const age = now - Date.parse(parsed.createdAt)
  if (!Number.isFinite(age) || age > ttlMs()) {
    return { ok: false, reason: 'expired', detail: `基线已超过 ${Math.round(ttlMs() / 3600000)} 小时有效期` }
  }
  return { ok: true, baseline: parsed, path: file }
}

function completeBaseline(baseline: CaptureBaseline): boolean {
  return baseline.schema === CAPTURE_SCHEMA && baseline.strength === 'content-bound'
    && baseline.truncated === false && baseline.partialFiles === 0
    && baseline.parseErrors === 0 && baseline.walkErrors === 0
    && Number.isSafeInteger(baseline.scanned) && baseline.scanned >= 0
    && baseline.files.length === baseline.scanned
    && new Set(baseline.files.map(file => file.path)).size === baseline.scanned
    && baseline.files.every(file => Object.hasOwn(baseline.facts, file.path))
}

/** Digest over the sorted file list. Recomputable from the record alone, so a
 *  hand-edited manifest is detectable without touching the workspace. */
export function fileSetDigestOf(files: readonly CapturedFile[]): string {
  const keys = files.map(file => `${file.path}\0${file.rawHash}\0${file.bytes}`).sort()
  return createHash('sha256').update(keys.join('\0')).digest('hex')
}

/** The recorded identity for one path, or null when the capture did not cover it. */
export function capturedFile(baseline: CaptureBaseline, relative: string): CapturedFile | null {
  return baseline.files.find(file => file.path === relative) ?? null
}

/** Files whose recorded hash differs from the current bytes on disk.
 *
 *  This is the check that keeps a baseline from certifying content it never saw:
 *  a rename, an edit or a delete shows up as a mismatch, and the caller must
 *  treat the baseline as before-evidence only.
 */
export function driftedFiles(workspaceId: string, baseline: CaptureBaseline): Array<{ path: string; recorded: string; current: string | null }> {
  const drifted: Array<{ path: string; recorded: string; current: string | null }> = []
  for (const file of baseline.files) {
    const absolute = path.resolve(workspaceId, ...file.path.split('/'))
    let current: string | null = null
    try {
      current = createHash('sha256').update(readFileSync(absolute)).digest('hex')
    } catch {
      current = null
    }
    if (current !== file.rawHash) drifted.push({ path: file.path, recorded: file.rawHash, current })
  }
  return drifted
}
