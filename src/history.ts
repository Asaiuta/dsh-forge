/** Stable batch/node addressing, byte-verified snapshot diff and bounded content search. */
import { getBlob, readLedgerTail, type LedgerBatch, type LedgerNode, type StorePaths } from './ledger.ts'

export function nodeId(batch: number, index: number): string { return `b${batch}:n${index}` }
export function readNode(store: StorePaths, address: string): { batch: LedgerBatch; node: LedgerNode; index: number } {
  const match = /^b([1-9][0-9]*):n([0-9]+)$/.exec(address)
  if (!match) throw new Error('node requires b<batch>:n<zero-based index> from ffhistory')
  const batch = readLedgerTail(store, Number.MAX_SAFE_INTEGER).find(batch => batch.id === Number(match[1]))
  const index = Number(match[2])
  if (!batch || !batch.nodes[index]) throw new Error(`node not found: ${address}`)
  return { batch, node: batch.nodes[index], index }
}
export function snapshot(store: StorePaths, hash: string | null): Buffer | null {
  if (hash === null) return null
  const bytes = getBlob(store, hash)
  if (!bytes) throw new Error(`snapshot missing or corrupt: ${hash}`)
  return bytes
}
function utf8(bytes: Buffer | null): string | null {
  if (bytes === null) return ''
  if (bytes.includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return null }
}
export function snapshotDiff(before: Buffer | null, after: Buffer | null, file: string): { diff: string; binary: boolean; truncated: boolean } {
  const a = utf8(before), b = utf8(after)
  if (a === null || b === null) return { diff: `Binary bytes changed: ${before?.length ?? 0} -> ${after?.length ?? 0}`, binary: true, truncated: false }
  // Render a bounded replacement hunk around the changed middle, preserving raw hashes separately.
  const left = a.replace(/\r\n?/g, '\n').split('\n'), right = b.replace(/\r\n?/g, '\n').split('\n')
  let prefix = 0, suffix = 0
  while (prefix < Math.min(left.length, right.length) && left[prefix] === right[prefix]) prefix++
  while (suffix < Math.min(left.length, right.length) - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++
  const removed = left.slice(prefix, left.length - suffix), added = right.slice(prefix, right.length - suffix)
  const limit = 500
  const lines = [`--- a/${file}`, `+++ b/${file}`, `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.slice(0, limit).map(line => `-${line}`), ...added.slice(0, limit).map(line => `+${line}`)]
  const truncated = removed.length > limit || added.length > limit || lines.join('\n').length > 64000
  return { diff: lines.join('\n').slice(0, 64000), binary: false, truncated }
}
export function historyContentMatches(store: StorePaths, batch: LedgerBatch, query: string, budget: { remaining: number; seen?: Set<string> }): boolean {
  for (const node of batch.nodes) {
    for (const hash of new Set([node.before, node.after])) {
      if (!hash) continue
      budget.seen ??= new Set()
      const bytes = snapshot(store, hash)!
      if (!budget.seen.has(hash)) { budget.remaining -= bytes.length; budget.seen.add(hash) }
      if (budget.remaining < 0) throw new Error('snapshot content search exceeded 32MB budget; narrow project/path filters')
      const text = utf8(bytes)
      if (text !== null && text.toLowerCase().includes(query.toLowerCase())) return true
    }
  }
  return false
}
