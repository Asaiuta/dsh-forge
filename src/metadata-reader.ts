/** Bounded, identity-checked reads of workspace metadata files; contents feed a cache signature. */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { canonicalTarget, readBoundedFile, within } from './fs-paths.ts'
import type { TraceDiagnostic } from './trace-evidence.ts'

const FILE_BYTES = 256 * 1024
const TOTAL_BYTES = 8 * 1024 * 1024
const FILE_COUNT = 2000

export interface MetadataReader {
  /** File text, or null after recording a metadata_read issue. */
  read: (file: string) => string | null
  issues: TraceDiagnostic[]
  /** Per-file content hashes plus the canonical root, for ProjectContext signatures. */
  signature: (extra: unknown) => string
}

export function metadataReader(root: string, label: string, signal?: AbortSignal): MetadataReader {
  const issues: TraceDiagnostic[] = [], stamps: unknown[] = []
  let canonicalRoot: string | null = null
  try { canonicalRoot = realpathSync(root) } catch { /* scanFacts reports inaccessible roots */ }
  let bytes = 0, count = 0
  const read = (file: string): string | null => {
    signal?.throwIfAborted()
    try {
      if (++count > FILE_COUNT || bytes >= TOTAL_BYTES) throw new Error(`超过 ${label} 工程元数据预算（2,000 个文件 / 8 MiB）。`)
      const target = canonicalTarget(path.resolve(root, file))
      if (!canonicalRoot || !within(canonicalRoot, target)) throw new Error('工程元数据路径超出扫描根或无法确认身份。')
      const data = readBoundedFile(target, Math.min(FILE_BYTES, TOTAL_BYTES - bytes))
      bytes += data.length
      stamps.push([file, createHash('sha256').update(data).digest('hex')])
      return data.toString('utf8').replace(/^\uFEFF/, '')
    } catch (cause) {
      stamps.push([file, 'failed'])
      issues.push({ path: file, reason: 'metadata_read', message: cause instanceof Error ? cause.message : String(cause) })
      return null
    }
  }
  return { read, issues, signature: extra => JSON.stringify([canonicalRoot, stamps, extra]) }
}

/** Minimal TOML-table navigation helpers shared by metadata loaders. */
export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
export const at = (value: unknown, ...keys: string[]): unknown => {
  let current = value
  for (const key of keys) current = record(current)?.[key]
  return current
}
export const strings = (value: unknown): string[] | null =>
  typeof value === 'string' ? [value] : Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null
export const tomlError = (cause: unknown): string => cause instanceof Error ? cause.message.split('\n')[0].slice(0, 240) : '无效 TOML。'
