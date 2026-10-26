/** Additional file-level collectors. They inspect syntax, never run loaders. */
import type { Node, Tree } from 'web-tree-sitter'
import type { ModuleFact, ModuleLanguage } from './module-facts.ts'
import { javaFacts, javaInfo } from './java-facts.ts'

export interface ModuleInfo {
  package?: string
  classes?: string[]
  inlineModules?: string[][]
  goModule?: string
  cppModules?: Array<{ name: string; interface: boolean; line: number }>
  javaTypes?: string[]
  javaModule?: string
  javaParents?: Array<{ name: string; types: string[] }>
  /** Literal `package.path` search patterns assigned in this Lua file (e.g. `lib/?.lua`). */
  luaPaths?: string[]
}
export const children = (node: Node): Node[] => node.namedChildren.filter((child): child is Node => child !== null)
export const nodes = (node: Node, types: string | string[]): Node[] => node.descendantsOfType(types).filter((child): child is Node => child !== null)

/** Reject interpolation and unfamiliar escapes rather than inventing a path. */
export function staticString(node: Node | null | undefined): string | null {
  if (!node) return null
  const text = node.text
  const long = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(text)
  if (long) return long[2].replace(/^\r?\n/, '')
  if (/^`[^`]*`$/.test(text)) return text.slice(1, -1)
  const match = /^(?:[rRuU])?(["'])([\s\S]*)\1$/.exec(text)
  if (!match || /[\\\r\n]/.test(match[2]) || node.descendantsOfType('interpolation').length) return null
  return match[2]
}

export function extractLanguageFacts(tree: Tree, lang: ModuleLanguage): ModuleFact[] {
  const out: ModuleFact[] = []
  if (lang === 'go') {
    for (const node of nodes(tree.rootNode, 'import_spec')) {
      const spec = staticString(node.childForFieldName('path'))
      if (spec) out.push({ kind: 'go_import', spec, line: node.startPosition.row + 1 })
    }
  } else if (lang === 'java') {
    return javaFacts(tree)
  } else if (lang === 'lua') {
    // A file rebinding require is outside this collector's loader model.
    const loaderTarget = (text: string): boolean => text === 'require' || /^_G\s*(?:\.\s*require|\[\s*["']require["']\s*\])$/.test(text)
    const rebound = nodes(tree.rootNode, ['variable_list', 'parameters']).some(node => children(node).some(child => loaderTarget(child.text)))
      || nodes(tree.rootNode, 'function_declaration').some(node => loaderTarget(node.childForFieldName('name')?.text ?? ''))
      || nodes(tree.rootNode, 'function_call').some(node => node.childForFieldName('name')?.text === 'rawset'
        && children(node.childForFieldName('arguments') ?? node).some(child => child.text === '_G'))
    if (!rebound) for (const node of nodes(tree.rootNode, 'function_call')) {
      if (node.childForFieldName('name')?.text !== 'require') continue
      const args = node.childForFieldName('arguments')
      const values = args ? children(args) : []
      const spec = values.length === 1 ? staticString(values[0]) : null
      out.push({ kind: 'lua_require', spec: spec ?? values[0]?.text.slice(0, 80) ?? '…', line: node.startPosition.row + 1, ...(spec === null ? { dynamic: true } : {}) })
    }
  }
  return out
}

export function extractModuleInfo(tree: Tree, lang: ModuleLanguage): ModuleInfo | undefined {
  const root = tree.rootNode
  if (lang === 'go') {
    const clause = children(root).find(node => node.type === 'package_clause')
    const name = clause && children(clause).find(node => node.type === 'package_identifier')?.text
    return name ? { package: name } : undefined
  }
  if (lang === 'java') {
    return javaInfo(tree)
  }
  if (lang === 'lua') {
    const luaPaths: string[] = []
    for (const node of nodes(root, 'assignment_statement')) {
      const targets = children(children(node).find(child => child.type === 'variable_list') ?? node)
      const values = children(children(node).find(child => child.type === 'expression_list') ?? node)
      targets.forEach((target, index) => {
        if (target.text.replace(/\s+/g, '') === 'package.path' && values[index]) luaPaths.push(...luaPathPatterns(values[index]))
      })
    }
    return luaPaths.length ? { luaPaths } : undefined
  }
  if (lang === 'rust') {
    const inlineModules = nodes(root, 'mod_item').filter(node => node.childForFieldName('body')).map(node => {
      const scope: string[] = []
      for (let parent: Node | null = node; parent; parent = parent.parent) if (parent.type === 'mod_item') {
        const name = parent.childForFieldName('name')
        if (name) scope.unshift(name.text.replace(/^r#/, ''))
      }
      return scope
    })
    return inlineModules.length ? { inlineModules } : undefined
  }
  return undefined
}

const SELF = Symbol('package.path'), DYNAMIC = Symbol('dynamic')

/** `;`-separated segments built only from literals. A segment touching a
 *  non-literal operand (`dir .. '/?.lua'`) is incomplete and dropped; the
 *  `package.path` operand itself is a segment boundary. */
function luaPathPatterns(expression: Node): string[] {
  const operands: Array<string | typeof SELF | typeof DYNAMIC> = []
  const flatten = (node: Node | null): void => {
    if (!node) { operands.push(DYNAMIC); return }
    if (node.type === 'binary_expression' && node.children[1]?.type === '..') {
      flatten(node.childForFieldName('left')); flatten(node.childForFieldName('right')); return
    }
    const literal = node.type === 'string' ? staticString(node) : null
    operands.push(literal ?? (node.text.replace(/\s+/g, '') === 'package.path' ? SELF : DYNAMIC))
  }
  flatten(expression)
  const text = operands.map(item => item === SELF ? ';' : item === DYNAMIC ? '\u0000' : item).join('')
  return text.split(';').filter(segment => segment && !segment.includes('\u0000') && segment.includes('?') && segment.endsWith('.lua'))
}

export function extractPythonDynamic(tree: Tree): ModuleFact[] {
  const loaders = new Map<string, 'module' | 'function'>([['__import__', 'function']])
  for (const node of children(tree.rootNode)) {
    if (node.type === 'import_statement') for (const entry of children(node)) {
      const name = entry.type === 'aliased_import' ? entry.childForFieldName('name') : entry
      if (name?.text === 'importlib') loaders.set(entry.childForFieldName('alias')?.text ?? 'importlib', 'module')
    }
    if (node.type === 'import_from_statement' && node.childForFieldName('module_name')?.text === 'importlib') {
      for (const entry of children(node)) {
        const name = entry.type === 'aliased_import' ? entry.childForFieldName('name') : entry
        if (name?.text === 'import_module') loaders.set(entry.childForFieldName('alias')?.text ?? 'import_module', 'function')
      }
    }
  }
  for (const node of nodes(tree.rootNode, ['import_statement', 'import_from_statement'])) {
    const module = node.childForFieldName('module_name')?.text
    for (const entry of children(node)) {
      const original = entry.type === 'aliased_import' ? entry.childForFieldName('name')?.text : entry.text
      const binding = entry.childForFieldName('alias')?.text ?? original?.split('.')[0]
      const supported = node.parent?.type === 'module' && (node.type === 'import_statement' && original === 'importlib'
        || node.type === 'import_from_statement' && module === 'importlib' && original === 'import_module')
      if (binding && !supported && entry.id !== node.childForFieldName('module_name')?.id) loaders.delete(binding)
    }
  }
  // Any local binding of a loader name makes it ambiguous. Deliberately
  // conservative across scopes; missing a call is preferable to a false edge.
  for (const node of nodes(tree.rootNode, ['assignment', 'augmented_assignment', 'named_expression', 'function_definition', 'class_definition', 'parameters', 'lambda_parameters', 'for_statement', 'for_in_clause', 'as_pattern_target', 'delete_statement'])) {
    const target = node.childForFieldName('left') ?? node.childForFieldName('name')
      ?? (['parameters', 'lambda_parameters', 'as_pattern_target', 'delete_statement'].includes(node.type) ? node : null)
    if (target) for (const name of loaders.keys()) if (new RegExp(`\\b${name}\\b`).test(target.text)) loaders.delete(name)
  }
  const out: ModuleFact[] = []
  for (const node of nodes(tree.rootNode, 'call')) {
    const callee = node.childForFieldName('function')
    const object = callee?.childForFieldName('object')?.text
    const recognized = callee?.type === 'identifier' && loaders.get(callee.text) === 'function'
      || callee?.type === 'attribute' && object && loaders.get(object) === 'module' && callee.childForFieldName('attribute')?.text === 'import_module'
    if (!recognized) continue
    const args = node.childForFieldName('arguments')
    const values = args ? children(args) : []
    const builtin = callee?.text === '__import__'
    const spec = values.length >= 1 && values.length <= (builtin ? 1 : 2) ? staticString(values[0]) : null
    const pkg = values.length === 2 ? staticString(values[1]) : null
    const supported = spec !== null && /^\.*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(spec)
      && (!spec.startsWith('.') || pkg !== null && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(pkg))
    out.push({ kind: 'python_dynamic', spec: spec ?? values[0]?.text.slice(0, 80) ?? '…', line: node.startPosition.row + 1,
      ...(pkg ? { package: pkg } : {}), ...(!supported ? { dynamic: true } : {}) })
  }
  return out
}
