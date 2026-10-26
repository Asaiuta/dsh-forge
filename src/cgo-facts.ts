/** Only the comment group immediately attached to a standalone import "C". */
import type { Node, Tree } from 'web-tree-sitter'
import type { ModuleFact } from './module-facts.ts'
import { children, staticString } from './language-facts.ts'
import { nativeInclude, nativeTokens } from './native-syntax.ts'

export function cgoIncludes(tree: Tree): ModuleFact[] {
  const siblings = children(tree.rootNode), modules: ModuleFact[] = [], source = tree.rootNode.text
  for (let n = 0; n < siblings.length; n++) {
    const declaration = siblings[n]
    if (declaration.type !== 'import_declaration') continue
    const imports = children(declaration)
    if (imports.length !== 1 || imports[0].type !== 'import_spec' || imports[0].childForFieldName('name')
      || staticString(imports[0].childForFieldName('path')) !== 'C') continue
    const comments: Node[] = []
    let next = declaration
    for (let i = n - 1; i >= 0; i--) {
      const comment = siblings[i]
      if (comment.type !== 'comment' || comment.endPosition.row + 1 !== next.startPosition.row) break
      const lineStart = source.lastIndexOf('\n', comment.startIndex - 1) + 1
      // Go attaches a trailing comment to the preceding code, not import.Doc.
      if (source.slice(lineStart, comment.startIndex).trim()) break
      comments.unshift(comment); next = comment
    }
    if (!comments.length) continue
    // Preserve newlines and columns after removing Go comment delimiters.
    const preamble = comments.map(comment => comment.text.startsWith('//') ? comment.text.slice(2)
      : comment.text.slice(2, -2)).join('\n')
    for (const token of nativeTokens(preamble)) {
      const include = nativeInclude(token)
      if (include) modules.push({ kind: 'cgo_include', ...include, line: comments[0].startPosition.row + token.line })
    }
  }
  return modules
}
