/**
 * Source evidence: bytes, canonical text and positions are three different
 * things, and every conversion between them is explicit (M0.7).
 *
 * The failure this prevents: an offset or a hash produced from one reading of a
 * file being used to certify a different reading. Concretely — CRLF files,
 * multi-byte UTF-8, a BOM, and `context` lines around a symbol each move a line
 * number or an offset in a way that arithmetic does not predict.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  byteOffsetToTextOffset, canonicalize, lineCount, lineStartOffset, offsetOf, positionAt,
  rangeForLines, rangeForSlice, readSourceSnapshot, sha256Hex, sliceSourceRef, sourceRef, SourceEncodingError,
} from '../lib/source-evidence.js'
import { createReadTool } from '../lib/tools-read.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-source-evidence-'))
const write = (rel, data) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
  return abs
}
const exec = { agent: { session: { header: { cwd: root, id: 'evidence' } } }, token: {} }

try {
  // --- 1. canonical text, BOM and EOL provenance -----------------------------
  {
    const abs = write('crlf.js', '\uFEFFconst a = 1\r\nconst b = 2\r\n')
    const snap = readSourceSnapshot(abs)
    assert.equal(snap.text, 'const a = 1\nconst b = 2\n')
    assert.equal(snap.bom, true)
    assert.equal(snap.eol, 'CRLF')
    assert.equal(snap.encoding, 'utf16-lf-no-bom')
    assert.equal(snap.rawHash, sha256Hex(fs.readFileSync(abs)))
    assert.equal(snap.textHash, sha256Hex(snap.text))
    assert.notEqual(snap.rawHash, snap.textHash, 'raw and canonical identities must differ for CRLF+BOM')
    assert.equal(snap.bytes, fs.statSync(abs).size)
    ok('one read yields rawHash, textHash, BOM and EOL provenance')
  }

  // --- 2. positions round-trip, including non-BMP characters -----------------
  {
    const text = 'a😀b\n中文行\nlast'
    // "😀" is two UTF-16 code units: the b is at character 3, not 2.
    assert.deepEqual(positionAt(text, 0), { line: 0, character: 0 })
    assert.deepEqual(positionAt(text, 3), { line: 0, character: 3 })
    assert.deepEqual(positionAt(text, 5), { line: 1, character: 0 })
    assert.deepEqual(positionAt(text, text.length), { line: 2, character: 4 })
    for (const offset of [0, 1, 5, 6, 9, text.length]) {
      assert.equal(offsetOf(text, positionAt(text, offset)), offset, `round trip at ${offset}`)
    }
    assert.deepEqual(rangeForSlice(text, 2, 3), { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } })
    assert.deepEqual(rangeForLines(text, 2, 2), { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } })
    assert.equal(lineStartOffset(text, 1), 0)
    assert.equal(lineStartOffset(text, 2), 5)
    assert.equal(lineStartOffset(text, 99), text.length)
    assert.equal(lineCount('a\nb\n'), 2)
    assert.equal(lineCount(''), 1)
    assert.equal(lineCount('a\nb'), 2)
    ok('positions are 0-based UTF-16 and round-trip across non-BMP characters')
  }

  // --- 3. byte offsets need the prefix decoded, not divided -----------------
  {
    const body = 'x = "中文"\r\ny = 2\r\n'
    const raw = Buffer.from(body, 'utf8')
    const { text } = canonicalize(raw)
    // The byte offset of `y` is past a multi-byte string and a CRLF pair.
    const byteOfY = raw.indexOf(Buffer.from('y = 2'))
    const textOfY = text.indexOf('y = 2')
    assert.ok(byteOfY > textOfY, 'bytes outrun UTF-16 offsets for CJK content')
    assert.equal(byteOffsetToTextOffset(raw, byteOfY, text), textOfY)
    assert.equal(byteOffsetToTextOffset(raw, 0, text), 0)
    assert.equal(byteOffsetToTextOffset(raw, raw.length, text), text.length)
    // Just after the CR of a CRLF pair: canonical text has no such position.
    const crAt = raw.indexOf(Buffer.from('\r'))
    assert.throws(() => byteOffsetToTextOffset(raw, crAt + 1, text), /inside a CRLF/)
    // Mid-sequence offset (inside 中) is refused rather than rounded.
    assert.throws(() => byteOffsetToTextOffset(raw, raw.indexOf(Buffer.from('中')) + 1, text), SourceEncodingError)
    ok('byte→text mapping decodes the prefix and refuses CRLF-interior and mid-sequence offsets')
  }

  // --- 4. unsupported encodings are refused, not lossily decoded ------------
  {
    const latin1 = write('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])) // "café" in Latin-1
    assert.throws(() => readSourceSnapshot(latin1), SourceEncodingError)
    const utf16 = write('utf16.txt', Buffer.from([0xff, 0xfe, 0x61, 0x00]))
    assert.throws(() => readSourceSnapshot(utf16), SourceEncodingError)
    const binary = write('blob.bin', Buffer.from([0x41, 0x00, 0x42]))
    assert.throws(() => readSourceSnapshot(binary), SourceEncodingError)
    // ff_read refuses with the same reason instead of printing U+FFFD text
    // whose positions no edit could ever target.
    const read = createReadTool()
    const refused = await read.execute({ path: 'latin1.txt' }, exec)
    assert.equal(refused.blocks.length, 0)
    assert.match(refused.skipped[0].reason, /not valid UTF-8/)
    ok('Latin-1, UTF-16 and binary inputs are refused with an encoding error')
  }

  // --- 5. a SourceRef binds text identity and survives only that identity ---
  {
    const abs = write('ref.js', 'const value = 1\n')
    const snap = readSourceSnapshot(abs)
    const start = snap.text.indexOf('value')
    const ref = sourceRef(snap, 'ref.js', 'ws-1', { start, end: start + 5 })
    assert.equal(ref.rawHash, snap.rawHash)
    assert.equal(ref.textHash, snap.textHash)
    assert.deepEqual(ref.position.start, { line: 0, character: 6 })
    assert.equal(sliceSourceRef(snap, ref), 'value')
    const sameBytes = readSourceSnapshot(abs)
    assert.equal(sliceSourceRef(sameBytes, ref), 'value')
    write('ref.js', 'const value = 2\n')
    const later = readSourceSnapshot(abs)
    assert.throws(() => sliceSourceRef(later, ref), /source changed/)
    ok('a SourceRef is only usable against the text identity it was made from')
  }

  // --- 6. ff_read reports the range it actually emitted ---------------------
  {
    write('ctx.js', [
      '// file header',
      'const before = 0',
      'function target(a, b) {',
      '  const sum = a + b',
      '  return sum',
      '}',
      'const after = 1',
      '',
    ].join('\n'))
    const read = createReadTool()
    const plain = await read.execute({ path: 'ctx.js', lines: 'L3-L5' }, exec)
    assert.equal(plain.blocks.length, 1)
    assert.equal(plain.blocks[0].lines, 'L3-5')
    // The emitted text stops at the last character it shows, not at a newline
    // it never included: half-open range, end = 12 chars into line 5.
    assert.deepEqual(plain.blocks[0].displayRange, {
      start: { line: 2, character: 0 },
      end: { line: 4, character: 12 },
    })
    assert.equal(plain.blocks[0].text, 'function target(a, b) {\n  const sum = a + b\n  return sum')

    const symbolRead = await read.execute({ path: 'ctx.js', symbol: 'target', context: 1 }, exec)
    const block = symbolRead.blocks[0]
    assert.equal(block.lines, 'L3-6', 'the label still names the symbol span')
    // With context=1 the emitted text starts at L2, so displayRange and
    // symbolRange must differ — this is the bug M0.7 removes.
    assert.deepEqual(block.displayRange.start, { line: 1, character: 0 })
    assert.deepEqual(block.symbolRange, {
      start: { line: 2, character: 0 },
      end: { line: 6, character: 0 },
    })
    assert.equal(block.text.split('\n')[0], 'const before = 0')
    ok('ff_read reports display and symbol ranges separately, from the emitted text')
  }

  // --- 7. a UTF-8 file read through ff_read keeps CRLF/BOM canonical ---------
  {
    write('win.js', '\uFEFFconst a = 1\r\nconst b = 2\r\n')
    const read = createReadTool()
    const result = await read.execute({ path: 'win.js', lines: 'L2-L2' }, exec)
    assert.equal(result.blocks[0].text, 'const b = 2')
    assert.deepEqual(result.blocks[0].displayRange, {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 11 },
    })
    ok('a CRLF+BOM file reports canonical positions for the emitted window')
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${passed} source evidence groups passed`)
