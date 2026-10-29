/**
 * Trace snapshots: which graph answered, under which configuration, and can it
 * still be trusted for the question being asked?
 *
 * The bug this exists to make impossible: "the last graph I built for this
 * directory" standing in for "the graph for this configuration". Two
 * declarations files, two compile_commands.json values, or two project sets are
 * two different graphs, and a snapshot ID must never resolve to the wrong one —
 * nor silently fall back to a fresh scan when the requested one is gone.
 *
 * Three separate facts, deliberately not merged (M0.4):
 *
 *   configKey    — what was asked for: root, declaration/compilation input and
 *                  its content digest, project context signatures, extractor
 *                  version. Stable across processes.
 *   snapshotId   — which assembly answered, unguessable, unique per build.
 *                  Resolves to exactly one stored graph or to nothing.
 *   strength     — how much of the workspace the identity covers. Everything
 *                  built by M0's stat cache is `observed`: the file set and the
 *                  resolution probes were checked, individual file contents
 *                  were not rehashed as part of the identity. Content binding
 *                  arrives with M1.1's capture path.
 *
 * Old cached graphs stay usable as *before* evidence (a post-edit audit wants
 * the graph as it was); they are not current truth. Callers that need "is this
 * still current" must ask {@link TraceSnapshots.describe} and compare.
 *
 * @module dsh-forge/trace-snapshot
 */

import { createHash, randomBytes } from 'node:crypto'

/** Bumped whenever the extraction schema changes meaning (not on refactors). */
export const TRACE_SNAPSHOT_SCHEMA = 'trace-snapshot/2'

/** Fixed slot order, so a context that disappears cannot be mistaken for one
 *  that never existed. */
export type ContextSlot = 'compilation' | 'project' | 'python' | 'rust' | 'go'
const SLOTS: readonly ContextSlot[] = ['compilation', 'project', 'python', 'rust', 'go']

export interface TraceConfigIdentity {
  /** Canonical workspace root (absolute, symlinks resolved by the caller). */
  root: string
  /** Resolved declarations path as the caller named it, or null. */
  declarations: string | null
  /** Content digest of that file, or null. A renamed-but-identical file is a
   *  different config; an edited file in place is a different config too. */
  declarationsDigest: string | null
  compileCommands: string | null
  compileCommandsDigest: string | null
  /** `slot:signature` for each present project context, in fixed slot order. */
  contexts: string[]
  extractor: string
}

export interface ConfigIdentityInput {
  root: string
  declarations?: string | null
  declarationsDigest?: string | null
  compileCommands?: string | null
  compileCommandsDigest?: string | null
  contexts?: Partial<Record<ContextSlot, string | undefined>>
}

/** Build the identity. Absent inputs have one fixed representation (`null`), so
 *  "not configured" never looks like "configured but empty". */
export function configIdentity(input: ConfigIdentityInput): TraceConfigIdentity {
  const contexts: string[] = []
  for (const slot of SLOTS) {
    const signature = input.contexts?.[slot]
    if (signature !== undefined && signature !== '') contexts.push(`${slot}:${signature}`)
  }
  return {
    root: input.root,
    declarations: input.declarations ?? null,
    declarationsDigest: input.declarations ? input.declarationsDigest ?? null : null,
    compileCommands: input.compileCommands ?? null,
    compileCommandsDigest: input.compileCommands ? input.compileCommandsDigest ?? null : null,
    contexts,
    extractor: TRACE_SNAPSHOT_SCHEMA,
  }
}

/** Stable, process-independent key for an identity. */
export function configKeyOf(identity: TraceConfigIdentity): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** How firmly the snapshot's identity is tied to file *contents*. */
export type SnapshotStrength = 'observed' | 'content-bound'

export interface TraceSnapshotMeta {
  /** Unguessable, stable for this assembly only. */
  snapshotId: string
  /** Canonical workspace root — a snapshot never crosses workspaces. */
  workspaceId: string
  configKey: string
  config: TraceConfigIdentity
  strength: SnapshotStrength
  /** `wasm` or the native sidecar, plus its version when it reports one. */
  provider: 'wasm' | 'native'
  providerVersion: string
  createdAt: string
  /** Files the graph knows about, at build time. */
  files: number
  /** Digest over the sorted file list — a cheap way to notice the set moved. */
  fileSetDigest: string
  /** Resolution probes re-checked on a warm hit. */
  probes: number
  scanned: number
  truncated: boolean
}

export type SnapshotLookup<T> =
  | { status: 'ok'; meta: TraceSnapshotMeta; payload: T }
  | { status: 'snapshot_unavailable'; reason: string }

interface StoredEntry<T> { meta: TraceSnapshotMeta; payload: T }

export interface SnapshotStoreOptions {
  /** Stored snapshots per workspace. Older ones are evicted, never merged. */
  perWorkspace?: number
  /** Total stored snapshots across workspaces. */
  total?: number
  provider?: 'wasm' | 'native'
  providerVersion?: string
}

/**
 * The snapshot registry. Process-local on purpose: a snapshot ID that outlives
 * the process would promise evidence whose bytes are gone. Persisting
 * snapshots is M1.1's job, with its own lifecycle and privacy rules.
 */
export class TraceSnapshots<T = unknown> {
  private readonly entries = new Map<string, StoredEntry<T>>()
  private readonly perWorkspace: number
  private readonly total: number
  private readonly provider: 'wasm' | 'native'
  private readonly providerVersion: string

  constructor(options: SnapshotStoreOptions = {}) {
    this.perWorkspace = options.perWorkspace ?? 4
    this.total = options.total ?? 16
    this.provider = options.provider ?? 'wasm'
    this.providerVersion = options.providerVersion ?? 'unversioned'
  }

  /** Register one assembly. The ID is unguessable and never reused. */
  register(input: {
    config: TraceConfigIdentity
    configKey: string
    payload: T
    files: Iterable<string>
    probes: number
    scanned: number
    truncated: boolean
    strength?: SnapshotStrength
    provider?: 'wasm' | 'native'
    providerVersion?: string
  }): TraceSnapshotMeta {
    return this.put(this.announce(input), input.payload)
  }

  /**
   * Build the metadata for an assembly whose payload is not finished yet.
   *
   * The assembly object itself holds this metadata (a caller must be able to
   * quote the ID that identifies the answer it is reading), so the ID has to
   * exist before the object does. `announce` therefore stores nothing: an
   * announced-but-uncommitted snapshot must never resolve.
   */
  announce(input: {
    config: TraceConfigIdentity
    configKey: string
    files: Iterable<string>
    probes: number
    scanned: number
    truncated: boolean
    strength?: SnapshotStrength
    provider?: 'wasm' | 'native'
    providerVersion?: string
  }): TraceSnapshotMeta {
    const files = [...input.files].sort()
    return {
      snapshotId: randomBytes(12).toString('hex'),
      workspaceId: input.config.root,
      configKey: input.configKey,
      config: input.config,
      strength: input.strength ?? 'observed',
      provider: input.provider ?? this.provider,
      providerVersion: input.providerVersion ?? this.providerVersion,
      createdAt: new Date().toISOString(),
      files: files.length,
      fileSetDigest: createHash('sha256').update(files.join('\0')).digest('hex'),
      probes: input.probes,
      scanned: input.scanned,
      truncated: input.truncated,
    }
  }

  /** Store an announced snapshot's payload. */
  put(meta: TraceSnapshotMeta, payload: T): TraceSnapshotMeta {
    this.entries.set(meta.snapshotId, { meta, payload })
    this.evict(meta.workspaceId)
    return meta
  }

  /**
   * Keep an already-built snapshot addressable under its original ID.
   *
   * A warm graph hit has no new assembly, but its ID must remain resolvable for
   * the caller that is about to quote it — or the answer would cite a token the
   * registry no longer knows. Re-registering preserves the identity (same ID,
   * same config) and only renews the retention slot.
   */
  restore(meta: TraceSnapshotMeta, payload: T): TraceSnapshotMeta {
    this.entries.delete(meta.snapshotId)
    this.entries.set(meta.snapshotId, { meta, payload })
    this.evict(meta.workspaceId)
    return meta
  }

  /**
   * Look one snapshot up by ID inside one workspace.
   *
   * A miss is `snapshot_unavailable` — never "use whatever else is cached for
   * this root". Falling back is how a stale token starts certifying content it
   * never saw.
   */
  get(snapshotId: string, workspaceId: string): SnapshotLookup<T> {
    const entry = this.entries.get(snapshotId)
    if (!entry) return { status: 'snapshot_unavailable', reason: `snapshot ${snapshotId} is not stored (evicted, other process, or never built)` }
    if (entry.meta.workspaceId !== workspaceId) {
      return { status: 'snapshot_unavailable', reason: `snapshot ${snapshotId} belongs to another workspace` }
    }
    return { status: 'ok', meta: entry.meta, payload: entry.payload }
  }

  /** Every snapshot for one workspace/config, newest last. Used by tests and
   *  diagnostics; queries must still address a snapshot by ID. */
  list(workspaceId: string, configKey?: string): TraceSnapshotMeta[] {
    return [...this.entries.values()]
      .filter(entry => entry.meta.workspaceId === workspaceId && (configKey === undefined || entry.meta.configKey === configKey))
      .sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt))
      .map(entry => entry.meta)
  }

  /** The newest snapshot for a config, for warm-hit reuse. Returns the payload
   *  only to callers that will revalidate its probes themselves. */
  newest(workspaceId: string, configKey: string): SnapshotLookup<T> {
    const matches = this.list(workspaceId, configKey)
    const newest = matches[matches.length - 1]
    if (!newest) return { status: 'snapshot_unavailable', reason: 'no snapshot stored for this configuration' }
    return this.get(newest.snapshotId, workspaceId)
  }

  /** Whether a stored snapshot's file set still matches what is on disk now.
   *  Cheap and partial: it proves the set changed, never that contents did. */
  fileSetMatches(meta: TraceSnapshotMeta, files: Iterable<string>): boolean {
    const sorted = [...files].sort()
    return sorted.length === meta.files
      && createHash('sha256').update(sorted.join('\0')).digest('hex') === meta.fileSetDigest
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  private evict(workspaceId: string): void {
    const forWorkspace = [...this.entries.values()].filter(entry => entry.meta.workspaceId === workspaceId)
    while (forWorkspace.length > this.perWorkspace) {
      const oldest = forWorkspace.shift()!
      this.entries.delete(oldest.meta.snapshotId)
    }
    while (this.entries.size > this.total) {
      const oldest = [...this.entries.values()].sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt))[0]
      this.entries.delete(oldest.meta.snapshotId)
    }
  }
}
