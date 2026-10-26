import { existsSync, lstatSync, openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

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

/** Real path of an existing workspace root; refuses a file or a missing directory. */
export function canonicalWorkspace(root: string): string {
  const canonical = realpathSync(root)
  if (!statSync(canonical).isDirectory()) throw new Error('workspace must be an existing directory')
  return canonical
}
/** True when `target` is `root` itself or lies under it. Both sides must already be canonical. */
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}
/** Canonical form of a file that may not exist yet: realpath the deepest existing ancestor. */
export function canonicalTarget(target: string): string {
  if (existsSync(target)) return realpathSync(target)
  if (isSymbolicLink(target)) throw new Error(`native operation refuses dangling symbolic link identity: ${target}`)
  const parent = path.dirname(target)
  return parent === target ? target : path.join(canonicalTarget(parent), path.basename(target))
}
