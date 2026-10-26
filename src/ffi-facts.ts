/** Source declarations of native boundaries; these do not prove a binary export. */
import type { Node, Tree } from 'web-tree-sitter'
import type { LangName } from './ast.ts'
import { children, nodes, staticString } from './language-facts.ts'

export interface FfiFact {
  name: string
  symbol: string
  line: number
  lang: string
  kind: 'source-export' | 'foreign-declaration' | 'c-linkage-definition' | 'c-linkage-declaration' | 'module-registration'
  abi?: string
}

function attributes(node: Node): string[] {
  const siblings = node.parent ? children(node.parent) : [], result: string[] = []
  for (let n = siblings.findIndex(item => item.id === node.id) - 1; n >= 0; n--) {
    const previous = siblings[n]
    if (previous.type === 'attribute_item') result.push(previous.text)
    else if (!['line_comment', 'block_comment', 'comment'].includes(previous.type)) break
  }
  return result
}

export function extractFfiFacts(tree: Tree, lang: LangName): FfiFact[] {
  const out: FfiFact[] = []
  const emit = (node: Node, symbol: string, name: string, kind: FfiFact['kind'], abi?: string): void => {
    if (name && !out.some(item => item.name === name && item.line === node.startPosition.row + 1 && item.kind === kind)) {
      out.push({ name, symbol, line: node.startPosition.row + 1, lang, kind, ...(abi ? { abi } : {}) })
    }
  }
  if (lang === 'rust') {
    for (const node of nodes(tree.rootNode, ['function_item', 'function_signature_item', 'static_item'])) {
      const symbol = node.childForFieldName('name')?.text.replace(/^r#/, '')
      if (!symbol) continue
      const attrs = attributes(node)
      const exported = attrs.some(text => /^#\[\s*(?:unsafe\(\s*)?no_mangle\s*\)?\s*\]$/.test(text))
      const rename = attrs.map(text => /^#\[\s*(?:unsafe\(\s*)?(export_name|link_name)\s*=\s*"([^"\\\r\n]+)"\s*\)?\s*\]$/.exec(text)).find(Boolean)
      const modifiers = children(node).find(child => child.type === 'function_modifiers')
      let abi = modifiers && nodes(modifiers, 'extern_modifier').map(child => staticString(children(child).find(item => item.type === 'string_literal')))[0]
      let foreign = false
      for (let parent = node.parent; parent; parent = parent.parent) if (parent.type === 'foreign_mod_item') {
        foreign = true
        abi = staticString(children(parent).find(child => child.type === 'extern_modifier')?.namedChildren.find(child => child?.type === 'string_literal')) ?? 'C'
      }
      if (exported || rename?.[1] === 'export_name') emit(node, symbol, rename?.[2] ?? symbol, 'source-export', abi ?? undefined)
      else if (foreign) emit(node, symbol, rename?.[2] ?? symbol, 'foreign-declaration', abi ?? 'C')
      else if (abi === 'C' || abi === 'system') emit(node, symbol, symbol, 'c-linkage-definition', abi)
    }
  } else if (lang === 'c' || lang === 'cpp') {
    for (const node of nodes(tree.rootNode, ['function_definition', 'declaration'])) {
      for (const declarator of node.childrenForFieldName('declarator')) {
        if (!declarator) continue
        const functionNode = declarator.type === 'function_declarator' ? declarator : nodes(declarator, 'function_declarator')[0]
        if (!functionNode) continue
        let name = functionNode.childForFieldName('declarator')
        while (name?.childForFieldName('declarator')) name = name.childForFieldName('declarator')
        if (!name || !['identifier', 'qualified_identifier'].includes(name.type)) continue
        let cLinkage = false
        for (let parent = node.parent; parent; parent = parent.parent) if (parent.type === 'linkage_specification') {
          cLinkage = staticString(parent.childForFieldName('value')) === 'C'
          break // The innermost language linkage overrides an outer block.
        }
        const dllexport = children(node).some(child => child.type === 'ms_declspec_modifier' && children(child).some(item => item.text === 'dllexport'))
        if (dllexport) emit(node, name.text, name.text, 'source-export', cLinkage ? 'C' : undefined)
        else if (cLinkage) emit(node, name.text, name.text, node.type === 'function_definition' ? 'c-linkage-definition' : 'c-linkage-declaration', 'C')
      }
    }
    for (const node of nodes(tree.rootNode, 'call_expression')) {
      if (!['NODE_API_MODULE', 'NAPI_MODULE', 'NAPI_MODULE_X', 'NODE_MODULE', 'NODE_MODULE_CONTEXT_AWARE', 'NODE_MODULE_LINKED'].includes(node.childForFieldName('function')?.text ?? '')) continue
      let definition = false
      for (let parent = node.parent; parent; parent = parent.parent) if (parent.type === 'preproc_def' || parent.type === 'preproc_function_def') definition = true
      if (definition) continue
      const args = node.childForFieldName('arguments'), name = args && children(args)[0]
      const api = node.childForFieldName('function')?.text.startsWith('NODE_MODULE') ? 'Node' : 'N-API'
      if (name?.type === 'identifier') emit(node, name.text, name.text, 'module-registration', api)
    }
  } else if (lang === 'go') {
    const cgo = nodes(tree.rootNode, 'import_spec').some(node => staticString(node.childForFieldName('path')) === 'C')
    if (cgo) for (const node of nodes(tree.rootNode, 'function_declaration')) {
      const name = node.childForFieldName('name')?.text
      const siblings = node.parent ? children(node.parent) : []
      const previous = siblings[siblings.findIndex(child => child.id === node.id) - 1]
      if (name && previous?.type === 'comment' && previous.text === `//export ${name}`
        && previous.endPosition.row + 1 === node.startPosition.row) emit(node, name, name, 'source-export', 'cgo')
    }
  }
  return out
}
