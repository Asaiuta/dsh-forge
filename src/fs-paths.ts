import { lstatSync, openSync, closeSync, fstatSync, readSync } from 'node:fs'

/** Raw byte budget applies before decoding; a growing file never exceeds it. */
export function readBoundedFile(file: string, maxBytes: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    if (size > maxBytes) throw new Error(`${file} exceeds the ${maxBytes}-byte read cap`)
    const buffer = Buffer.allocUnsafe(size + 1)
    let used = 0
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null)
      if (!count) break
      used += count
    }
    if (used > size) throw new Error(`${file} grew while reading; retry with a stable file`)
    return buffer.subarray(0, used)
  } finally { closeSync(fd) }
}

/** Link identity exists even when its destination does not. Other I/O errors propagate. */
export function isSymbolicLink(file: string): boolean {
  return lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
}
