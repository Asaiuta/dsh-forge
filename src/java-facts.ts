/** Java type syntax and module descriptors, without a compiler/classpath. */
import type { Node, Tree } from 'web-tree-sitter'
import type { ModuleFact } from './module-facts.ts'
import type { ModuleInfo } from './language-facts.ts'
import { children, nodes } from './language-facts.ts'

const declarations = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration'])
const typeNodes = new Set(['type_identifier', 'scoped_type_identifier', 'generic_type'])
const cleanName = (name: string): string => name.replaceAll(/\s/g, '')

function typeName(node: Node): string | null {
  if (node.type === 'type_identifier') return node.text
  if (node.type === 'generic_type') {
    const base = children(node).find(child => typeNodes.has(child.type))
    return base ? typeName(base) : null
  }
  if (node.type === 'scoped_type_identifier') {
    const parts = children(node).filter(child => typeNodes.has(child.type)).map(typeName)
    return parts.length && parts.every(Boolean) ? parts.join('.') : null
  }
  return null
}

function classScope(node: Node): string[] {
  const scope: string[] = []
  for (let parent = node.parent; parent; parent = parent.parent) if (declarations.has(parent.type)) {
    const name = parent.childForFieldName('name')?.text
    if (name) scope.unshift(name)
  }
  return scope
}

/** Names of local classes cannot be imported from another file. Exclude those
 * names conservatively throughout their file rather than approximate blocks. */
function localClasses(root: Node): Set<string> {
  return new Set(nodes(root, [...declarations]).filter(node => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (['block', 'constructor_body', 'lambda_expression', 'object_creation_expression', 'enum_constant'].includes(parent.type)) return true
    }
    return false
  }).map(node => node.childForFieldName('name')?.text).filter((name): name is string => Boolean(name)))
}

function shadowed(node: Node, name: string, locals: Set<string>, cache: Map<number, Set<string>>): boolean {
  if (locals.has(name)) return true
  for (let parent: Node | null = node; parent; parent = parent.parent) {
    let names = cache.get(parent.id)
    if (!names) {
      const parameters = parent.childForFieldName('type_parameters') ?? children(parent).find(child => child.type === 'type_parameters')
      names = new Set(parameters ? children(parameters).map(parameter => children(parameter).find(child => child.type === 'type_identifier')?.text).filter((value): value is string => Boolean(value)) : [])
      cache.set(parent.id, names)
    }
    if (names.has(name)) return true
  }
  return false
}

function typeRole(node: Node): string | null {
  for (let parent: Node | null = node; parent; parent = parent.parent) {
    if (parent.type === 'type_bound') return 'bound'
    if (parent.type === 'superclass' || parent.type === 'extends_interfaces') return 'extends'
    if (parent.type === 'super_interfaces') return 'implements'
    if (parent.type === 'field_declaration' || parent.type === 'constant_declaration') return 'field'
    if (parent.type === 'formal_parameter' || parent.type === 'spread_parameter' || parent.type === 'receiver_parameter') return 'parameter'
    if (parent.type === 'throws') return 'throws'
    if (parent.type === 'object_creation_expression') return 'construction'
    if (parent.type === 'local_variable_declaration' || parent.type === 'cast_expression' || parent.type === 'instanceof_expression' || parent.type === 'array_creation_expression') return 'type'
    if (parent.type === 'method_declaration' || parent.type === 'annotation_type_element_declaration') return 'return'
    if (parent.type === 'block') return null
  }
  return null
}

function anonymousBody(node: Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'class_body' && ['object_creation_expression', 'enum_constant'].includes(parent.parent?.type ?? '')) return true
  }
  return false
}

export function javaFacts(tree: Tree): ModuleFact[] {
  const root = tree.rootNode, out: ModuleFact[] = [], locals = localClasses(root)
  const parameters = new Map<number, Set<string>>()
  for (const node of nodes(root, 'import_declaration')) {
    const name = children(node).find(child => child.type === 'scoped_identifier' || child.type === 'identifier')
    if (name) out.push({ kind: 'java_import', spec: cleanName(name.text), line: node.startPosition.row + 1,
      static: node.children.some(child => child.type === 'static'), wildcard: children(node).some(child => child.type === 'asterisk') })
  }
  const seen = new Set<string>()
  for (const atom of nodes(root, 'type_identifier')) {
    // A scoped/generic name is a single reference; generic arguments remain
    // separate references. Never interpret each package component as a type.
    let node = atom
    while (node.parent && (node.parent.type === 'scoped_type_identifier'
      || node.parent.type === 'generic_type' && children(node.parent).find(child => typeNodes.has(child.type))?.id === node.id)) node = node.parent
    if (seen.has(String(node.id))) continue
    seen.add(String(node.id))
    // Anonymous scopes can inherit member types but have no stable source
    // FQN in this index. Keep body references out of the enclosing class.
    // The new Base(...) type before the body remains a construction fact.
    if (anonymousBody(node)) continue
    if (node.parent?.type === 'type_parameter' && children(node.parent)[0]?.id === node.id) continue
    const spec = typeName(node), role = typeRole(node)
    if (!spec || !role || shadowed(node, spec.split('.')[0], locals, parameters)) continue
    out.push({ kind: 'java_type', spec, role, scope: classScope(node), line: node.startPosition.row + 1 })
  }
  for (const directive of nodes(root, ['requires_module_directive', 'exports_module_directive', 'opens_module_directive', 'uses_module_directive', 'provides_module_directive'])) {
    const names = children(directive).filter(node => node.type === 'identifier' || node.type === 'scoped_identifier')
    if (!names.length) continue
    const line = directive.startPosition.row + 1
    if (directive.type === 'requires_module_directive') {
      out.push({ kind: 'java_requires', spec: cleanName(names[0].text), line })
    } else if (directive.type === 'exports_module_directive' || directive.type === 'opens_module_directive') {
      out.push({ kind: 'java_package', spec: cleanName(names[0].text), role: directive.type === 'exports_module_directive' ? 'exports' : 'opens', line })
    } else for (const name of names) out.push({ kind: 'java_type', spec: cleanName(name.text), role: directive.type === 'uses_module_directive' ? 'uses' : 'provides', scope: [], line })
  }
  return out.sort((a, b) => a.line - b.line)
}

export function javaInfo(tree: Tree): ModuleInfo {
  const root = tree.rootNode, declaration = children(root).find(node => node.type === 'package_declaration')
  const pkg = declaration && children(declaration).find(node => ['scoped_identifier', 'identifier'].includes(node.type))?.text
  const classes = children(root).filter(node => declarations.has(node.type)).map(node => node.childForFieldName('name')?.text).filter((name): name is string => Boolean(name))
  const stable = nodes(root, [...declarations]).filter(node => {
    for (let parent = node.parent; parent; parent = parent.parent) if (['block', 'constructor_body', 'lambda_expression', 'object_creation_expression'].includes(parent.type)) return false
    // Only top-level and directly nested member declarations have stable FQNs.
    let parent = node.parent
    while (parent && ['class_body', 'interface_body', 'enum_body', 'enum_body_declarations'].includes(parent.type)) parent = parent.parent
    return parent?.type === 'program' || Boolean(parent && declarations.has(parent.type))
  })
  const declaredName = (node: Node): string => [...classScope(node), node.childForFieldName('name')?.text].filter(Boolean).join('.')
  const types = stable.map(declaredName)
  const javaParents = stable.map(node => {
    const containers = children(node).filter(child => ['superclass', 'super_interfaces', 'extends_interfaces'].includes(child.type))
    const names = containers.flatMap(container => children(container).flatMap(child => child.type === 'type_list' ? children(child) : [child]))
      .map(typeName).filter((name): name is string => Boolean(name))
    return { name: declaredName(node), types: names }
  }).filter(item => item.types.length)
  const module = children(root).find(node => node.type === 'module_declaration')
  const moduleName = module && children(module).find(node => ['identifier', 'scoped_identifier'].includes(node.type))?.text
  return { package: pkg ? cleanName(pkg) : '', classes, javaTypes: types, ...(javaParents.length ? { javaParents } : {}),
    ...(moduleName ? { javaModule: cleanName(moduleName) } : {}) }
}
