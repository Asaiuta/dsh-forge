/** Bounded metadata readers. No binary is loaded, instantiated or executed. */
import { peFacts } from './binary-pe.ts'
import { elfFacts } from './binary-elf.ts'

export interface BinaryExport { name: string; kind: string; ordinal?: number; forwarder?: string }
export interface BinaryInfo {
  format: 'PE' | 'ELF' | 'WebAssembly'
  architecture: string
  exports: BinaryExport[]
  imports: string[]
  limitations: string[]
}
export const BINARY_EXTENSIONS = new Set(['.exe', '.dll', '.node', '.so', '.elf', '.wasm'])
export const MAX_BINARY_BYTES = 32 * 1024 * 1024
export const SYMBOL_CAP = 20_000

export function range(bytes: Buffer, offset: number, size: number): number {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > bytes.length - size) throw new Error('binary metadata exceeds file bounds')
  return offset
}
export function cString(bytes: Buffer, offset: number, limit = bytes.length): string {
  range(bytes, offset, 1)
  const bounded = bytes.subarray(offset, Math.min(limit, bytes.length, offset + 4097))
  const end = bounded.indexOf(0)
  if (end < 0) throw new Error('invalid binary string')
  return new TextDecoder('utf-8', { fatal: true }).decode(bounded.subarray(0, end))
}

function wasmFacts(bytes: Buffer): BinaryInfo {
  if (bytes.readUInt32LE(range(bytes, 4, 4)) !== 1) throw new Error('unsupported WebAssembly version')
  const out: BinaryInfo = { format: 'WebAssembly', architecture: 'wasm', exports: [], imports: [], limitations: [] }
  let cursor = 8, boundary = bytes.length
  const byte = (): number => { if (cursor >= boundary) throw new Error('truncated WebAssembly metadata'); return bytes[cursor++] }
  const leb = (): number => {
    let value = 0, shift = 0
    for (let n = 0; n < 5; n++) { const next = byte(); if (n === 4 && next > 15) throw new Error('oversized WebAssembly u32'); value += (next & 127) * 2 ** shift; if (!(next & 128)) return value; shift += 7 }
    throw new Error('invalid WebAssembly integer')
  }
  const str = (): string => { const size = leb(); if (size > 4096 || cursor > boundary - size) throw new Error('invalid WebAssembly name'); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor, cursor + size)); cursor += size; return text }
  const limits = (): void => { const flags = leb(); if (flags > 3 || flags === 2) throw new Error('unsupported WebAssembly limits (including memory64)'); const min = leb(), max = flags & 1 ? leb() : undefined; if (max !== undefined && max < min) throw new Error('invalid WebAssembly limits') }
  const seen = new Set<number>()
  const exportNames = new Set<string>(), libraries = new Set<string>()
  while (cursor < bytes.length) {
    boundary = bytes.length
    const id = byte(), size = leb(), end = cursor + size
    range(bytes, cursor, size); boundary = end
    if (id === 2 || id === 7) {
      if (seen.has(id)) throw new Error('duplicate WebAssembly metadata section')
      seen.add(id)
      const count = leb()
      if (count > SYMBOL_CAP) throw new Error('WebAssembly metadata entry cap exceeded')
      for (let n = 0; n < count; n++) {
        if (id === 7) {
          const name = str(), kind = byte(); leb()
          if (exportNames.has(name)) throw new Error('duplicate WebAssembly export name')
          exportNames.add(name)
          const kinds = ['function', 'table', 'memory', 'global', 'tag']
          if (!kinds[kind]) throw new Error('unsupported WebAssembly export kind')
          out.exports.push({ name, kind: kinds[kind] })
        } else {
          const module = str(); str()
          if (!libraries.has(module)) { libraries.add(module); out.imports.push(module) }
          const kind = byte()
          if (kind === 0) leb()
          else if (kind === 1) { if (![0x70, 0x6f].includes(byte())) throw new Error('unsupported WebAssembly reference type'); limits() }
          else if (kind === 2) limits()
          else if (kind === 3) { if (![0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f].includes(byte()) || byte() > 1) throw new Error('unsupported WebAssembly global type') }
          else if (kind === 4) { if (byte() !== 0) throw new Error('unsupported WebAssembly tag'); leb() }
          else throw new Error('unsupported WebAssembly import kind')
        }
      }
      if (cursor !== end) throw new Error('unexpected WebAssembly metadata payload')
    }
    cursor = end
  }
  return out
}

export function binaryFacts(bytes: Buffer): BinaryInfo {
  if (bytes.length > MAX_BINARY_BYTES) throw new Error('binary size cap exceeded')
  if (bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) return wasmFacts(bytes)
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) return elfFacts(bytes)
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'MZ') return peFacts(bytes)
  throw new Error('unsupported binary metadata format (PE, ELF and WebAssembly only)')
}
