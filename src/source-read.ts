/** Bounded UTF-8 reads shared by batch source reads and executable targets. */
import { createHash } from 'node:crypto'
import { readBoundedFile } from './fs-paths.ts'
import { observedRead, type ForgeExec } from './core.ts'
import { findSymbol, normalizeText, parseFile, type ParsedFile, type AstSymbol } from './ast.ts'

export const SOURCE_BYTES = 2 * 1024 * 1024
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export async function sourceRead(file: string, exec?: ForgeExec) {
  return observedRead(exec, file, native => {
    exec?.signal?.throwIfAborted()
    const bytes = readBoundedFile(native, SOURCE_BYTES)
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (decoded.includes('\0')) throw new Error('binary text is unsupported')
    return { file, native, text: normalizeText(decoded), snapshot: sha256(bytes), bytes: bytes.length }
  })
}
export async function sourceSymbol(source: Awaited<ReturnType<typeof sourceRead>>, name: string, line?: number): Promise<{ parsed: ParsedFile; symbol: AstSymbol }> {
  const parsed = await parseFile(source.file, { readPath: source.native })
  if (!parsed.value) throw new Error(parsed.error ?? 'AST unavailable')
  if (parsed.value.text !== source.text) throw new Error('source changed during symbol resolution; retry')
  if (parsed.value.partial) throw new Error('source has syntax errors; exact symbol selection refused')
  let found = findSymbol(parsed.value.symbols, name, true)
  const qualified = found.filter(s => s.qualifiedName.replace(/::/g, '.') === name.replace(/::/g, '.'))
  if (qualified.length) found = qualified
  if (line !== undefined) found = found.filter(s => s.startLine === line)
  if (found.length !== 1) throw new Error(found.length ? 'ambiguous symbol; use its qualified name and declaration line' : `symbol not found: ${name}`)
  return { parsed: parsed.value, symbol: found[0] }
}
