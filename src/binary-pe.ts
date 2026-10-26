import { cString, range, SYMBOL_CAP, type BinaryInfo } from './binary-facts.ts'

export function peFacts(bytes: Buffer): BinaryInfo {
  const u16 = (offset: number): number => bytes.readUInt16LE(range(bytes, offset, 2))
  const u32 = (offset: number): number => bytes.readUInt32LE(range(bytes, offset, 4))
  const pe = u32(0x3c)
  if (u32(pe) !== 0x4550) throw new Error('invalid PE signature')
  const machine = u16(pe + 4), sections = u16(pe + 6), optionalSize = u16(pe + 20), optional = pe + 24
  range(bytes, optional, optionalSize)
  const magic = u16(optional), directory = optional + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0)
  if (directory === optional || directory > optional + optionalSize) throw new Error('unsupported PE optional header')
  const directoryCount = u32(directory - 4)
  if (directoryCount > Math.floor((optional + optionalSize - directory) / 8)) throw new Error('PE data directories exceed optional header')
  const headerSize = u32(optional + 60), table = optional + optionalSize
  if (sections > 4096) throw new Error('PE section cap exceeded')
  range(bytes, table, sections * 40)
  const rva = (value: number, size = 1): number => {
    if (value < headerSize && size <= headerSize - value) return range(bytes, value, size)
    for (let n = 0; n < sections; n++) {
      const section = table + n * 40, address = u32(section + 12), rawSize = u32(section + 16), raw = u32(section + 20)
      if (value >= address && value - address <= rawSize - size) return range(bytes, raw + value - address, size)
    }
    throw new Error('unmapped PE metadata RVA')
  }
  const stringRva = (value: number, limit?: number): string => {
    const offset = rva(value)
    let end = value < headerSize ? Math.min(headerSize, bytes.length) : bytes.length
    if (value >= headerSize) for (let n = 0; n < sections; n++) {
      const section = table + n * 40, address = u32(section + 12), rawSize = u32(section + 16), raw = u32(section + 20)
      if (value >= address && value - address < rawSize) { end = Math.min(bytes.length, raw + rawSize); break }
    }
    return cString(bytes, offset, limit === undefined ? end : Math.min(end, offset + limit))
  }
  const out: BinaryInfo = { format: 'PE', architecture: ({ 0x14c: 'x86', 0x8664: 'x86_64', 0xaa64: 'aarch64', 0x1c4: 'arm' } as Record<number, string>)[machine] ?? `machine-${machine.toString(16)}`, exports: [], imports: [], limitations: [] }
  if (directoryCount > 0 && u32(directory)) {
    const exportRva = u32(directory), exportSize = u32(directory + 4), exports = rva(exportRva, 40)
    if (exportSize < 40 || exportRva + exportSize > 0x1_0000_0000) throw new Error('invalid PE export directory size')
    const base = u32(exports + 16), count = u32(exports + 20), names = u32(exports + 24)
    if (count > SYMBOL_CAP || names > SYMBOL_CAP) throw new Error('PE export cap exceeded')
    const functions = rva(u32(exports + 28), count * 4), nameTable = names ? rva(u32(exports + 32), names * 4) : 0, ordinals = names ? rva(u32(exports + 36), names * 2) : 0
    const named = new Set<number>()
    const emit = (index: number, name: string): void => {
      if (index >= count) throw new Error('invalid PE export ordinal')
      const target = u32(functions + index * 4)
      if (!target) return
      const forwarded = target >= exportRva && target < exportRva + exportSize
      if (out.exports.length >= SYMBOL_CAP) { if (!out.limitations.length) out.limitations.push('PE symbol output cap reached'); return }
      out.exports.push({ name, kind: forwarded ? 'forwarder' : 'export', ordinal: base + index, ...(forwarded ? { forwarder: stringRva(target, exportRva + exportSize - target) } : {}) })
    }
    for (let n = 0; n < names; n++) { const index = u16(ordinals + n * 2); named.add(index); emit(index, stringRva(u32(nameTable + n * 4))) }
    for (let n = 0; n < count; n++) if (!named.has(n)) emit(n, '#' + (base + n))
  }
  if (directoryCount > 1 && u32(directory + 8)) {
    const start = u32(directory + 8), size = u32(directory + 12)
    let terminated = false
    const libraries = new Set<string>()
    for (let n = 0; n < Math.min(Math.floor(size / 20), SYMBOL_CAP); n++) {
      const descriptor = rva(start + n * 20, 20)
      if ([0, 4, 8, 12, 16].every(offset => u32(descriptor + offset) === 0)) { terminated = true; break }
      const name = stringRva(u32(descriptor + 12))
      if (!libraries.has(name)) { libraries.add(name); out.imports.push(name) }
    }
    if (!terminated) out.limitations.push('PE import directory was not fully enumerated')
  }
  if (directoryCount > 13 && u32(directory + 13 * 8)) out.limitations.push('delay-load imports are not enumerated')
  return out
}
