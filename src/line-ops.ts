/** Lossless line alignment shared by unified patches and the UI projection.
 * The caller chooses its line representation; operations retain indexes on both sides. */
/** One edit operation over the two line arrays. */
export type LineOp = { op: 'same'; a: number; b: number } | { op: 'del'; a: number } | { op: 'add'; b: number }

/**
 * Edit script for two line arrays via a full LCS table.
 *
 * Runs on the already-trimmed middle section, so the table only covers the part
 * that actually differs.
 */
function editScript(a: readonly string[], b: readonly string[]): LineOp[] {
  const n = a.length, m = b.length
  const table: Uint32Array[] = []
  for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1))
  for (let i = 1; i <= n; i += 1) {
    const row = table[i]!, prev = table[i - 1]!
    for (let j = 1; j <= m; j += 1) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!)
  }
  const ops: LineOp[] = []
  let i = n, j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { ops.push({ op: 'same', a: i - 1, b: j - 1 }); i -= 1; j -= 1 }
    else if (j > 0 && (i === 0 || table[i]![j - 1]! >= table[i - 1]![j]!)) { ops.push({ op: 'add', b: j - 1 }); j -= 1 }
    else { ops.push({ op: 'del', a: i - 1 }); i -= 1 }
  }
  return ops.reverse()
}


export function lineOperations(a: readonly string[], b: readonly string[], maxCells = 250_000): { ops: LineOp[]; coarse: boolean } {
 let head = 0, tail = 0
 while (head < a.length && head < b.length && a[head] === b[head]) head++
 while (tail < a.length - head && tail < b.length - head && a[a.length - tail - 1] === b[b.length - tail - 1]) tail++
 const left = a.slice(head, a.length - tail), right = b.slice(head, b.length - tail)
 const coarse = left.length > 0 && right.length > 0 && (left.length + 1) * (right.length + 1) > maxCells
 const ops: LineOp[] = Array.from({ length: head }, (_, i) => ({ op: 'same', a: i, b: i }))
 const middle: LineOp[] = coarse || !left.length || !right.length
  ? [...left.map((_, a): LineOp => ({ op: 'del', a })), ...right.map((_, b): LineOp => ({ op: 'add', b }))]
  : editScript(left, right)
 for (const op of middle) ops.push(op.op === 'same' ? { op: 'same', a: head + op.a, b: head + op.b }
  : op.op === 'del' ? { op: 'del', a: head + op.a } : { op: 'add', b: head + op.b })
 for (let i = 0; i < tail; i++) ops.push({ op: 'same', a: a.length - tail + i, b: b.length - tail + i })
 return { ops, coarse }
}
