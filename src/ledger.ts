/**
 * dsh-forge construction ledger (stage 3): content-addressed snapshots and an
 * append-only batch ledger, stored centrally under
 * ~/.dsh/forge/snapshots/<workspace-key>/ (user decision: central store, zero
 * repository pollution, rollback never depends on git).
 *
 * Layout per workspace:
 *   workspace.json  — { root } for display and orphan pruning
 *   ledger.jsonl    — one line per batch: { t:'b', id, ts, kind, reason, actor,
 *                     nodes: [...] }; batches are the unit of rollback.
 *   blobs/<sha>.gz  — gzip(raw file bytes), addressed by sha256 of the bytes.
 *   state.json      — { files: { rel: { hash, blob, batch } } } — the plugin's
 *                     last-known disk hash per file, the external-modification
 *                     tripwire.
 *
 * External-modification discipline (forge principle): every write checks the
 * file's current hash against the ledger's last-known hash. On mismatch, the
 * CURRENT disk content is snapshotted as an `external` node BEFORE the edit,
 * so a rollback can never silently swallow changes made outside the plugin.
 * Rollback itself records a new batch — rolling back the last batch twice is
 * a redo.
 *
 * Honest limits (documented in README): the store is bound to this machine;
 * moving or renaming the workspace root starts a fresh store; locking is
 * in-process only (one desktop host process in practice).
 *
 * @module dsh-forge/ledger
 */

import { createHash, randomUUID, type Hash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  rmSync, readdirSync, statSync, renameSync, openSync, closeSync, fsyncSync, realpathSync, ftruncateSync, writeSync,
} from 'node:fs'
import path from 'node:path'
import { dataDir, withNativeWrite, type ForgeExec } from './core.ts'
import { markWritten } from './overlay.ts'
import { isSymbolicLink } from './fs-paths.ts'

/** Replace one file via a flushed sibling; the original survives failed writes. */
export function atomicWrite(file: string, bytes: Buffer | string): void {
  if (isSymbolicLink(file)) {
    throw new Error(`atomic replacement requires the real target path: ${file}`)
  }
  const temporary = `${file}.forge-${process.pid}-${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', existsSync(file) ? statSync(file).mode : 0o666)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    // Windows may briefly deny replacement while another handle is closing.
    // Retry only these transient codes, with a short bounded total delay.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, file); break }
      catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 3) throw cause
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1))
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Store locations
// ---------------------------------------------------------------------------

export function workspaceKey(root: string): string {
  return createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16)
}

export interface StorePaths {
  root: string
  dir: string
  ledgerFile: string
  stateFile: string
  blobsDir: string
}

export function storeFor(workspaceRoot: string): StorePaths {
  const requested = path.resolve(workspaceRoot)
  const root = existsSync(requested) ? realpathSync(requested) : requested
  let ledgerRoot = root
  const base = path.join(dataDir(), 'snapshots')
  let dir = path.join(base, workspaceKey(root))
  // Reuse historical alias/junction stores without moving or rewriting bytes.
  // Multiple stores for one canonical workspace need an explicit reconciliation.
  const matches: Array<{ dir: string; root: string }> = []
  if (existsSync(base)) {
    for (const entry of readdirSync(base)) {
      const candidate = path.join(base, entry)
      const meta = path.join(candidate, 'workspace.json')
      if (!existsSync(meta)) continue
      try {
        const saved = JSON.parse(readFileSync(meta, 'utf8')) as { root?: unknown }
        if (typeof saved.root === 'string' && existsSync(saved.root) && realpathSync(saved.root) === root) matches.push({ dir: candidate, root: saved.root })
      } catch { /* unrelated unreadable metadata */ }
    }
  }
  if (matches.length > 1) throw new Error(`multiple snapshot stores resolve to ${root}; reconcile histories before writing`)
  if (matches.length === 1) { dir = matches[0].dir; ledgerRoot = matches[0].root }
  return {
    // Existing node.file paths are relative to this persisted spelling.
    root: ledgerRoot,
    dir,
    ledgerFile: path.join(dir, 'ledger.jsonl'),
    stateFile: path.join(dir, 'state.json'),
    blobsDir: path.join(dir, 'blobs'),
  }
}

/** Session-owned history also covers explicitly addressed out-of-root files. */
export function workspaceForFile(file: string, workdir: string): string {
  // A session owns its ledger, including explicitly addressed outside files.
  return path.resolve(workdir)
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

export function putBlob(store: StorePaths, raw: Buffer): { id: string; bytes: number } {
  const id = createHash('sha256').update(raw).digest('hex')
  mkdirSync(store.blobsDir, { recursive: true })
  const target = path.join(store.blobsDir, `${id}.gz`)
  if (!existsSync(target) || getBlob(store, id) === null) {
    atomicWrite(target, gzipSync(raw, { level: 6 }))
  }
  return { id, bytes: raw.length }
}

export function getBlob(store: StorePaths, id: string): Buffer | null {
  const target = path.join(store.blobsDir, `${id}.gz`)
  if (!existsSync(target)) return null
  try {
    const bytes = gunzipSync(readFileSync(target))
    return createHash('sha256').update(bytes).digest('hex') === id ? bytes : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Ledger records
// ---------------------------------------------------------------------------

export type BatchKind = 'edit' | 'rollback' | 'external' | 'project'

export interface LedgerNode {
  /** Workspace-relative path (forward slashes). */
  file: string
  op: 'update' | 'create' | 'delete' | 'external'
  before: string | null
  after: string | null
  bytes: number
  eol: 'CRLF' | 'LF' | 'CR'
  bom: boolean
}

export interface LedgerBatch {
  t: 'b'
  id: number
  ts: number
  kind: BatchKind
  reason: string
  actor: string
  reverted?: number
  transaction?: string
  nodes: LedgerNode[]
}

export interface FileStateEntry {
  hash: string
  blob: string
  batch: number
}

interface StateFile {
  files: Record<string, FileStateEntry>
}

function readState(store: StorePaths): StateFile {
  // Reuse only a fully validated ledger whose filesystem identity is unchanged.
  if (existsSync(store.ledgerFile)) return ledgerView(store).state
  if (!existsSync(store.stateFile)) return { files: {} }
  try {
    const parsed = JSON.parse(readFileSync(store.stateFile, 'utf8')) as StateFile
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') return parsed
  } catch {
    // corrupted state → rebuild from scratch (ledger remains the truth)
  }
  return { files: {} }
}

function writeState(store: StorePaths, state: StateFile): void {
  mkdirSync(store.dir, { recursive: true })
  atomicWrite(store.stateFile, JSON.stringify(state))
}

export function readKnownState(store: StorePaths, relFile: string): FileStateEntry | null {
  const entry = readState(store).files[relFile]
  return entry ? { ...entry } : null
}

export function lastBatchId(store: StorePaths): number {
  return ledgerView(store).records.at(-1)?.id ?? 0
}

/** Flush one append; the WAL resolves process termination at either side of it. */
export function recordBatch(
  store: StorePaths,
  batch: Omit<LedgerBatch, 't' | 'id' | 'ts'>,
): LedgerBatch {
  mkdirSync(store.dir, { recursive: true })
  let view = ledgerView(store)
  if (view.tail !== 'clean') {
    let previous = readFileSync(store.ledgerFile, 'utf8')
    const boundary = previous.lastIndexOf('\n') + 1
    if (view.tail === 'unterminated') {
      previous += '\n'
    } else {
      // Preserve the damaged bytes, then append to the valid prefix only.
      atomicWrite(path.join(store.dir, `torn-ledger-${randomUUID()}.jsonl`), previous)
      previous = previous.slice(0, boundary)
    }
    atomicWrite(store.ledgerFile, previous)
    ledgerViews.delete(store.ledgerFile)
    view = ledgerView(store)
  }
  const line = JSON.stringify({ t: 'b', id: (view.records.at(-1)?.id ?? 0) + 1, ts: Date.now(), ...batch }) + '\n'
  const full = JSON.parse(line) as LedgerBatch
  validateRecord(full, view.records.at(-1)?.id ?? 0, view.records.length + 1)
  if (isSymbolicLink(store.ledgerFile)) throw new Error('ledger append refuses a symbolic link target')
  if (ledgerFingerprint(store) !== view.fingerprint) throw new Error('ledger changed before append; retry with stable history')
  const offset = existsSync(store.ledgerFile) ? statSync(store.ledgerFile).size : 0
  const intentFile = path.join(store.dir, 'ledger-append.json')
  // A flushed intent certifies both the exact historical prefix and proposed
  // bytes. Unlike the file transaction, it also covers project-only revisions.
  atomicWrite(intentFile, JSON.stringify({ version: 1, offset, prefixHash: view.digest.copy().digest('hex'), line }))
  // Windows append-only handles cannot truncate a failed partial write.
  // The workspace lock owns this explicit-offset append and prefix repair.
  const fd = openSync(store.ledgerFile, existsSync(store.ledgerFile) ? 'r+' : 'wx+')
  try {
    const bytes = Buffer.from(line)
    let written = 0
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written, offset + written)
      if (count === 0) throw new Error('ledger append wrote zero bytes')
      written += count
    }
    fsyncSync(fd)
  } catch (cause) {
    ledgerViews.delete(store.ledgerFile)
    // A failed append is uncommitted. Restore its exact valid prefix before
    // WAL recovery, including partial writes and a failed flush.
    try { ftruncateSync(fd, offset); fsyncSync(fd); rmSync(intentFile) }
    catch (repair) { throw new Error(`ledger append failed: ${String(cause)}; prefix repair failed: ${String(repair)}`) }
    throw cause
  } finally { closeSync(fd) }
  view.records.push(freezeRecord(full))
  applyState(view.state, full)
  view.digest.update(line)
  view.fingerprint = ledgerFingerprint(store)
  try { rmSync(intentFile) } catch { /* the next access verifies the committed append */ }
  // A checkpoint is disposable, never trusted instead of validating history.
  // Keep whole-state serialization off the per-batch hot path.
  if (full.id % 128 === 0) {
    try { writeState(store, view.state) } catch { /* ledger remains authoritative */ }
  }
  return full
}

/**
 * Snapshot the current disk content as an `external` batch — called when the
 * ledger's last-known hash for a file no longer matches disk.
 */
export function recordExternalState(
  store: StorePaths,
  relFile: string,
  raw: Buffer,
  eol: LedgerNode['eol'],
  bom: boolean,
): { batch: LedgerBatch; blobId: string } {
  const { id } = putBlob(store, raw)
  const batch = recordBatch(store, {
    kind: 'external',
    reason: 'external modification detected before edit (hash mismatch vs ledger)',
    actor: 'system:external',
    nodes: [{ file: relFile, op: 'external', before: null, after: id, bytes: raw.length, eol, bom }],
  })
  return { batch, blobId: id }
}

// ---------------------------------------------------------------------------
// History queries (ffhistory)
// ---------------------------------------------------------------------------

/** Read the last `max` batch lines (ledger has no content, lines stay small). */
export function readLedgerTail(store: StorePaths, max = 2000): LedgerBatch[] {
  return ledgerView(store).records.slice(-max)
}

interface LedgerView { fingerprint: string; records: LedgerBatch[]; state: StateFile; digest: Hash; tail: 'clean' | 'torn' | 'unterminated' }
const ledgerViews = new Map<string, LedgerView>()

function ledgerFingerprint(store: StorePaths): string {
  return [store.ledgerFile, path.join(store.dir, 'workspace.json')].map(file => {
    const stat = statSync(file, { bigint: true, throwIfNoEntry: false })
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'absent'
  }).join('|')
}
function applyState(state: StateFile, batch: LedgerBatch): void {
  for (const node of batch.nodes) {
    if (node.after !== null) state.files[node.file] = { hash: node.after, blob: node.after, batch: batch.id }
    else if (node.op === 'delete') delete state.files[node.file]
  }
}
function freezeRecord<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeRecord)
    Object.freeze(value)
  }
  return value
}
function validateRecord(rec: LedgerBatch, previousId: number, line: number): void {
  if (!rec || rec.t !== 'b' || !Number.isSafeInteger(rec.id) || rec.id !== previousId + 1
    || !Number.isFinite(rec.ts) || !['edit', 'rollback', 'external', 'project'].includes(rec.kind)
    || typeof rec.reason !== 'string' || typeof rec.actor !== 'string' || !Array.isArray(rec.nodes)
    || rec.nodes.some(node => !node || typeof node.file !== 'string' || !['update', 'create', 'delete', 'external'].includes(node.op)
      || ![node.before, node.after].every(hash => hash === null || typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      || !Number.isSafeInteger(node.bytes) || node.bytes < 0 || !['LF', 'CRLF', 'CR'].includes(node.eol) || typeof node.bom !== 'boolean')
    // 'project' is legacy: the feature is gone, but ledgers that still hold
    // project batches must keep replaying instead of failing validation.
    || rec.kind === 'project' && rec.nodes.length !== 0) {
    throw new Error(`invalid ledger record at line ${line}; history preserved, writing refused`)
  }
}
function decodeLedger(store: StorePaths, text: string): { records: LedgerBatch[]; tail: LedgerView['tail'] } {
  const lines = text.split('\n')
  const out: LedgerBatch[] = []
  const meta = path.join(store.dir, 'workspace.json')
  let strict = existsSync(meta) && JSON.parse(readFileSync(meta, 'utf8')).projectLedger === true
  let torn = false
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    let value: unknown
    try {
      value = JSON.parse(lines[i])
    } catch {
      // Only old file-only stores can recover an uncommitted partial tail.
      if (i !== lines.length - 1 || text.endsWith('\n')) throw new Error(`corrupt ledger line ${i + 1}; history preserved, writing refused`)
      torn = true
      continue
    }
    const rec = value as LedgerBatch
    validateRecord(rec, out.at(-1)?.id ?? 0, i + 1)
    strict ||= rec.kind === 'project'
    out.push(freezeRecord(rec))
  }
  if (strict && torn) throw new Error('corrupt project ledger tail; project state unavailable, writing refused')
  return { records: out, tail: torn ? 'torn' : text && !text.endsWith('\n') ? 'unterminated' : 'clean' }
}

/** Recover ONLY bytes certified by a durable append intent, never an unknown tail. */
function recoverAppend(store: StorePaths): void {
  const intentFile = path.join(store.dir, 'ledger-append.json')
  if (!existsSync(intentFile)) return
  if (isSymbolicLink(intentFile) || isSymbolicLink(store.ledgerFile)) throw new Error('ledger append recovery refuses symbolic links')
  const intent = JSON.parse(readFileSync(intentFile, 'utf8')) as { version: number; offset: number; prefixHash: string; line: string }
  if (!intent || intent.version !== 1 || !Number.isSafeInteger(intent.offset) || intent.offset < 0
    || typeof intent.prefixHash !== 'string' || !/^[a-f0-9]{64}$/.test(intent.prefixHash)
    || typeof intent.line !== 'string' || !intent.line.endsWith('\n') || intent.line.slice(0, -1).includes('\n')) {
    throw new Error('invalid ledger append intent; history preserved, writing refused')
  }
  const raw = existsSync(store.ledgerFile) ? readFileSync(store.ledgerFile) : Buffer.alloc(0)
  const prefix = raw.subarray(0, intent.offset)
  const suffix = raw.subarray(intent.offset)
  const proposed = Buffer.from(intent.line)
  if (raw.length < intent.offset || createHash('sha256').update(prefix).digest('hex') !== intent.prefixHash
    || suffix.length > proposed.length || !suffix.equals(proposed.subarray(0, suffix.length))) {
    throw new Error('ledger append recovery bytes do not match intent; history preserved, writing refused')
  }
  const previous = decodeLedger(store, prefix.toString('utf8'))
  if (previous.tail !== 'clean') throw new Error('ledger append recovery requires a complete valid prefix')
  validateRecord(JSON.parse(intent.line), previous.records.at(-1)?.id ?? 0, previous.records.length + 1)
  if (suffix.length < proposed.length && suffix.length > 0) {
    atomicWrite(path.join(store.dir, `torn-ledger-${randomUUID()}.jsonl`), raw)
    const fd = openSync(store.ledgerFile, 'r+')
    try { ftruncateSync(fd, intent.offset); fsyncSync(fd) } finally { closeSync(fd) }
  } else if (suffix.length === proposed.length) {
    // The old process may have exited after the last write but before flush.
    const fd = openSync(store.ledgerFile, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  // Complete bytes are committed; a strict prefix is uncommitted. File WAL
  // recovery uses the transaction id in the remaining validated ledger.
  rmSync(intentFile)
  ledgerViews.delete(store.ledgerFile)
}

function ledgerView(store: StorePaths): LedgerView {
  recoverAppend(store)
  const fingerprint = ledgerFingerprint(store)
  const cached = ledgerViews.get(store.ledgerFile)
  if (cached?.fingerprint === fingerprint) return cached
  // Read errors and complete corrupt lines are never an empty/older history.
  const raw = existsSync(store.ledgerFile) ? readFileSync(store.ledgerFile) : Buffer.alloc(0)
  const decoded = decodeLedger(store, raw.toString('utf8'))
  if (ledgerFingerprint(store) !== fingerprint) throw new Error('ledger changed while validating; retry with stable history')
  const view: LedgerView = { fingerprint, ...decoded, state: { files: Object.create(null) }, digest: createHash('sha256').update(raw) }
  decoded.records.forEach(batch => applyState(view.state, batch))
  ledgerViews.set(store.ledgerFile, view)
  if (ledgerViews.size > 4) ledgerViews.delete(ledgerViews.keys().next().value!)
  return view
}

export interface HistoryFilter {
  path?: string
  keyword?: string
  actor?: string
  kind?: BatchKind
  limit: number
}

/** Newest-first filtered history. Search covers paths + reasons only (blobs
 *  are gzip content-addressed; a content sweep would decompress every blob —
 *  documented v1 scope). */
export function searchHistory(store: StorePaths, filter: HistoryFilter): LedgerBatch[] {
  const batches = readLedgerTail(store, Number.MAX_SAFE_INTEGER).reverse()
  const out: LedgerBatch[] = []
  for (const batch of batches) {
    if (filter.kind && batch.kind !== filter.kind) continue
    if (filter.actor && batch.actor !== filter.actor) continue
    if (filter.path && !batch.nodes.some((n) => n.file.includes(filter.path!))) continue
    if (filter.keyword && !batch.reason.toLowerCase().includes(filter.keyword.toLowerCase())) continue
    out.push(batch)
    if (out.length >= filter.limit) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Stats + pruning (/forge-status)
// ---------------------------------------------------------------------------

export interface StoreStats {
  root: string
  dir: string
  batches: number
  blobs: number
  blobBytes: number
  files: number
  orphan: boolean
}

export function statsFor(store: StorePaths): StoreStats {
  const batches = readLedgerTail(store, 100_000).length
  let blobs = 0
  let blobBytes = 0
  if (existsSync(store.blobsDir)) {
    for (const entry of readdirSync(store.blobsDir)) {
      try {
        blobBytes += statSync(path.join(store.blobsDir, entry)).size
        blobs++
      } catch {
        // raced delete — ignore
      }
    }
  }
  const state = readState(store)
  let workspaceRoot = store.root
  let orphan = false
  try {
    const meta = JSON.parse(readFileSync(path.join(store.dir, 'workspace.json'), 'utf8')) as { root?: string }
    if (typeof meta.root === 'string') workspaceRoot = meta.root
  } catch {
    // no metadata — fall back to the resolved root
  }
  orphan = !existsSync(workspaceRoot)
  return { root: workspaceRoot, dir: store.dir, batches, blobs, blobBytes, files: Object.keys(state.files).length, orphan }
}

/** Ensure workspace.json exists (records the human-readable root path). */
export function ensureWorkspaceMeta(store: StorePaths, pendingRecovery = false): void {
  mkdirSync(store.dir, { recursive: true })
  const metaFile = path.join(store.dir, 'workspace.json')
  if (!existsSync(metaFile)) {
    atomicWrite(metaFile, JSON.stringify({ root: store.root }))
  }
  readLedgerTail(store, Number.MAX_SAFE_INTEGER)
  if (!pendingRecovery && existsSync(path.join(store.dir, 'transaction.json'))) throw new Error('transaction recovery pending; authorize recovery before continuing')
}

export interface FileChange { file: string; before: Buffer | null; after: Buffer | null }
interface Journal { transaction: string; nodes: Array<{ file: string; before: string | null; after: string | null }> }

type RecoveryGuard = Pick<ForgeExec, 'authorizeNativePaths' | 'prepareNativeWrite' | 'withNativeWrite' | 'signal'>
function readJournal(store: StorePaths): Journal {
  const value = JSON.parse(readFileSync(path.join(store.dir, 'transaction.json'), 'utf8')) as Journal
  if (!value || typeof value.transaction !== 'string' || !value.transaction || !Array.isArray(value.nodes)
    || value.nodes.some(node => !node || typeof node.file !== 'string' || !path.isAbsolute(node.file)
      || ![node.before, node.after].every(hash => hash === null || typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))) {
    throw new Error('invalid transaction recovery journal; writing refused')
  }
  return value
}
/** Call while holding the workspace lock. Authorize ALL recovery nodes before writes. */
export async function prepareWorkspace(store: StorePaths, guard?: RecoveryGuard): Promise<void> {
  ensureWorkspaceMeta(store, true)
  const journalFile = path.join(store.dir, 'transaction.json')
  if (!existsSync(journalFile)) return
  const journal = readJournal(store)
  const files = journal.nodes.map(node => node.file)
  await guard?.authorizeNativePaths?.(files)
  await withNativeWrite(guard, files, () => recoverStore(store))
}

/** True when the store carries a write-ahead journal awaiting recovery. */
export function hasPendingTransaction(store: StorePaths): boolean {
  return existsSync(path.join(store.dir, 'transaction.json'))
}

function diskHash(file: string): string | null {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
}

/** Recover an interrupted transaction. Unknown external bytes are never replaced. */
export function recoverStore(store: StorePaths): void {
  const journalFile = path.join(store.dir, 'transaction.json')
  if (!existsSync(journalFile)) return
  const journal = readJournal(store)
  const committed = readLedgerTail(store, Number.MAX_SAFE_INTEGER).some(b => b.transaction === journal.transaction)
  const plans: Array<{ file: string; expected: string | null; bytes: Buffer | null }> = []
  for (const node of journal.nodes) {
    if (isSymbolicLink(node.file)) throw new Error(`transaction recovery refuses symbolic link identity: ${node.file}`)
    const current = diskHash(node.file)
    const desired = committed ? node.after : node.before
    if (current === desired) continue
    if (current !== node.before && current !== node.after) {
      throw new Error(`transaction recovery blocked by external modification: ${node.file}; recovery journal retained`)
    }
    const bytes = desired === null ? null : getBlob(store, desired)
    if (desired !== null && !bytes) throw new Error(`transaction recovery snapshot missing: ${desired}`)
    plans.push({ file: node.file, expected: current, bytes })
  }
  for (const plan of plans) {
    if (diskHash(plan.file) !== plan.expected) throw new Error(`transaction recovery file changed: ${plan.file}; recovery journal retained`)
    if (plan.bytes === null) rmSync(plan.file, { force: true })
    else atomicWrite(plan.file, plan.bytes)
    // Recovery writes files the index has also not seen yet; same reason as
    // commitFiles. A rollback that leaves search answering from the pre-rollback
    // content is the exact failure this overlay exists to prevent.
    markWritten(plan.file, plan.bytes)
  }
  rmSync(journalFile)
}

/** Shared edit/rollback commit: snapshots + journal, files, then ledger. */
export function commitFiles(store: StorePaths, batch: Omit<LedgerBatch, 't' | 'id' | 'ts'>, changes: FileChange[]): LedgerBatch {
  // Defense in depth: every current caller runs prepareWorkspace (recovery)
  // before committing, but commitFiles must never clobber a pending journal —
  // the journal IS the record that files may be in a half-written state. Must
  // precede ensureWorkspaceMeta, which refuses while a journal is pending.
  recoverStore(store)
  ensureWorkspaceMeta(store)
  const journal: Journal = { transaction: randomUUID(), nodes: changes.map(change => ({
    file: change.file,
    before: change.before === null ? null : putBlob(store, change.before).id,
    after: change.after === null ? null : putBlob(store, change.after).id,
  })) }
  for (const node of journal.nodes) {
    if (isSymbolicLink(node.file)) throw new Error(`transaction refuses symbolic link identity: ${node.file}`)
    if (diskHash(node.file) !== node.before) throw new Error(`file changed while planning: ${node.file}; nothing written`)
  }
  const journalFile = path.join(store.dir, 'transaction.json')
  atomicWrite(journalFile, JSON.stringify(journal))
  try {
    for (const change of changes) {
      const expected = change.before === null ? null : createHash('sha256').update(change.before).digest('hex')
      if (diskHash(change.file) !== expected) throw new Error(`file changed at commit: ${change.file}`)
      if (change.after === null) rmSync(change.file, { force: true })
      else atomicWrite(change.file, change.after)
      // The index will not know about this write for 2.3-4.3 s (measured), so
      // record it here: search answers for this file come from these bytes until
      // the overlay expires. Marked after the write, so a failed write can never
      // shadow the file it did not change.
      markWritten(change.file, change.after)
    }
    const committed = recordBatch(store, { ...batch, transaction: journal.transaction })
    try { rmSync(journalFile) } catch { /* next access completes cleanup */ }
    return committed
  } catch (cause) {
    try { recoverStore(store) } catch (recovery) {
      throw new Error(`commit failed: ${String(cause)}; recovery pending: ${String(recovery)}`)
    }
    throw cause
  }
}

/** All snapshot stores known to this machine (for /forge-status). */
export function allStores(): StorePaths[] {
  const base = path.join(dataDir(), 'snapshots')
  if (!existsSync(base)) return []
  const out: StorePaths[] = []
  for (const entry of readdirSync(base)) {
    const dir = path.join(base, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    let root = dir
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, 'workspace.json'), 'utf8')) as { root?: string }
      if (typeof meta.root === 'string') root = meta.root
    } catch {
      // unnamed store — use dir as pseudo-root for display
    }
    out.push({ root, dir, ledgerFile: path.join(dir, 'ledger.jsonl'), stateFile: path.join(dir, 'state.json'), blobsDir: path.join(dir, 'blobs') })
  }
  return out
}

/** Remove snapshot stores whose workspace root no longer exists on disk. */
export function pruneOrphanedStores(): Array<{ root: string; dir: string; bytes: number }> {
  const removed: Array<{ root: string; dir: string; bytes: number }> = []
  for (const store of allStores()) {
    const stats = statsFor(store)
    if (!stats.orphan) continue
    try {
      rmSync(store.dir, { recursive: true, force: true })
      removed.push({ root: stats.root, dir: store.dir, bytes: stats.blobBytes })
    } catch {
      // best-effort
    }
  }
  return removed
}

/** Blob ids referenced by any ledger node (before/after hashes) — the GC reachability root set. */
export function referencedBlobIds(store: StorePaths): Set<string> {
  const refs = new Set<string>()
  for (const batch of readLedgerTail(store, Number.MAX_SAFE_INTEGER)) {
    for (const node of batch.nodes) {
      if (node.before) refs.add(node.before)
      if (node.after) refs.add(node.after)
    }
  }
  return refs
}

/** Reference-aware blob recycling inside one live store: delete only files
 *  no ledger node points at (torn-write leftovers), never reachable ones.
 *  Reports each freed blob with its compressed size on disk. */
export function gcStoreBlobs(store: StorePaths): Array<{ id: string; bytes: number }> {
  if (!existsSync(store.blobsDir)) return []
  const refs = referencedBlobIds(store)
  const freed: Array<{ id: string; bytes: number }> = []
  for (const entry of readdirSync(store.blobsDir)) {
    const id = entry.replace(/\.gz$/, '')
    if (refs.has(id)) continue
    const file = path.join(store.blobsDir, entry)
    try {
      if (!statSync(file).isFile()) continue
      const bytes = statSync(file).size
      rmSync(file)
      freed.push({ id, bytes })
    } catch {
      // raced delete — best-effort
    }
  }
  return freed
}

/** Permanently erase one workspace's construction history: ledger, state and
 *  blobs (the store directory itself). Refuses while a transaction recovery
 *  journal is pending — resolve or prune first. Disk files of the workspace
 *  are never touched (ProjectForge PurgeProjects semantics). */
export function purgeStore(store: StorePaths): { bytes: number; batches: number } {
  if (existsSync(path.join(store.dir, 'transaction.json'))) {
    throw new Error('transaction recovery journal pending; authorize recovery or prune the store before purge')
  }
  const stats = statsFor(store)
  rmSync(store.dir, { recursive: true, force: true })
  ledgerViews.delete(store.ledgerFile)
  return { bytes: stats.blobBytes, batches: stats.batches }
}

/** Delete a single file's ledger baseline (used when the file is removed by a
 *  rollback of its creating batch). */
export function clearFileState(store: StorePaths, relFile: string): void {
  const state = { files: { ...readState(store).files } }
  delete state.files[relFile]
  writeState(store, state)
}

// ---------------------------------------------------------------------------
// EOL / BOM preservation helpers (the write path)
// ---------------------------------------------------------------------------

export interface TextEncoding {
  eol: 'CRLF' | 'LF' | 'CR'
  bom: boolean
}

export function detectEncoding(raw: string): TextEncoding {
  const bom = raw.charCodeAt(0) === 0xfeff
  const body = bom ? raw.slice(1) : raw
  const crlf = (body.match(/\r\n/g) ?? []).length
  const lf = (body.match(/(?<!\r)\n/g) ?? []).length
  const cr = (body.match(/\r(?!\n)/g) ?? []).length
  let eol: TextEncoding['eol'] = 'LF'
  if (crlf > lf && crlf > cr) eol = 'CRLF'
  else if (cr > lf && cr > crlf) eol = 'CR'
  return { eol, bom }
}

export function encodeText(normalized: string, encoding: TextEncoding): string {
  const body = encoding.eol === 'CRLF' ? normalized.replace(/\n/g, '\r\n')
    : encoding.eol === 'CR' ? normalized.replace(/\n/g, '\r')
    : normalized
  return (encoding.bom ? '\uFEFF' : '') + body
}

/** Binary / UTF-16 content is refused for text editing (forge plan parity). */
export function looksBinary(raw: string): boolean {
  if (raw.startsWith('\uFFFE') || raw.charCodeAt(0) === 0xfffe) return true
  const probe = raw.slice(0, 8192)
  for (let i = 0; i < probe.length; i++) {
    if (probe.charCodeAt(i) === 0) return true
  }
  return false
}
