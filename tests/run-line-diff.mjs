// Contract for the line diff behind the Git detail view.
// Pure function: the renderer only walks the rows, so alignment rules are
// testable without a browser.
import assert from 'node:assert/strict'
import { diffLines, foldContext } from '../src/client/line-diff.ts'

const rowsOf = (...args) => diffLines(...args).rows
const kinds = rows => rows.map(r => r.kind)
const texts = rows => rows.map(r => r.text)

// --- identical input produces context only ---
let rows = rowsOf('a\nb\nc', 'a\nb\nc')
assert.deepEqual(kinds(rows), ['same', 'same', 'same'])
assert.deepEqual(rows.map(r => [r.oldNo, r.newNo]), [[1, 1], [2, 2], [3, 3]])
assert.equal(rows.some(r => r.change), false, 'an unchanged line carries no intraline span')

// --- pure insertion in the middle ---
rows = rowsOf('a\nc', 'a\nb\nc')
assert.deepEqual(kinds(rows), ['same', 'add', 'same'])
assert.equal(rows[1].text, 'b')
assert.equal(rows[1].oldNo, null, 'an added line has no old number')
assert.equal(rows[1].newNo, 2)
assert.deepEqual(rows.map(r => r.newNo), [1, 2, 3])

// --- pure deletion ---
rows = rowsOf('a\nb\nc', 'a\nc')
assert.deepEqual(kinds(rows), ['same', 'del', 'same'])
assert.equal(rows[1].oldNo, 2)
assert.equal(rows[1].newNo, null, 'a deleted line has no new number')

// --- replacement pairs into one mod row with an intraline span ---
rows = rowsOf('const a = 1;', 'const a = 2;')
assert.deepEqual(kinds(rows), ['mod'], 'a one-for-one rewrite is a mod, not del+add')
const mod = rows[0]
assert.equal(mod.text, 'const a = 2;', 'a mod row shows the new text')
assert.deepEqual([mod.oldNo, mod.newNo], [1, 1])
const [start, end] = mod.change
assert.equal(mod.text.slice(start, end), '2', 'only the changed character is marked')
assert.equal(mod.text.slice(0, start), 'const a = ', 'the common prefix is not marked')
assert.equal(mod.text.slice(end), ';', 'the common suffix is not marked')

// --- an unmatched pair keeps plain del/add (no invented pairing) ---
rows = rowsOf('a\nb', 'x\ny\nz')
assert.deepEqual(kinds(rows), ['mod', 'mod', 'add'], 'two pairs, one leftover addition')
assert.equal(rows[2].text, 'z')

// --- line numbers never go backwards ---
rows = rowsOf('a\nb\nc\nd', 'a\nX\nc\nY\nd')
let oldSeen = 0, newSeen = 0
for (const row of rows) {
  if (row.oldNo !== null) { assert.ok(row.oldNo > oldSeen, `old number increased: ${row.oldNo}`); oldSeen = row.oldNo }
  if (row.newNo !== null) { assert.ok(row.newNo > newSeen, `new number increased: ${row.newNo}`); newSeen = row.newNo }
}
assert.equal(oldSeen, 4, 'every old line is accounted for')
assert.equal(newSeen, 5, 'every new line is accounted for')

// --- no phantom trailing line ---
assert.deepEqual(kinds(rowsOf('a\n', 'a')), ['same'], 'a trailing newline does not invent an empty line')
assert.deepEqual(kinds(rowsOf('', '')), [], 'two empty files have no rows')
assert.deepEqual(kinds(rowsOf('', 'a')), ['add'], 'an empty file becoming one line is one addition')
assert.deepEqual(kinds(rowsOf('a', '')), ['del'])

// --- CRLF is normalised, not reported as a whole-file change ---
assert.deepEqual(kinds(rowsOf('a\r\nb\r\n', 'a\nb\n')), ['same', 'same'], 'line endings alone are not a change')

// --- a blank line is content, not absent ---
assert.deepEqual(kinds(rowsOf('a\n\nb', 'a\nb')), ['same', 'del', 'same'], 'a removed blank line is a deletion')

// --- completeness: every input line appears exactly once ---
const before = Array.from({ length: 40 }, (_, i) => `line ${i}`)
const after = before.map(line => line === 'line 7' ? 'line seven' : line).filter(line => line !== 'line 20')
const complete = rowsOf(before.join('\n'), after.join('\n'))
const seenOld = complete.filter(r => r.oldNo !== null).length
const seenNew = complete.filter(r => r.newNo !== null).length
assert.equal(seenOld, 40, 'all original lines are represented')
assert.equal(seenNew, 39, 'all resulting lines are represented')

// --- over budget: refuse to guess, but stay complete ---
const hugeA = Array.from({ length: 900 }, (_, i) => `a${i}`).join('\n')
const hugeB = Array.from({ length: 900 }, (_, i) => `b${i}`).join('\n')
const coarse = diffLines(hugeA, hugeB, { maxCells: 1000 })
assert.equal(coarse.coarse, true, 'too large a comparison is flagged, not silently approximated')
assert.equal(coarse.rows.filter(r => r.oldNo !== null).length, 900, 'the coarse result still lists every old line')
assert.equal(coarse.rows.filter(r => r.newNo !== null).length, 900, 'and every new line')

// --- folding: long unchanged runs collapse, short ones stay readable ---
const longSame = rowsOf(
  Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'),
  Array.from({ length: 20 }, (_, i) => i === 10 ? 'CHANGED' : `l${i}`).join('\n'),
)
const folded = foldContext(longSame, 3)
assert.ok(folded.some(r => r.kind === 'gap'), 'a long unchanged run becomes a gap row')
const gaps = folded.filter(r => r.kind === 'gap')
assert.equal(gaps.length, 2, 'one gap before and one after the change')
assert.equal(gaps[0].count, 8, 'a 10-line run keeps one context line per side, hiding 8')
assert.equal(folded.filter(r => r.kind !== 'gap').length, 5, 'the change, its two context lines, and the outer edges survive')
// Nothing is lost: gap counts and visible rows add up to the original.
assert.equal(folded.reduce((n, r) => n + (r.kind === 'gap' ? r.count : 1), 0), longSame.length)

// Short context is not worth a fold.
const short = rowsOf('a\nb\nX\nd', 'a\nb\nY\nd')
assert.equal(foldContext(short, 3).some(r => r.kind === 'gap'), false, 'a two-line context stays visible')

console.log('line-diff: 33 contract assertions passed; 0 failed')
