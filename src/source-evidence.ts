/**
 * One read, two identities, one coordinate system.
 *
 * A file has three descriptions that look interchangeable and are not:
 *
 *   raw bytes        — what sha256 over the file actually hashes;
 *   canonical text   — BOM stripped, CRLF/CR folded to LF, strict UTF-8;
 *   positions        — 0-based line/character in UTF-16 code units.
 *
 * Mixing them silently is how "the same line" turns out to be a different
 * character, how an offset from the native sidecae lands mid-glyph, and how a
 * hash computed from a second read certifies content that was never parsed.
 * This module is the only place that converts between them, and every
 * conversion is explicit (C1 in docs/forge-plan-contracts.md, M0.7).
 *
 * Rules encoded here:
 *
 *   - `rawHash` is SHA-256 over the bytes on disk; `textHash` is SHA-256 over
 *     the canonical text. They are different identities and never stand in for
 *     each other.
 *   - Offsets are UTF-16 code units in canonical text, half-open. Display line
 *     numbers stay 1-based; structured positions are 0-based.
 *   - A byte offset from another process is mapped by decoding the prefix, not
 *     by assuming one byte per character — multi-byte UTF-8 and CRLF both make
 *     arithmetic wrong.
 *   - Unsupported encodings (UTF-16, non-UTF-8 bytes, binary) are refused
 *     rather than edited through a lossy decode.
 *
 * @module dsh-forge/source-evidence
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** 0-based, UTF-16 code units — TypeScript/JS string indices, not bytes. */
export interface SourcePosition {
  line: number
  character: number
}

/** Half-open range in canonical text. */
export interface SourceRange {
  start: SourcePosition
  end: SourcePosition
}

/** What the text identity is: LF canonical, no BOM, UTF-8 source. */
export const SOURCE_ENCODING = 'utf16-lf-no-bom' as const

/**
 * A position-bound reference into one file revision.
 *
 * `start`/`end` are canonical-text offsets; `position` is the same range in
 * 0-based line/character form. Both are carried because tools display lines and
 * apply offsets, and deriving one from the other later would need the same text
 * revision that produced this reference.
 */
export interface SourceRef {
  workspaceId: string
  /** Display path (workspace-relative when inside the workspace). */
  file: string
  rawHash: string
  textHash: string
  start: number
  end: number
  encoding: typeof SOURCE_ENCODING
  position: SourceRange
}

export interface SourceSnapshot {
  /** Absolute path this snapshot was read from. */
  file: string
  /** Byte length of the raw file. */
  bytes: number
  /** SHA-256 of the raw bytes (hex). */
  rawHash: string
  /** SHA-256 of `text` (hex). */
  textHash: string
  /** Canonical text: BOM stripped, EOL folded to LF. */
  text: string
  bom: boolean
  eol: 'LF' | 'CRLF' | 'CR'
  encoding: typeof SOURCE_ENCODING
}

export class SourceEncodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceEncodingError'
  }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** First EOL style present, in file order. Mixed files report the first one;
 *  canonicalization folds all of them, so this is provenance, not a guarantee. */
export function detectEol(text: string): 'LF' | 'CRLF' | 'CR' {
  const crlf = text.indexOf('\r\n')
  const lf = text.indexOf('\n')
  const cr = text.indexOf('\r')
  if (crlf !== -1 && (cr === crlf)) return 'CRLF'
  if (cr !== -1 && (lf === -1 || cr < lf)) return 'CR'
  return 'LF'
}

/**
 * Decode bytes into canonical text, refusing what cannot round-trip.
 *
 * Strict UTF-8 (`fatal`) is the point: a Latin-1 file decoded with replacement
 * characters would hash to something that is not its own content, and an edit
 * written back would corrupt it.
 */
export function canonicalize(raw: Buffer): { text: string; bom: boolean; eol: 'LF' | 'CRLF' | 'CR' } {
  if (raw.includes(0)) throw new SourceEncodingError('binary content (NUL byte) — use the binary/attachment path')
  let decoded: string
  try {
    // ignoreBOM keeps U+FEFF in the string so `bom` can be reported and the BOM
    // can be stripped exactly once, here, instead of by every caller.
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
  } catch {
    throw new SourceEncodingError('not valid UTF-8 — the file cannot be edited or positioned as text')
  }
  const bom = decoded.charCodeAt(0) === 0xfeff
  const body = bom ? decoded.slice(1) : decoded
  return { text: body.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), bom, eol: detectEol(body) }
}

/**
 * Incremental {@link canonicalize}: same conversions, same refusals, no
 * whole-file buffer.
 *
 * `canonicalize` needs the entire file in memory, and then some: raw bytes,
 * decoded string, and the `split('\n')` array the callers build on top of it —
 * three copies before a single line is emitted. That is why a 200 MB file could
 * not be read at all, and why the read path was capped at what fits comfortably
 * rather than at what is safe. Feeding 256 KB at a time keeps the peak flat
 * while producing **byte-identical** canonical text, so line numbers, edits and
 * hashes keep meaning the same thing.
 *
 * Two things a chunk boundary can cut in half are held across calls: an
 * incomplete UTF-8 sequence (the decoder's own state) and a lone `\r` that may
 * be the first half of a `\r\n` (this class's `pendingCR`). Decoding without
 * holding the second is how a CRLF file split at exactly the wrong byte becomes
 * one extra line — which is worse than failing, because the numbers still look
 * plausible.
 */
export class CanonicalStream {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  private bomPending = true
  private pendingCR = false
  private sawBom = false

  /**
   * Decode the next raw chunk.
   *
   * @param chunk - the next slice of the file, in file order.
   * @returns the canonical text this chunk produced; may be shorter than the
   *   chunk, and may be empty when the chunk ended mid-sequence.
   * @throws {SourceEncodingError} on bytes that are not valid UTF-8.
   */
  push(chunk: Buffer): string {
    return this.normalize(this.decode(chunk, true))
  }

  /**
   * End the stream and take whatever is still held.
   *
   * Must be called: without the final flush a file truncated mid-sequence would
   * decode to its valid prefix instead of being refused, and a trailing lone `\r`
   * would disappear instead of becoming a line break.
   *
   * @returns the remaining canonical text (usually one line break or nothing).
   * @throws {SourceEncodingError} when the file ends inside a UTF-8 sequence.
   */
  end(): string {
    const tail = this.normalize(this.decode(undefined, false))
    if (!this.pendingCR) return tail
    this.pendingCR = false
    return `${tail}\n`
  }

  /** Whether the file began with a byte-order mark (reported, never kept). */
  get bom(): boolean {
    return this.sawBom
  }

  private decode(chunk: Buffer | undefined, stream: boolean): string {
    try {
      return this.decoder.decode(chunk, { stream })
    } catch {
      throw new SourceEncodingError('not valid UTF-8 — the file cannot be edited or positioned as text')
    }
  }

  private normalize(text: string): string {
    let out = text
    // ignoreBOM keeps U+FEFF in the output so it can be reported and stripped
    // exactly once — the same contract `canonicalize` implements.
    if (this.bomPending && out !== '') {
      this.bomPending = false
      if (out.charCodeAt(0) === 0xfeff) {
        this.sawBom = true
        out = out.slice(1)
      }
    }
    if (this.pendingCR) {
      this.pendingCR = false
      out = `\r${out}`
    }
    // A `\r` at the very end may be the first half of a `\r\n` whose `\n` is in
    // the next chunk. Held instead of folded, because folding it here would emit
    // two breaks where the file has one.
    if (out.endsWith('\r')) {
      this.pendingCR = true
      out = out.slice(0, -1)
    }
    if (out.indexOf('\r') === -1) return out
    return out.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }
}

/**
 * Read a source file exactly once and derive every identity from that read.
 *
 * One Buffer feeds the hash and the parse: hashing a second read would certify
 * content nobody analyzed (C1 rule 5).
 */
export function readSourceSnapshot(abs: string, maxBytes?: number): SourceSnapshot {
  const raw = readFileSync(abs)
  if (maxBytes !== undefined && raw.length > maxBytes) {
    throw new SourceEncodingError(`file exceeds the ${maxBytes}-byte cap for source evidence`)
  }
  const { text, bom, eol } = canonicalize(raw)
  return {
    file: abs,
    bytes: raw.length,
    rawHash: sha256Hex(raw),
    textHash: sha256Hex(text),
    text,
    bom,
    eol,
    encoding: SOURCE_ENCODING,
  }
}

/** 0-based line/character for a canonical-text offset. */
export function positionAt(text: string, offset: number): SourcePosition {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    throw new RangeError(`offset ${offset} is outside canonical text (0…${text.length})`)
  }
  let line = 0
  let lineStart = 0
  for (;;) {
    const next = text.indexOf('\n', lineStart)
    if (next === -1 || next >= offset) break
    line++
    lineStart = next + 1
  }
  return { line, character: offset - lineStart }
}

/** Canonical-text offset for a 0-based position; clamped to the line's content. */
export function offsetOf(text: string, position: SourcePosition): number {
  if (!Number.isInteger(position.line) || position.line < 0) throw new RangeError(`line ${position.line} must be a non-negative integer`)
  if (!Number.isInteger(position.character) || position.character < 0) throw new RangeError(`character ${position.character} must be a non-negative integer`)
  let lineStart = 0
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf('\n', lineStart)
    if (next === -1) throw new RangeError(`line ${position.line} is past the end of the text`)
    lineStart = next + 1
  }
  const lineEnd = (() => {
    const next = text.indexOf('\n', lineStart)
    return next === -1 ? text.length : next
  })()
  return Math.min(lineStart + position.character, lineEnd)
}

/** Offset where a 1-based display line starts; the last line + 1 maps to EOF. */
export function lineStartOffset(text: string, line1: number): number {
  if (!Number.isInteger(line1) || line1 < 1) throw new RangeError(`line ${line1} must be a 1-based integer`)
  let start = 0
  for (let line = 1; line < line1; line++) {
    const next = text.indexOf('\n', start)
    if (next === -1) return text.length
    start = next + 1
  }
  return start
}

/** Number of lines in canonical text (a trailing newline does not add one). */
export function lineCount(text: string): number {
  if (text === '') return 1
  const breaks = text.split('\n').length
  return text.endsWith('\n') ? breaks - 1 : breaks
}

/**
 * The range actually emitted by a slice that began at `startLine1`.
 *
 * `length` is the length of the text handed to the caller, so a byte-capped or
 * budget-trimmed block reports the range of what was shown — not the range the
 * planner intended. That mismatch is the bug M0.7 exists to remove.
 */
export function rangeForSlice(text: string, startLine1: number, length: number): SourceRange {
  const start = lineStartOffset(text, startLine1)
  const end = Math.min(start + Math.max(0, length), text.length)
  return { start: positionAt(text, start), end: positionAt(text, end) }
}

/** A complete range for lines `startLine1 … endLine1` (inclusive, 1-based). */
export function rangeForLines(text: string, startLine1: number, endLine1: number): SourceRange {
  const start = lineStartOffset(text, startLine1)
  const end = lineStartOffset(text, endLine1 + 1)
  return { start: positionAt(text, start), end: positionAt(text, end) }
}

/**
 * The range a **windowed** read emitted, from the emitted text alone.
 *
 * {@link rangeForSlice} needs the whole file to find where the first line
 * starts; a streaming read never had the whole file, only lines
 * `startLine1 …` and the knowledge that they began at a line boundary. Given
 * that, the range is exactly the positions {@link positionAt} would produce at
 * offsets `0 … text.length` — so this is the same answer, computed locally
 * instead of by walking the file.
 */
export function rangeForWindow(text: string, startLine1: number): SourceRange {
  const first = Math.max(1, startLine1) - 1
  const parts = text.split('\n')
  return {
    start: { line: first, character: 0 },
    end: { line: first + parts.length - 1, character: parts[parts.length - 1].length },
  }
}

/**
 * Map a byte offset in the raw file to a canonical-text offset.
 *
 * Decodes the prefix and measures it: with CRLF, a BOM, or multi-byte UTF-8 the
 * answer is not the byte count, and treating it as one edits the wrong glyph.
 * `byteOffset` must fall on a UTF-8 sequence boundary; a mid-sequence offset is
 * refused instead of being rounded into a neighbouring character.
 */
export function byteOffsetToTextOffset(raw: Buffer, byteOffset: number, canonical?: string): number {
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > raw.length) {
    throw new RangeError(`byte offset ${byteOffset} is outside the file (0…${raw.length})`)
  }
  // A CRLF is two bytes with no canonical counterpart in between: pretending the
  // offset is "after the CR" would point between the line's content and its
  // break, which no canonical text can express.
  if (byteOffset > 0 && byteOffset < raw.length && raw[byteOffset - 1] === 0x0d && raw[byteOffset] === 0x0a) {
    throw new SourceEncodingError(`byte offset ${byteOffset} falls inside a CRLF line break`)
  }
  let prefix: string
  try {
    prefix = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.subarray(0, byteOffset))
  } catch {
    throw new SourceEncodingError(`byte offset ${byteOffset} is not on a UTF-8 sequence boundary`)
  }
  const bom = prefix.charCodeAt(0) === 0xfeff
  const normalized = (bom ? prefix.slice(1) : prefix).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (canonical !== undefined && !canonical.startsWith(normalized)) {
    throw new SourceEncodingError('byte offset does not agree with the canonical text it was given')
  }
  return normalized.length
}

/** Build a position-bound reference from a canonical snapshot. */
export function sourceRef(snapshot: SourceSnapshot, file: string, workspaceId: string, range: { start: number; end: number }): SourceRef {
  if (range.start < 0 || range.end < range.start || range.end > snapshot.text.length) {
    throw new RangeError(`range ${range.start}…${range.end} is outside canonical text`)
  }
  return {
    workspaceId,
    file,
    rawHash: snapshot.rawHash,
    textHash: snapshot.textHash,
    start: range.start,
    end: range.end,
    encoding: SOURCE_ENCODING,
    position: { start: positionAt(snapshot.text, range.start), end: positionAt(snapshot.text, range.end) },
  }
}

/** The slice a reference denotes, after verifying the text still matches it. */
export function sliceSourceRef(snapshot: SourceSnapshot, ref: Pick<SourceRef, 'start' | 'end' | 'textHash'>): string {
  if (snapshot.textHash !== ref.textHash) {
    throw new SourceEncodingError('source changed since this reference was made (text hash differs) — re-read before using it')
  }
  return snapshot.text.slice(ref.start, ref.end)
}
