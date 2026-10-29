// ff_read streaming — the read path must produce text that is byte-identical to
// the buffered read it replaced, at every chunk boundary, and must refuse the
// same inputs with the same reasons.
//
// The risk this suite exists for: a streaming decoder has two pieces of state a
// chunk boundary can cut in half — an incomplete UTF-8 sequence and a lone `\r`
// that may be the first half of a `\r\n`. Getting either wrong does not throw;
// it shifts line numbers by one and the numbers still look plausible. So the
// assertion is not "a window came back" but "the window equals what the whole
// file in memory would have produced", for every split point.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CanonicalStream, canonicalize, rangeForSlice } from '../lib/source-evidence.js'
import { createReadTool } from '../lib/tools-read.js'

let passed = 0
const ok = (label) => { passed++; console.log(`ok ${passed} - ${label}`) }

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-read-stream-'))
const work = path.join(sandbox, 'work')
fs.mkdirSync(work, { recursive: true })
process.env.DSH_FORGE_DATA_DIR = path.join(sandbox, '.dsh', 'forge')
const exec = { agent: { session: { header: { cwd: work, id: 'read-stream' } } }, token: {} }

const put = (name, content) => {
  const abs = path.join(work, ...name.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}
const tool = createReadTool()
const run = async (args) => await tool.execute(args, exec)

const PER_FILE_LINE_CAP = 4000
const PER_FILE_BYTE_CAP = 256 * 1024
const TOTAL_BYTE_BUDGET = 40 * 1024

/**
 * The buffered read this change replaced, kept verbatim as the oracle.
 *
 * Nothing here is imported from `src/` except the two position helpers that the
 * streaming path deliberately does *not* use — `rangeForSlice` needs the whole
 * file, so comparing against it is an independent check of `rangeForWindow`.
 */
function buffered(canonical, range) {
  const lines = canonical.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const start = range === null ? 1 : Math.max(1, range.start)
  const end = range === null ? lines.length : Math.min(lines.length, range.end)
  if (range !== null && range.start > lines.length) return { pastEof: lines.length }
  const slice = lines.slice(start - 1, end)
  const capped = range === null && end - start + 1 > PER_FILE_LINE_CAP
  let text = capped ? slice.slice(0, PER_FILE_LINE_CAP).join('\n') : slice.join('\n')
  let truncated = capped
  if (text.length > PER_FILE_BYTE_CAP) {
    text = text.slice(0, PER_FILE_BYTE_CAP)
    truncated = true
  }
  const shownLines = text === '' ? 1 : text.split('\n').length
  const block = {
    lines: `L${start}-${start + shownLines - 1}`,
    text,
    totalLines: lines.length,
    displayRange: rangeForSlice(canonical, start, text.length),
    ...(truncated ? { truncated: true } : {}),
  }
  // Then the inline budget, which every returned block has to fit.
  if (block.text.length <= TOTAL_BYTE_BUDGET) return block
  const breakAt = block.text.lastIndexOf('\n', TOTAL_BYTE_BUDGET)
  const kept = breakAt > 0 ? block.text.slice(0, breakAt) : block.text.slice(0, TOTAL_BYTE_BUDGET)
  const first = Number(/^L(\d+)-\d+$/.exec(block.lines)[1])
  return {
    ...block,
    text: kept,
    lines: `L${first}-${first + kept.split('\n').length - 1}`,
    displayRange: rangeForSlice(canonical, block.displayRange.start.line + 1, kept.length),
    truncated: true,
  }
}

/** The block fields the read contract promises, in a comparable shape. */
const shape = (block) => ({
  lines: block.lines,
  text: block.text,
  totalLines: block.totalLines,
  displayRange: block.displayRange,
  ...(block.truncated ? { truncated: true } : {}),
})

// --- 1. the incremental decoder == the whole-buffer decoder ----------------
{
  const corpus = [
    '', '\n', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n\n\n', 'a\n\nb',
    'a\r\nb\r\n', 'a\rb\rc', 'a\r', '\r\n\r\n', '\uFEFF', '\uFEFFa\r\nb',
    'A😀B\n中文行\nlast', 'tab\there\r\n\r\nblank\r\n', 'ends with cr\r',
    'x'.repeat(41) + '\r\n' + 'y'.repeat(37),
  ]
  let cases = 0
  for (const text of corpus) {
    const raw = Buffer.from(text, 'utf8')
    const whole = canonicalize(raw)
    for (const size of [1, 2, 3, 5, 7, 16]) {
      const stream = new CanonicalStream()
      let out = ''
      for (let at = 0; at < raw.length; at += size) out += stream.push(raw.subarray(at, at + size))
      out += stream.end()
      assert.equal(out, whole.text, `chunk=${size} mangled ${JSON.stringify(text)}: ${JSON.stringify(out)} != ${JSON.stringify(whole.text)}`)
      assert.equal(stream.bom, whole.bom, `chunk=${size} misreported BOM for ${JSON.stringify(text)}`)
      cases++
    }
  }
  assert.equal(CanonicalStream.prototype.push.length >= 0, true)
  ok(`incremental decoding matches canonicalize for ${cases} (text × chunk size) combinations`)
}

// --- 2. invalid bytes are refused, not decoded lossily ---------------------
{
  const bad = Buffer.from('ok\ncaf\u00e9\n', 'latin1') // 0xE9 is not valid UTF-8
  const stream = new CanonicalStream()
  assert.throws(() => {
    for (let at = 0; at < bad.length; at += 4) stream.push(bad.subarray(at, at + 4))
  }, /not valid UTF-8/)
  // A file that ends *inside* a sequence must fail on the flush, not silently
  // decode to its valid prefix.
  const cut = new CanonicalStream()
  cut.push(Buffer.from('ok\n中', 'utf8').subarray(0, 5))
  assert.throws(() => cut.end(), /not valid UTF-8/)
  ok('invalid UTF-8 mid-file and a truncated sequence at EOF are both refused')
}

// --- 3. the read tool == the buffered oracle, for every window -------------
{
  const fixtures = {
    'lf.txt': 'a\nb\nc\n',
    'no-trailing.txt': 'a\nb\nc',
    'empty.txt': '',
    'one-line.txt': 'solo',
    'blank-lines.txt': 'a\n\n\nb\n\n',
    'crlf.txt': 'x\r\ny\r\nz\r\n',
    'cr.txt': 'x\ry\rz\r',
    'bom-crlf.txt': '\uFEFFfirst\r\nsecond\r\n',
    'cjk.txt': '中文\n😀 emoji\nafter\n',
    'exactly-4000.txt': Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    'over-4000.txt': Array.from({ length: 4001 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    'long-lines.txt': Array.from({ length: 12 }, (_, i) => `L${i + 1} ${'x'.repeat(40_000)}`).join('\n') + '\n',
  }
  const ranges = [
    null,
    { start: 1, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 3 },
    { start: 1, end: 5000 }, { start: 3999, end: 4001 }, { start: 4000, end: 4000 },
    { start: 2, end: 4000 }, { start: 12, end: 12 },
  ]
  let cases = 0
  for (const [name, body] of Object.entries(fixtures)) {
    const abs = put(name, body)
    const canonical = canonicalize(fs.readFileSync(abs)).text
    for (const range of ranges) {
      const label = `${name} ${range === null ? 'whole file' : `L${range.start}-${range.end}`}`
      const expected = buffered(canonical, range)
      const args = { path: name, ...(range === null ? {} : { lines: `L${range.start}-${range.end}` }) }
      const out = await run(args)
      if (expected.pastEof !== undefined) {
        assert.equal(out.blocks.length, 0, `${label}: a past-EOF window must not return a block`)
        assert.match(out.skipped[0].reason, new RegExp(`past EOF \\(${expected.pastEof} lines\\)`),
          `${label}: ${out.skipped[0].reason}`)
        cases++
        continue
      }
      assert.equal(out.blocks.length, 1, `${label}: expected one block, got ${out.blocks.length}`)
      assert.deepEqual(shape(out.blocks[0]), expected, `${label} diverged from the buffered read`)
      cases++
    }
  }
  ok(`read output is identical to the buffered oracle across ${cases} (file × window) combinations`)
}

// --- 4. a CRLF or a multi-byte character split across the 256 KB boundary ---
// The chunk size is an implementation detail, but these two cases are exactly
// what it can get wrong: both would shift every following line by one.
{
  const CHUNK = 256 * 1024
  // Place "\r\n" so that the CR is the last byte of the first chunk.
  const head = 'x'.repeat(CHUNK - 1 - Buffer.byteLength('first\n'))
  const straddle = put('straddle-crlf.txt', `first\n${head}\r\nsecond\nthird\n`)
  const canonical = canonicalize(fs.readFileSync(straddle)).text
  // If the straddled CRLF were folded as two breaks, everything after the
  // boundary shifts by one line: L3 would be empty and L4 would hold "second".
  const after = await run({ path: 'straddle-crlf.txt', lines: 'L3-4' })
  assert.equal(after.blocks.length, 1)
  assert.equal(after.blocks[0].text, 'second\nthird',
    `a CRLF straddling the chunk boundary must be one break, got ${JSON.stringify(after.blocks[0].text)}`)
  assert.equal(after.blocks[0].totalLines, 4, `expected 4 lines, got ${after.blocks[0].totalLines}`)
  assert.deepEqual(shape(after.blocks[0]), buffered(canonical, { start: 3, end: 4 }))
  // The long line itself still comes back (as much as the budget allows).
  const long = await run({ path: 'straddle-crlf.txt', lines: 'L2-2' })
  assert.deepEqual(shape(long.blocks[0]), buffered(canonical, { start: 2, end: 2 }))
  assert.ok(long.blocks[0].text.startsWith(head.slice(0, 64)), 'the long line must come back from its start')

  // A 3-byte character whose bytes are spread over the boundary.
  const pad = 'y'.repeat(CHUNK - 2)
  put('straddle-utf8.txt', `${pad}中\nafter\n`)
  const utf8Canonical = canonicalize(fs.readFileSync(path.join(work, 'straddle-utf8.txt'))).text
  const utf8 = await run({ path: 'straddle-utf8.txt', lines: 'L2-2' })
  assert.equal(utf8.blocks[0].text, 'after', `expected "after", got ${JSON.stringify(utf8.blocks[0].text)}`)
  assert.equal(utf8.blocks[0].totalLines, 2)
  assert.deepEqual(shape(utf8.blocks[0]), buffered(utf8Canonical, { start: 2, end: 2 }))
  ok('a CRLF and a 3-byte character straddling the chunk boundary decode as if unsplit')
}

// --- 5. the chunk size never changes the answer ---------------------------
// Same file, windows far past the first chunk, compared against the oracle:
// this catches an off-by-one that only shows up once `seen` has advanced.
{
  const body = Array.from({ length: 30_000 }, (_, i) => `row ${i + 1} ${'.'.repeat(20)}`).join('\n') + '\n'
  put('deep.txt', body)
  const canonical = canonicalize(fs.readFileSync(path.join(work, 'deep.txt'))).text
  for (const range of [{ start: 1, end: 3 }, { start: 12_000, end: 12_005 }, { start: 29_999, end: 30_100 }]) {
    const out = await run({ path: 'deep.txt', lines: `L${range.start}-${range.end}` })
    assert.equal(out.blocks.length, 1, `L${range.start}: ${JSON.stringify(out.skipped)}`)
    assert.deepEqual(shape(out.blocks[0]), buffered(canonical, range), `L${range.start}-${range.end} diverged`)
  }
  // The whole-file read is line-capped, so the head is what comes back.
  const whole = await run({ path: 'deep.txt' })
  assert.deepEqual(shape(whole.blocks[0]), buffered(canonical, null))
  assert.equal(whole.blocks[0].totalLines, 30_000)
  ok('windows far past the first chunk match the buffered read, and totalLines stays exact')
}

// --- 6. the file is never materialised ------------------------------------
// The point of streaming is peak memory, so assert on it directly: `arrayBuffers`
// is the byte-exact count of Buffer/ArrayBuffer allocations, and the buffered
// read had to allocate the whole file before it could decode a byte.
{
  const BIG_MB = 32
  const LINE = 4096
  const LINES = 8192
  const big = put('big.log', Array.from({ length: LINES }, () => 'z'.repeat(LINE)).join('\n') + '\n')
  assert.ok(fs.statSync(big).size >= BIG_MB * 1024 * 1024, 'fixture must actually be big')
  const readBig = async (args) => {
    const before = process.memoryUsage().arrayBuffers
    const out = await run(args)
    return { out, delta: process.memoryUsage().arrayBuffers - before }
  }
  const tail = await readBig({ path: 'big.log', lines: `L${LINES}-${LINES}` })
  assert.equal(tail.out.blocks.length, 1, JSON.stringify(tail.out.skipped))
  assert.equal(tail.out.blocks[0].totalLines, LINES, 'totalLines must still be counted to EOF')
  assert.equal(tail.out.blocks[0].text, 'z'.repeat(LINE), 'the last line must come back whole')
  assert.ok(tail.delta < 8 * 1024 * 1024,
    `a windowed read of a ${BIG_MB} MB file allocated ${(tail.delta / 1024 / 1024).toFixed(1)} MB of buffers — it is not streaming`)
  ok(`a ${BIG_MB} MB file reads by window without materialising it (${(tail.delta / 1024 / 1024).toFixed(1)} MB allocated)`)
}

// --- 7. refusals stay refusals, wherever the offending byte is ------------
{
  // NUL past the 8 KB sniff window: the buffered read refused it via
  // `canonicalize`, so the streamed read must refuse it too.
  put('nul-late.bin', Buffer.concat([Buffer.from('a'.repeat(20_000)), Buffer.from([0]), Buffer.from('b')]))
  const nul = await run({ path: 'nul-late.bin' })
  assert.equal(nul.blocks.length, 0)
  assert.match(nul.skipped[0].reason, /NUL byte/)

  // NUL inside the sniff window is the "this is a binary target" case.
  put('bin.dat', Buffer.from([1, 0, 2, 0, 3]))
  const nulHead = await run({ path: 'bin.dat' })
  assert.match(nulHead.skipped[0].reason, /binary file/)

  // Invalid UTF-8 whose first offending byte is past the first chunk.
  put('latin1-late.txt', Buffer.concat([Buffer.from('a'.repeat(300_000) + '\n'), Buffer.from([0xe9]), Buffer.from('\n')]))
  const latin = await run({ path: 'latin1-late.txt' })
  assert.equal(latin.blocks.length, 0, 'a file that turns invalid deep inside must not be partially returned')
  assert.match(latin.skipped[0].reason, /not valid UTF-8/)

  // Same file shape, truncated sequence at the very end.
  put('cut-tail.txt', Buffer.concat([Buffer.from('a\n'), Buffer.from([0xe4, 0xb8])]))
  const cut = await run({ path: 'cut-tail.txt' })
  assert.equal(cut.blocks.length, 0)
  assert.match(cut.skipped[0].reason, /not valid UTF-8/)
  ok('NUL, late invalid UTF-8 and a truncated tail are refused with the buffered path\'s reasons')
}

// --- 8. a directory and a missing file keep their reasons -----------------
{
  fs.mkdirSync(path.join(work, 'adir'), { recursive: true })
  const dir = await run({ path: 'adir' })
  assert.equal(dir.skipped[0].reason, 'file not found')
  const missing = await run({ path: 'nope.txt' })
  assert.equal(missing.skipped[0].reason, 'file not found')
  ok('a directory and a missing path are reported as "file not found", as before')
}

// --- 9. a line longer than the byte budget -------------------------------
// No `\n` to wait for, so the collector cannot let it accumulate: it cuts at the
// budget and stops. The line *after* it must still be numbered correctly, which
// is the part a naive "wait for the newline" implementation gets wrong.
{
  const giant = 'q'.repeat(400_000)
  put('giant.txt', `${giant}\nsecond\nthird\n`)
  const canonical = canonicalize(fs.readFileSync(path.join(work, 'giant.txt'))).text
  const first = await run({ path: 'giant.txt', lines: 'L1-1' })
  assert.equal(first.blocks.length, 1)
  assert.equal(first.blocks[0].truncated, true)
  assert.equal(first.blocks[0].text.length, TOTAL_BYTE_BUDGET,
    `the giant line must be cut (per-file cap, then the inline budget), got ${first.blocks[0].text.length}`)
  assert.ok(/^q+$/.test(first.blocks[0].text), 'the cut must fall inside the giant line')
  assert.deepEqual(shape(first.blocks[0]), buffered(canonical, { start: 1, end: 1 }))
  // Reading *past* the giant line proves its break was counted, not its bytes.
  const later = await run({ path: 'giant.txt', lines: 'L2-3' })
  assert.equal(later.blocks[0].text, 'second\nthird', `expected the lines after the giant one, got ${JSON.stringify(later.blocks[0].text)}`)
  assert.equal(later.blocks[0].totalLines, 3)
  // A window that starts after a giant *unwanted* line must not buffer it: the
  // bytes of a line the caller never asked for are dropped as soon as they are
  // recognised as such.
  const skip = await run({ path: 'giant.txt', lines: 'L3-3' })
  assert.equal(skip.blocks[0].text, 'third')
  assert.equal(skip.blocks[0].totalLines, 3)
  ok('a line longer than the byte budget is cut at the cap and does not disturb later line numbers')
}

console.log(`\n${passed} read-stream groups passed`)
fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
