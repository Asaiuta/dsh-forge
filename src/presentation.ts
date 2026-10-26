/** Freeze UI payload during execution; replay projection performs no filesystem I/O. */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readLedgerTail, storeFor } from './ledger.ts'
import { snapshot } from './history.ts'
import { workdirOf, type ForgeExec } from './core.ts'
import type { ForgeFileSystem, ForgeFsEvents } from './execution.ts'

export interface ForgePresentation { diffs: Array<{ path: string; oldText: string | null; newText: string }>; batch: number; omitted: number }
function decode(bytes: Buffer | null): string | null {
  if (bytes === null) return null
  if (bytes.includes(0)) throw new Error('binary diff')
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}
export async function freezePresentation(name: string, args: Record<string, unknown>, value: Record<string, unknown>, exec: ForgeExec,
  provider?: ForgeFileSystem, events: ForgeFsEvents = {}): Promise<ForgePresentation | undefined> {
  if (!['ffedit', 'ffrollback', 'ff_file'].includes(name)) return
  const id = Number(value.newBatch ?? value.batch)
  if (!Number.isSafeInteger(id) || id < 1) return
  let root = workdirOf(exec)
  // Resolve may consume the ticket; the tool sets the actual ledger coordinate.
  if (typeof value.workspace === 'string') root = value.workspace
  const store = storeFor(root)
  const batch = readLedgerTail(store, Number.MAX_SAFE_INTEGER).find(batch => batch.id === id)
  if (!batch) return
  const result: ForgePresentation = { diffs: [], batch: id, omitted: 0 }
  let remaining = 256 * 1024
  for (const node of batch.nodes) {
    const absolute = path.resolve(store.root, node.file)
    const before = snapshot(store, node.before), after = snapshot(store, node.after)
    try {
      const size = (before?.length ?? 0) + (after?.length ?? 0)
      if (size > remaining) throw new Error('presentation byte cap')
      const oldText = decode(before), newText = decode(after) ?? ''
      result.diffs.push({ path: absolute, oldText, newText }); remaining -= size
    } catch { result.omitted++ }
    // Report only the bytes actually committed and still present at observation.
    try {
      if (!provider?.stat || !events.emit) continue
      const target = await provider.resolve(absolute, { cwd: root, signal: exec.signal })
      const state = await provider.stat(target, exec.signal)
      if (after === null && state === undefined) events.emit('fs/observed', target, { kind: 'absent' }, exec)
      else if (state && after && createHash('sha256').update(readFileSync(absolute)).digest('hex') === node.after) {
        events.emit('fs/observed', target, { kind: 'present', version: state.version }, exec)
      }
    } catch { /* presentation/observation cannot erase an already committed result */ }
  }
  return result
}
