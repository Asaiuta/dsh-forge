/** Strict UTF-8 string replacement: no whitespace, newline or BOM normalization. */
import type { AppliedEdit, FailedEdit } from './edit-engine.ts'

export interface LiteralEdit { find: string; replaceWith: string; replaceAll: boolean }

/** All selections address the original bytes; a failed/overlapping step aborts. */
export function applyLiteralEdits(raw: string, edits: readonly Pick<LiteralEdit, 'find' | 'replaceWith'>[]): AppliedEdit | FailedEdit {
  const fail = (reason: string): FailedEdit => ({ ok: false, reason, reports: [] })
  if (!edits.length || edits.length > 50) return fail('literal steps requires 1–50 find/replaceWith pairs')
  const plans: Array<{ index: number; start: number; end: number; text: string; newStart?: number; newEnd?: number }> = []
  let bytes = Buffer.byteLength(raw)
  for (const [index, edit] of edits.entries()) {
    if (typeof edit.find !== 'string' || !edit.find || typeof edit.replaceWith !== 'string') return fail(`step ${index}: literal step requires nonempty find and explicit replaceWith`)
    if (edit.find === edit.replaceWith) return fail(`step ${index}: literal find and replaceWith must differ`)
    const start = raw.indexOf(edit.find)
    if (start < 0) return fail(`step ${index}: literal text not found in original snapshot; whitespace and line endings must match exactly`)
    if (raw.indexOf(edit.find, start + edit.find.length) !== -1) return fail(`step ${index}: literal text occurs more than once; narrow find (replaceAll is a single-pattern operation)`)
    bytes += Buffer.byteLength(edit.replaceWith) - Buffer.byteLength(edit.find)
    plans.push({ index, start, end: start + edit.find.length, text: edit.replaceWith })
  }
  if (bytes > 8 * 1024 * 1024) return fail('literal replacement exceeds 8MB cap')
  plans.sort((a, b) => a.start - b.start)
  const parts: string[] = []
  let offset = 0, delta = 0
  for (const [i, plan] of plans.entries()) {
    if (plan.start < offset) return fail(`literal steps ${plans[i - 1].index} and ${plan.index} overlap in original snapshot; nothing written`)
    parts.push(raw.slice(offset, plan.start), plan.text)
    plan.newStart = plan.start + delta; plan.newEnd = plan.newStart + plan.text.length
    delta += plan.text.length - (plan.end - plan.start); offset = plan.end
  }
  parts.push(raw.slice(offset))
  const text = parts.join('')
  const lineAt = (value: string, offset: number) => value.slice(0, offset).replace(/\r\n?/g, '\n').split('\n').length
  return { ok: true, text, reports: plans.sort((a, b) => a.index - b.index).map(plan => ({
    index: plan.index, op: 'target', status: 'applied', reason: '1 literal occurrence replaced',
    originalRange: { start: lineAt(raw, plan.start), end: lineAt(raw, plan.end) },
    newRange: { start: lineAt(text, plan.newStart!), end: lineAt(text, plan.newEnd!) },
  })) }
}

export function applyLiteralEdit(raw: string, edit: LiteralEdit): AppliedEdit | FailedEdit {
  const fail = (reason: string): FailedEdit => ({ ok: false, reason, reports: [] })
  if (!edit.find) return fail('literal find must not be empty')
  if (edit.find === edit.replaceWith) return fail('literal find and replaceWith must differ')
  const first = raw.indexOf(edit.find)
  let count = 0
  for (let offset = first; offset !== -1; offset = raw.indexOf(edit.find, offset + edit.find.length)) count++
  if (!count) return fail('literal text not found; whitespace and line endings must match exactly')
  if (count > 1 && !edit.replaceAll) return fail(`literal text occurs ${count} times; narrow find or set replaceAll=true`)
  const bytes = Buffer.byteLength(raw) + count * (Buffer.byteLength(edit.replaceWith) - Buffer.byteLength(edit.find))
  if (bytes > 8 * 1024 * 1024) return fail('literal replacement exceeds 8MB cap')
  const text = raw.replaceAll(edit.find, () => edit.replaceWith)
  const line = (value: string) => value.replace(/\r\n?/g, '\n').split('\n').length
  const start = line(raw.slice(0, first))
  // A replace-all is one operation, with one bounded receipt. Its full evidence
  // is the snapshot diff; never imply that the enclosing span changed in full.
  return { ok: true, text, reports: [{ index: 0, op: 'target', status: 'applied', reason: `${count} literal occurrence(s) replaced`,
    ...(count === 1 ? { originalRange: { start, end: start + line(edit.find) - 1 }, newRange: { start, end: start + line(edit.replaceWith) - 1 } } : {}),
  }] }
}
