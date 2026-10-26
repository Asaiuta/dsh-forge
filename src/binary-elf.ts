import { cString, range, SYMBOL_CAP, type BinaryInfo } from './binary-facts.ts'

export function elfFacts(bytes: Buffer): BinaryInfo {
  range(bytes, 0, 16)
  const wide = bytes[4] === 2, little = bytes[5] === 1
  if (![1, 2].includes(bytes[4]) || ![1, 2].includes(bytes[5]) || bytes[6] !== 1) throw new Error('unsupported ELF encoding')
  const u16 = (offset: number): number => little ? bytes.readUInt16LE(range(bytes, offset, 2)) : bytes.readUInt16BE(range(bytes, offset, 2))
  const u32 = (offset: number): number => little ? bytes.readUInt32LE(range(bytes, offset, 4)) : bytes.readUInt32BE(range(bytes, offset, 4))
  const word = (offset: number): number => {
    if (!wide) return u32(offset)
    const value = little ? bytes.readBigUInt64LE(range(bytes, offset, 8)) : bytes.readBigUInt64BE(range(bytes, offset, 8))
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('oversized ELF offset')
    return Number(value)
  }
  range(bytes, 0, wide ? 64 : 52)
  const machine = u16(18), table = word(wide ? 40 : 32), entrySize = u16(wide ? 58 : 46)
  let count = u16(wide ? 60 : 48)
  const out: BinaryInfo = { format: 'ELF', architecture: ({ 3: 'x86', 62: 'x86_64', 40: 'arm', 183: 'aarch64', 243: 'riscv' } as Record<number, string>)[machine] ?? `machine-${machine}`, exports: [], imports: [], limitations: [] }
  if (!table) { out.limitations.push('ELF without section headers: dynamic symbols and libraries are not enumerated'); return out }
  if (entrySize < (wide ? 64 : 40)) throw new Error('invalid ELF section header size')
  range(bytes, table, entrySize)
  if (!count) count = word(table + (wide ? 32 : 20))
  if (count > SYMBOL_CAP) throw new Error('ELF section cap exceeded')
  range(bytes, table, entrySize * count)
  const sections = Array.from({ length: count }, (_, n) => {
    const base = table + n * entrySize
    return { type: u32(base + 4), offset: word(base + (wide ? 24 : 16)), size: word(base + (wide ? 32 : 20)), link: u32(base + (wide ? 40 : 24)), stride: word(base + (wide ? 56 : 36)) }
  })
  let entries = 0
  const seen = new Set<string>(), libraries = new Set<string>()
  for (const section of sections) {
    // SHT_SYMTAB includes internal, non-exported globals. Only SHT_DYNSYM
    // supplies dynamic export evidence; ordinary symbols never enter ffi:.
    if (![6, 11].includes(section.type)) continue
    const strings = sections[section.link]
    if (!strings || strings.type !== 3) throw new Error('invalid ELF linked string table')
    range(bytes, section.offset, section.size); range(bytes, strings.offset, strings.size)
    const minimum = section.type === 6 ? wide ? 16 : 8 : wide ? 24 : 16
    if (section.stride < minimum || section.size % section.stride) throw new Error('invalid ELF metadata stride')
    const rows = section.size / section.stride
    if (rows > 200_000 || (entries += rows) > 400_000) throw new Error('ELF metadata entry cap exceeded')
    const stringAt = (offset: number): string => { if (offset >= strings.size) throw new Error('ELF string offset exceeds table'); return cString(bytes, strings.offset + offset, strings.offset + strings.size) }
    for (let n = 0; n < rows; n++) {
      const base = section.offset + n * section.stride
      if (section.type === 6) {
        const tag = word(base)
        if (!tag) break
        if (tag === 1) { const name = stringAt(word(base + (wide ? 8 : 4))); if (!libraries.has(name)) { libraries.add(name); out.imports.push(name) } }
      } else {
        const info = bytes[base + (wide ? 4 : 12)], visibility = bytes[base + (wide ? 5 : 13)] & 3, defined = u16(base + (wide ? 6 : 14)) !== 0
        if (![1, 2].includes(info >> 4) || ![0, 3].includes(visibility) || !defined || !u32(base)) continue
        const name = stringAt(u32(base))
        if (seen.has(name)) continue
        if (out.exports.length >= SYMBOL_CAP) { if (!out.limitations.includes('ELF symbol output cap reached')) out.limitations.push('ELF symbol output cap reached'); continue }
        seen.add(name); out.exports.push({ name, kind: ({ 1: 'object', 2: 'function', 6: 'tls', 10: 'ifunc' } as Record<number, string>)[info & 15] ?? 'symbol' })
      }
    }
  }
  return out
}
