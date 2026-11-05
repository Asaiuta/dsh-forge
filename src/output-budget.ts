/** Runtime limits count serialized UTF-8 bytes, never estimated model tokens. */
export const OUTPUT_PAGE_BYTES = 12 * 1024
export const OUTPUT_CONTENT_BYTES = 8 * 1024
export const OUTPUT_ITEM_BYTES = 8 * 1024

export function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
export function boundedOutput<T>(value: T, recovery: string, maxBytes = OUTPUT_PAGE_BYTES): T {
 if (jsonBytes(value) > maxBytes) throw new Error(`output exceeds byte budget; ${recovery}`)
 return value
}
/** Whole rows only. An oversized identity must use a different read entry point. */
export function outputRows<T>(rows: readonly T[], offset: number, limit: number, recovery: (row: T) => string): T[] {
 const result: T[] = []
 let used = 2
 for (const row of rows.slice(offset, offset + limit)) {
  const size = jsonBytes(row)
  if (size > OUTPUT_ITEM_BYTES || used + size + (result.length ? 1 : 0) > OUTPUT_CONTENT_BYTES) {
   if (!result.length) throw new Error(recovery(row))
   break
  }
  result.push(row); used += size + (result.length > 1 ? 1 : 0)
 }
 return result
}
/** UTF-16 offsets; count JSON escaping and do not divide a surrogate pair. */
export function outputFragment(source: string, offset: number, maxBytes = OUTPUT_CONTENT_BYTES): { text: string; end: number } {
 let low = 0, high = Math.min(source.length - offset, maxBytes), length = 0
 while (low <= high) {
  const middle = Math.floor((low + high) / 2)
  if (jsonBytes(source.slice(offset, offset + middle)) <= maxBytes) { length = middle; low = middle + 1 }
  else high = middle - 1
 }
 let end = offset + length
 if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--
 if (end === offset && offset < source.length) throw new Error('output fragment budget cannot fit one code point')
 return { text: source.slice(offset, end), end }
}
/** Display fields only. Callers must name truncated fields and expose full records. */
export function outputPreview(source: string, chars = 240, maxBytes = 1600): string {
 let end = Math.min(source.length, chars)
 if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--
 const fragment = outputFragment(source.slice(0, end), 0, maxBytes - 3)
 return fragment.text + (fragment.end < source.length ? '…' : '')
}
