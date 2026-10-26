/** Lexical C++20 module facts; old grammars still report their parse errors. */
import type { ModuleFact } from './module-facts.ts'
import type { ModuleInfo } from './language-facts.ts'
import { nativeTokens, type NativeToken } from './native-syntax.ts'

const component = '[A-Za-z_][A-Za-z_0-9]*(?:\\.[A-Za-z_][A-Za-z_0-9]*)*'
const namedModule = new RegExp(`^${component}(?::${component})?$`)
const partition = new RegExp(`^:${component}$`)

export function cppModules(source: string): { modules: ModuleFact[]; info?: ModuleInfo } {
  if (!/\b(?:module|import)\b/.test(source) && !/\\\r?\n/.test(source)) return { modules: [] }
  const modules: ModuleFact[] = [], declarations: NonNullable<ModuleInfo['cppModules']> = []
  const macros = new Set<string>()
  // File-wide is deliberately conservative across #if and source ordering.
  // Expanding or forgetting a macro here could invent a literal provider.
  for (const token of nativeTokens(source)) if (token.kind === 'directive') {
    const parts = [...nativeTokens(token.text.replace(/^(?:#|%:)/, ''))]
    if (['define', 'undef'].includes(parts[0]?.text) && parts[1]?.kind === 'word') macros.add(parts[1].text)
  }
  let statement: NativeToken[] = [], braces = 0, parens = 0, brackets = 0
  const parse = (): void => {
    // The contextual module/import keyword must begin a logical line.
    // Otherwise `struct import {}; import value;` is a variable declaration.
    if (!statement[0]?.leading) return
    const exported = statement[0]?.text === 'export', body = exported ? statement.slice(1) : statement
    const keyword = body[0]?.text
    if (keyword !== 'module' && keyword !== 'import') return
    const values = body.slice(1), name = values.map(token => token.text).join(' ').replace(/\s*([.:])\s*/g, '$1'), line = statement[0].line
    const macro = statement.some(token => token.kind === 'word' && macros.has(token.text))
    if (keyword === 'module') {
      if (!macro && namedModule.test(name)) declarations.push({ name, interface: exported, line })
      return // global/private fragments are not named providers
    }
    if (macro) modules.push({ kind: 'cpp_import', spec: name.slice(0, 80) || '…', line, dynamic: true })
    else if (values.length === 1 && values[0].kind === 'string' && /^"[^"\\\r\n]+"$/.test(values[0].text)) {
      modules.push({ kind: 'cpp_header', spec: values[0].text.slice(1, -1), mode: 'quote', line })
    } else if (values[0]?.text === '<' && values.at(-1)?.text === '>') {
      const spec = source.slice(values[0].end, values.at(-1)!.start).replace(/\\\r?\n/g, '')
      if (spec && !/[<>\r\n]/.test(spec)) modules.push({ kind: 'cpp_header', spec, mode: 'system', line })
    } else if (namedModule.test(name) || partition.test(name)) {
      modules.push({ kind: 'cpp_import', spec: name, line })
    } else modules.push({ kind: 'cpp_import', spec: name.slice(0, 80) || '…', line, dynamic: true })
  }
  for (const token of nativeTokens(source)) {
    if (token.kind === 'directive') continue
    if (token.kind !== 'punctuation') { if (!braces) statement.push(token); continue }
    if (token.text === '{') { braces++; statement = []; continue }
    if (token.text === '}') { braces = Math.max(0, braces - 1); statement = []; continue }
    if (braces) continue
    if (token.text === '(') parens++
    if (token.text === ')') parens = Math.max(0, parens - 1)
    if (token.text === '[') brackets++
    if (token.text === ']') brackets = Math.max(0, brackets - 1)
    if (token.text === ';' && !parens && !brackets) { parse(); statement = [] }
    else statement.push(token)
  }
  // Multiple declarations cannot establish a module context for partitions.
  if (declarations.length === 1 && !declarations[0].interface && !declarations[0].name.includes(':')) {
    modules.push({ kind: 'cpp_implementation', spec: declarations[0].name.split(':')[0], line: declarations[0].line })
  }
  return { modules: modules.sort((a, b) => a.line - b.line), ...(declarations.length ? { info: { cppModules: declarations } } : {}) }
}
