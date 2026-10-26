/** Static module/file dependencies for the non-JavaScript Trace languages. */
import type { Node, Tree } from 'web-tree-sitter'
import type { LangName } from './ast.ts'
import { extractLanguageFacts, extractPythonDynamic, children } from './language-facts.ts'

interface ModuleRef { spec: string; line: number }
export type ModuleFact = ModuleRef & (
  | { kind: 'python_import' }
  | { kind: 'python_from'; names: string[] }
  | { kind: 'python_dynamic'; package?: string; dynamic?: true }
  | { kind: 'c_include'; mode: 'quote' | 'system' | 'dynamic' }
  | { kind: 'cgo_include'; mode: 'quote' | 'system' | 'dynamic' }
  | { kind: 'cpp_header'; mode: 'quote' | 'system' }
  | { kind: 'cpp_import'; dynamic?: true }
  | { kind: 'cpp_implementation' }
  | { kind: 'rust_mod'; scope: string[]; path?: string; dynamic?: true }
  | { kind: 'rust_include'; dynamic?: true }
  | { kind: 'rust_use'; scope: string[]; dynamic?: true }
  | { kind: 'go_import' }
  | { kind: 'java_import'; static: boolean; wildcard: boolean }
  | { kind: 'java_type'; role: string; scope: string[] }
  | { kind: 'java_requires' }
  | { kind: 'java_package'; role: 'exports' | 'opens' }
  | { kind: 'lua_require'; dynamic?: true }
)
export type ModuleLanguage = 'python' | 'rust' | 'c' | 'cpp' | 'go' | 'java' | 'lua'
export function supportsModuleFacts(lang: LangName): lang is ModuleLanguage {
  return lang === 'python' || lang === 'rust' || lang === 'c' || lang === 'cpp' || lang === 'go' || lang === 'java' || lang === 'lua'
}

const named = (node: Node): Node[] => node.namedChildren.filter((child): child is Node => child !== null)
const pythonName = (node: Node): string => node.text.replace(/\\\n|\s+/g, '')
const unalias = (node: Node): Node => node.type === 'aliased_import' ? node.childForFieldName('name') ?? node : node

/** Decode a Rust string without executing source or interpreting macro tokens. */
function rustString(node: Node | undefined): string | null {
  if (!node) return null
  if (node.type === 'raw_string_literal') {
    const match = /^r(#+)?"([\s\S]*)"\1$/.exec(node.text)
    return match?.[2] ?? null
  }
  if (node.type !== 'string_literal') return null
  const source = node.text
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', "'": "'", '"': '"', '\\': '\\' }
  let out = ''
  for (let i = 1; i < source.length - 1; i++) {
    if (source[i] !== '\\') { out += source[i]; continue }
    const escape = source[++i]
    if (escape === '\n') {
      while (/[\t\n\r ]/.test(source[i + 1] ?? '')) i++
    } else if (escape === 'x') {
      const hex = source.slice(i + 1, i + 3)
      if (!/^[0-7][0-9a-f]$/i.test(hex)) return null
      out += String.fromCharCode(parseInt(hex, 16))
      i += 2
    } else if (escape === 'u') {
      const match = /^\{([0-9a-f][0-9a-f_]*)\}/i.exec(source.slice(i + 1))
      const hex = match?.[1].replaceAll('_', '')
      if (!match || !hex || hex.length > 6) return null
      const point = parseInt(hex, 16)
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null
      out += String.fromCodePoint(point)
      i += match[0].length
    } else {
      if (!Object.hasOwn(escapes, escape)) return null
      out += escapes[escape]
    }
  }
  return out
}

type RustPath = { path?: string; dynamic?: true }
interface RustAttributes {
  parents: Map<number, { nodes: Node[]; indexes: Map<number, number> }>
  paths: Map<number, RustPath>
}

/** Outer attributes belong to the following item. Cache each parent's sibling
 *  list once; rereading a wide declaration list per module would be quadratic. */
function rustPath(node: Node, cache: RustAttributes): RustPath {
  const cached = cache.paths.get(node.id)
  if (cached) return cached
  const parent = node.parent
  let group = parent ? cache.parents.get(parent.id) : undefined
  if (parent && !group) {
    const nodes = named(parent)
    group = { nodes, indexes: new Map(nodes.map((sibling, index) => [sibling.id, index])) }
    cache.parents.set(parent.id, group)
  }
  const siblings = group?.nodes ?? []
  const index = group?.indexes.get(node.id) ?? 0
  const result: RustPath = {}
  for (let i = index - 1; i >= 0; i--) {
    const sibling = siblings[i]
    if (sibling.type === 'line_comment' || sibling.type === 'block_comment') continue
    if (sibling.type !== 'attribute_item') break
    const attribute = named(sibling).find(child => child.type === 'attribute')
    if (!attribute) continue
    const children = named(attribute)
    if (children[0]?.text === 'path') {
      const value = rustString(children.find(child => child.type === 'string_literal' || child.type === 'raw_string_literal'))
      if (value === null || result.path !== undefined) result.dynamic = true
      else result.path = value
    }
    // Conditional attributes can replace the module path. Keep them unresolved.
    if (children[0]?.text === 'cfg_attr') result.dynamic = true
  }
  cache.paths.set(node.id, result)
  return result
}

export function extractModuleFacts(tree: Tree, lang: ModuleLanguage): ModuleFact[] {
  if (lang === 'go' || lang === 'java' || lang === 'lua') return extractLanguageFacts(tree, lang)
  const out: ModuleFact[] = []
  const attributes: RustAttributes = { parents: new Map(), paths: new Map() }
  const types = lang === 'python' ? ['import_statement', 'import_from_statement']
    : lang === 'rust' ? ['mod_item', 'macro_invocation', 'use_declaration'] : ['preproc_include']
  for (const node of tree.rootNode.descendantsOfType(types)) {
    if (!node) continue
    const line = node.startPosition.row + 1
    if (lang === 'python') {
      if (node.type === 'import_statement') {
        for (const child of named(node)) {
          const name = unalias(child)
          if (name.type === 'dotted_name') out.push({ kind: 'python_import', spec: pythonName(name), line })
        }
      } else {
        const module = node.childForFieldName('module_name')
        if (!module) continue
        const names = named(node).filter(child => child.id !== module.id).map(unalias)
          .filter(child => child.type === 'dotted_name').map(pythonName)
        out.push({ kind: 'python_from', spec: pythonName(module), names, line })
      }
    } else if (lang === 'rust') {
      if (node.type === 'use_declaration') {
        const scope: string[] = []
        for (let parent = node.parent; parent; parent = parent.parent) if (parent.type === 'mod_item') {
          const name = parent.childForFieldName('name')
          if (name) scope.unshift(name.text.replace(/^r#/, ''))
        }
        const visit = (part: Node, prefix: string): void => {
          if (part.type === 'scoped_use_list') {
            const owner = part.childForFieldName('path')
            const next = prefix + (owner ? owner.text.replaceAll(/\s/g, '') + '::' : '')
            const list = part.childForFieldName('list')
            if (list) for (const child of children(list)) visit(child, next)
          } else if (part.type === 'use_list') for (const child of children(part)) visit(child, prefix)
          else if (part.type === 'use_as_clause') { const target = part.childForFieldName('path'); if (target) visit(target, prefix) }
          else out.push({ kind: 'rust_use', spec: (prefix + part.text).replaceAll(/\s/g, '').replace(/::$/, ''), line, scope })
        }
        const argument = node.childForFieldName('argument')
        if (argument) visit(argument, '')
      } else if (node.type === 'mod_item') {
        if (node.childForFieldName('body')) continue // inline modules have no file of their own
        const name = node.childForFieldName('name')
        if (!name) continue
        const scope: string[] = []
        let unsupportedScope = false
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.type !== 'mod_item') continue
          const owner = parent.childForFieldName('name')
          if (owner) scope.unshift(owner.text.replace(/^r#/, ''))
          const attribute = rustPath(parent, attributes)
          unsupportedScope ||= attribute.path !== undefined || attribute.dynamic === true
        }
        out.push({ kind: 'rust_mod', spec: name.text.replace(/^r#/, ''), line, scope, ...rustPath(node, attributes), ...(unsupportedScope ? { dynamic: true } : {}) })
      } else {
        const children = named(node)
        if (!/^(?:(?:::)?(?:std|core)::)?(?:include|include_str|include_bytes)$/.test(children[0]?.text ?? '')) continue
        const tokens = children.find(child => child.type === 'token_tree')
        const args = tokens ? named(tokens) : []
        const spec = args.length === 1 ? rustString(args[0]) : null
        out.push({ kind: 'rust_include', spec: spec ?? tokens?.text.slice(0, 80) ?? '…', line, ...(spec === null ? { dynamic: true } : {}) })
      }
    } else {
      const include = node.childForFieldName('path')
      if (!include) continue
      const mode = include.type === 'string_literal' ? 'quote' : include.type === 'system_lib_string' ? 'system' : 'dynamic'
      out.push({ kind: 'c_include', spec: mode === 'dynamic' ? include.text.slice(0, 80) : include.text.slice(1, -1), line, mode })
    }
  }
  return lang === 'python' ? [...out, ...extractPythonDynamic(tree)].sort((a, b) => a.line - b.line) : out
}
