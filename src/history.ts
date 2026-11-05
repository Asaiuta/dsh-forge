/** Stable batch/node addressing, byte-verified snapshot diff and bounded content search. */
import { getBlob, readLedgerTail, type LedgerBatch, type LedgerNode, type StorePaths } from './ledger.ts'
import { lineOperations } from './line-ops.ts'
import { jsonBytes, OUTPUT_CONTENT_BYTES } from './output-budget.ts'

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
export interface SnapshotPatch { header: string; hunks: string[]; binary: boolean; coarse: boolean }
/** Keep raw LF-terminated lines, including CR and BOM, so a complete patch preserves bytes. */
function rawLines(value: string): string[] { return value.match(/[^\n]*\n|[^\n]+$/g) ?? [] }
export function snapshotPatch(before: Buffer | null, after: Buffer | null, file: string): SnapshotPatch {
  const a = utf8(before), b = utf8(after)
  const label = (side: string, exists: boolean) => !exists ? '/dev/null' : /[\s"\\]/.test(file) ? JSON.stringify(`${side}/${file}`) : `${side}/${file}`
  let header = `--- ${label('a', before !== null)}\n+++ ${label('b', after !== null)}\n`
  if (a === null || b === null) return { header: '', hunks: [`Binary bytes changed: ${before?.length ?? 0} -> ${after?.length ?? 0}\n`], binary: true, coarse: false }
  // An empty file has no lines to put in a hunk; Git's file metadata expresses
  // its creation/deletion without inventing a newline or losing file identity.
  if (a === '' && b === '' && (before === null) !== (after === null)) {
    header = `diff --git ${label('a', true)} ${label('b', true)}\n${before === null ? 'new file mode' : 'deleted file mode'} 100644\n`
  }
  const left = rawLines(a), right = rawLines(b), { ops, coarse } = lineOperations(left, right)
  const ranges: Array<{ start: number; end: number }> = []
  for (let i = 0; i < ops.length;) {
    if (ops[i].op === 'same') { i++; continue }
    const start = Math.max(0, i - 3)
    while (i < ops.length && ops[i].op !== 'same') i++
    const end = Math.min(ops.length, i + 3), last = ranges.at(-1)
    if (last && start <= last.end) last.end = end
    else ranges.push({ start, end })
  }
  const positions = [{ old: 0, next: 0 }]
  for (const op of ops) { const p = positions.at(-1)!; positions.push({ old: p.old + Number(op.op !== 'add'), next: p.next + Number(op.op !== 'del') }) }
  const hunks = ranges.map(({ start, end }) => {
    const from = positions[start], to = positions[end], oldCount = to.old - from.old, newCount = to.next - from.next
    let text = `@@ -${from.old + Number(oldCount > 0)},${oldCount} +${from.next + Number(newCount > 0)},${newCount} @@\n`
    for (const op of ops.slice(start, end)) {
      const line = op.op === 'add' ? right[op.b] : left[op.a]
      text += (op.op === 'same' ? ' ' : op.op === 'del' ? '-' : '+') + line
      if (!line.endsWith('\n')) text += '\n\\ No newline at end of file\n'
    }
    return text
  })
  return { header, hunks, binary: false, coarse }
}
export const DIFF_CONTENT_BYTES = OUTPUT_CONTENT_BYTES
export function oversizedHunk(hunk: string): boolean {
  return Buffer.byteLength(JSON.stringify(hunk)) > DIFF_CONTENT_BYTES - 1024 || hunk.split('\n').some(line => line.length > 2000)
}
/** HTTP preview: only whole hunks; tool callers use DiffOutput for continuation. */
export function snapshotDiff(before: Buffer | null, after: Buffer | null, file: string): { diff: string; binary: boolean; truncated: boolean; coarse: boolean } {
  const patch = snapshotPatch(before, after, file)
  let diff = patch.header, returned = 0
  for (const hunk of patch.hunks) {
    if (oversizedHunk(hunk) || jsonBytes(diff + hunk) > DIFF_CONTENT_BYTES) break
    diff += hunk; returned++
  }
  const truncated = returned !== patch.hunks.length
  if (truncated) diff += '[incomplete: use ff_history with this node and detail=patch for the complete patch]\n'
  return { diff, binary: patch.binary, truncated, coarse: patch.coarse }
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
