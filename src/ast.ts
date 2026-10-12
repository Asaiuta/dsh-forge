/**
 * dsh-forge AST layer: tree-sitter symbol extraction with content-anchored
 * caching. Clean-room implementation over MIT-licensed web-tree-sitter and
 * the prebuilt grammars in tree-sitter-wasms — no ProjectForge code.
 *
 * Design principles adopted from the forge plan (documented in README):
 * 1. Ranges are anchored to content, not to an index. Every query re-reads
 *    the file, normalizes EOL, hashes it (sha256), and only reuses a cached
 *    parse on hash match. A stale cache can never produce a wrong range.
 * 2. Only certain facts: definitions + exact ranges. No reference/call-graph
 *    guessing; symbol addressing is exact by construction.
 * 3. Line contract: 1-based, on BOM-stripped, CRLF/CR→LF-normalized text —
 *    the same contract as the rest of dsh-forge.
 * 4. Always degradable: unsupported extensions and missing grammars return
 *    structured errors that point back to ffgrep; nothing throws.
 *
 * @module dsh-forge/ast
 */

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readBoundedFile } from './fs-paths.ts'
import path from 'node:path'
import { extractFacts } from './facts.ts'

type TreeSitterModule = typeof import('web-tree-sitter')

/** Languages v2 covers — the blueprint's P0 set plus Go. */
export type LangName = 'javascript' | 'typescript' | 'tsx' | 'python' | 'rust' | 'go' | 'c' | 'cpp' | 'java' | 'c_sharp' | 'lua'

const EXT_LANG: Record<string, LangName> = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python', '.pyi': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c',
  '.h': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.cppm': 'cpp', '.ixx': 'cpp',
  '.java': 'java', '.cs': 'c_sharp', '.lua': 'lua',
}

export function detectLanguage(absPath: string): LangName | null {
  return EXT_LANG[path.extname(absPath).toLowerCase()] ?? null
}

// ---------------------------------------------------------------------------
// Loader (lazy, one parser per language, concurrency-safe)
// ---------------------------------------------------------------------------

let tsModule: TreeSitterModule | null = null
let initPromise: Promise<TreeSitterModule> | null = null
const parsers = new Map<LangName, Promise<import('web-tree-sitter').Parser>>()

function grammarDir(): string {
  const override = process.env.DSH_FORGE_GRAMMAR_DIR
  if (override && override.trim() !== '') return path.resolve(override)
  // Locate the prebuilt grammar package relative to this module — works from
  // both the dev tree and the profile junction (real-path module resolution).
  try {
    const req = createRequire(import.meta.url)
    const pkgJson = req.resolve('tree-sitter-wasms/package.json')
    return path.join(path.dirname(pkgJson), 'out')
  } catch {
    return path.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out')
  }
}

async function getTsModule(): Promise<TreeSitterModule> {
  if (tsModule) return tsModule
  if (!initPromise) {
    initPromise = (async () => {
      const mod = (await import('web-tree-sitter')) as unknown as TreeSitterModule
      await mod.Parser.init()
      tsModule = mod
      return mod
    })()
  }
  return initPromise
}

async function getParser(lang: LangName): Promise<import('web-tree-sitter').Parser> {
  let pending = parsers.get(lang)
  if (!pending) {
    pending = (async () => {
      const mod = await getTsModule()
      const wasm = path.join(grammarDir(), `tree-sitter-${lang}.wasm`)
      if (!existsSync(wasm)) {
        throw new Error(`grammar not found: ${wasm} — set DSH_FORGE_GRAMMAR_DIR or reinstall tree-sitter-wasms`)
      }
      const language = await mod.Language.load(readFileSync(wasm))
      const parser = new mod.Parser()
      parser.setLanguage(language)
      return parser
    })()
    // Never cache a rejected promise: a transient failure should be retryable.
    pending.catch(() => parsers.delete(lang))
    parsers.set(lang, pending)
  }
  return pending
}

/** Test/diagnostic hook: is the grammar for this language loadable? */
export async function grammarAvailable(lang: LangName): Promise<boolean> {
  try {
    await getParser(lang)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Normalization (the line contract)
// ---------------------------------------------------------------------------

export function normalizeText(raw: string): string {
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return noBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

export type SymbolKind =
  | 'class' | 'function' | 'method' | 'interface' | 'struct'
  | 'enum' | 'type' | 'trait' | 'module'
  | 'field' | 'variable' | 'object' | 'impl'

export interface AstSymbol {
  /** The source declaration also owns other names; unsafe for isolated mutation. */
  sharedDeclaration?: boolean
  /** Removing a list member also requires language-specific separator handling. */
  listMember?: boolean
  /** Half-open UTF-16 offsets into the normalized parsed text. */
  startOffset: number
  endOffset: number
  /** Simple name (e.g. putBlob). */
  name: string
  /** Dotted qualified name (Store.putBlob) or Rust's Type::method. */
  qualifiedName: string
  kind: SymbolKind
  /** 1-based, inclusive, on normalized text. */
  startLine: number
  endLine: number
  /** First line of an adjacent preceding comment block, when present. */
  commentStartLine?: number
  commentStartOffset?: number
  children: AstSymbol[]
}

interface FamilySpec {
  /** Declaration node types mapped to symbol kinds. */
  declarations: Record<string, SymbolKind>
  /** Node types whose children should be searched transparently (wrappers). */
  wrappers: string[]
  /** Node types forming a qualification prefix (class-like containers). */
  qualifiers: string[]
  /** Comment node types for adjacent-comment capture. */
  comments: string[]
  /** Field name holding the declaration name (default 'name'). */
  nameField?: string
}

const C_LIKE: FamilySpec = {
  declarations: {
    class_declaration: 'class', class: 'class', abstract_class_declaration: 'class',
    function_declaration: 'function', generator_function_declaration: 'function',
    method_definition: 'method',
    interface_declaration: 'interface', enum_declaration: 'enum',
    type_alias_declaration: 'type', abstract_class: 'class',
    method_signature: 'method', property_signature: 'field', public_field_definition: 'field', field_definition: 'field',
  },
  wrappers: ['export_statement', 'export_clause', 'decorated_definition', 'ambient_declaration', 'declaration'],
  qualifiers: ['class_declaration', 'class', 'abstract_class_declaration'],
  comments: ['comment'],
}

const PY: FamilySpec = {
  declarations: { function_definition: 'function', class_definition: 'class' },
  wrappers: ['decorated_definition', 'block'],
  qualifiers: ['class_definition'],
  comments: ['comment'],
}

const RS: FamilySpec = {
  declarations: {
    function_item: 'function', struct_item: 'struct', enum_item: 'enum',
    trait_item: 'trait', type_item: 'type', mod_item: 'module', foreign_mod_item: 'module',
    const_item: 'variable', static_item: 'variable', field_declaration: 'field', enum_variant: 'field',
  },
  wrappers: ['declaration_list', 'declaration', 'mod_contents'],
  qualifiers: ['impl_item', 'trait_item'],
  comments: ['line_comment', 'block_comment'],
}

const GO: FamilySpec = {
  declarations: { function_declaration: 'function', method_declaration: 'method', field_declaration: 'field', method_spec: 'method', var_spec: 'variable', const_spec: 'variable' },
  wrappers: [],
  qualifiers: [],
  comments: ['comment'],
  nameField: 'name',
}

const NATIVE_C: FamilySpec = {
  declarations: { function_definition: 'function', struct_specifier: 'struct', union_specifier: 'struct', enum_specifier: 'enum',
    class_specifier: 'class', namespace_definition: 'module', alias_declaration: 'type', enumerator: 'field' },
  wrappers: ['template_declaration', 'linkage_specification', 'declaration_list'], qualifiers: [], comments: ['comment'],
}
const JAVA: FamilySpec = {
  declarations: { class_declaration: 'class', interface_declaration: 'interface', enum_declaration: 'enum', record_declaration: 'struct',
    method_declaration: 'method', constructor_declaration: 'method', enum_constant: 'field', annotation_type_declaration: 'interface' },
  wrappers: [], qualifiers: [], comments: ['line_comment', 'block_comment'],
}
const CSHARP: FamilySpec = {
  declarations: { namespace_declaration: 'module', file_scoped_namespace_declaration: 'module', class_declaration: 'class',
    struct_declaration: 'struct', record_declaration: 'struct', interface_declaration: 'interface', enum_declaration: 'enum',
    method_declaration: 'method', constructor_declaration: 'method', property_declaration: 'field', enum_member_declaration: 'field', delegate_declaration: 'type' },
  wrappers: [], qualifiers: [], comments: ['comment'],
}
const LUA: FamilySpec = {
  declarations: { function_definition_statement: 'function', local_function_definition_statement: 'function' },
  wrappers: [], qualifiers: [], comments: ['comment'],
}

function familyFor(lang: LangName): FamilySpec {
  if (lang === 'python') return PY
  if (lang === 'rust') return RS
  if (lang === 'go') return GO
  if (lang === 'c' || lang === 'cpp') return NATIVE_C
  if (lang === 'java') return JAVA
  if (lang === 'c_sharp') return CSHARP
  if (lang === 'lua') return LUA
  return C_LIKE
}

function nameOf(node: import('web-tree-sitter').Node, spec: FamilySpec): string | null {
  const field = node.childForFieldName(spec.nameField ?? 'name')
  return field ? field.text : null
}

/** Walk the sibling run of comments immediately above `node` (no blank gaps).
 *  Climbs through wrapper nodes (export_statement etc.) whose own sibling run
 *  is where the comment actually lives. */
function commentStartRow(
  parent: import('web-tree-sitter').Node | null,
  node: import('web-tree-sitter').Node,
  spec: FamilySpec,
): { line: number; offset: number } | null {
  let cursor = node
  let cursorParent = parent
  for (let climb = 0; climb < 3 && cursorParent; climb++) {
    const siblings = cursorParent.children
    // Node wrappers are not reference-stable in web-tree-sitter (accessing
    // .parent yields a fresh object) — identity must go by node id.
    const idx = siblings.findIndex((s) => s.id === cursor.id)
    if (idx > 0) {
      let first: import('web-tree-sitter').Node | null = null
      let nextRow = cursor.startPosition.row
      for (let i = idx - 1; i >= 0; i--) {
        const prev = siblings[i]
        if (prev.endPosition.row < nextRow - 1) break
        if (spec.comments.includes(prev.type)) {
          first = prev
          nextRow = prev.startPosition.row
        } else if (prev.type === 'decorator' || prev.type === 'attribute_item' || prev.type === 'decorator_definition') {
          // decorators sit between comment and definition; keep scanning upward
          nextRow = prev.startPosition.row
          continue
        } else {
          break
        }
      }
      if (first) return { line: first.startPosition.row + 1, offset: first.startIndex }
    }
    // No comment among these siblings: climb if the parent is a wrapper.
    if (!spec.wrappers.includes(cursorParent.type)) break
    cursor = cursorParent
    cursorParent = cursorParent.parent
  }
  return null
}

function goReceiverName(node: import('web-tree-sitter').Node): string | null {
  const receiver = node.childForFieldName('receiver')
  if (!receiver) return null
  const parameter = receiver.children.find(n => n.type === 'parameter_declaration')
  const type = parameter?.childForFieldName('type')
  return type ? type.text.replace(/^\*/, '').replace(/\[.*\]$/, '') : null
}

/** Declaration wrappers and Rust attributes travel with the declaration. */
function declarationStart(node: import('web-tree-sitter').Node, parent: import('web-tree-sitter').Node | null, lang: LangName): number {
  let start = node.startIndex
  let cursor = node, owner = parent
  while (owner && ['decorated_definition', 'export_statement', 'template_declaration'].includes(owner.type)) {
    start = owner.startIndex; cursor = owner; owner = owner.parent
  }
  if (lang === 'rust' && owner) {
    const siblings = owner.children, index = siblings.findIndex(item => item.id === cursor.id)
    for (let i = index - 1; i >= 0; i--) {
      const previous = siblings[i]
      if (previous.type === 'attribute_item') start = previous.startIndex
      else if (!['line_comment', 'block_comment'].includes(previous.type)) break
    }
  }
  return start
}

function isListMember(node: import('web-tree-sitter').Node, parent: import('web-tree-sitter').Node | null, lang: LangName): boolean {
  return ['pair', 'enum_variant', 'enumerator', 'enum_constant', 'enum_member_declaration'].includes(node.type)
    || lang === 'lua' && node.type === 'field'
    || node.type === 'method_definition' && parent?.type === 'object'
}

class Collector {
  readonly out: AstSymbol[] = []
  constructor(
    private readonly spec: FamilySpec,
    private readonly lang: LangName,
    private readonly sep: '.' | '::' = '.',
  ) {}

  private emit(node: import('web-tree-sitter').Node, simple: string, kind: SymbolKind, prefix: string | null,
    parent: import('web-tree-sitter').Node | null): AstSymbol {
    const symbol: AstSymbol = { name: simple, qualifiedName: prefix ? `${prefix}${this.sep}${simple}` : simple,
      startOffset: declarationStart(node, parent, this.lang), endOffset: node.endIndex,
      kind, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, children: [] }
    if (isListMember(node, parent, this.lang)) symbol.listMember = true
    const comment = commentStartRow(parent, node, this.spec)
    if (comment !== null && comment.line < symbol.startLine) { symbol.commentStartLine = comment.line; symbol.commentStartOffset = comment.offset }
    this.out.push(symbol)
    return symbol
  }

  collect(node: import('web-tree-sitter').Node, prefix: string | null, parent: import('web-tree-sitter').Node | null, scope: 'class' | 'function' | 'module' = 'module'): void {
    const spec = this.spec
    // Language-specific named declaration shapes; identifiers in expressions
    // and function locals are deliberately not promoted to project symbols.
    if ((this.lang === 'c' || this.lang === 'cpp') && ['declaration', 'field_declaration', 'type_definition'].includes(node.type)) {
      if (scope === 'function') return
      const declarators = node.children.filter(child => ['identifier', 'field_identifier', 'type_identifier', 'init_declarator', 'function_declarator', 'pointer_declarator', 'array_declarator'].includes(child.type))
      for (const child of node.children) {
        if (child.type.endsWith('_specifier') && child.childForFieldName('body')) this.collect(child, prefix, node, scope)
        if (['identifier', 'field_identifier', 'type_identifier', 'init_declarator', 'function_declarator', 'pointer_declarator', 'array_declarator'].includes(child.type)) {
          let target = child
          let callable = false
          while (target.childForFieldName('declarator')) { callable ||= target.type === 'function_declarator'; target = target.childForFieldName('declarator')! }
          const name = target.text
          const symbol = this.emit(node, name, node.type === 'type_definition' ? 'type' : callable ? scope === 'class' ? 'method' : 'function' : scope === 'class' ? 'field' : 'variable', prefix, parent)
          if (declarators.length > 1 || node.children.some(item => item.type.endsWith('_specifier') && item.childForFieldName('body'))) symbol.sharedDeclaration = true
        }
      }
      return
    }
    if ((this.lang === 'c' || this.lang === 'cpp') && node.type.endsWith('_specifier') && !node.childForFieldName('body')) return
    if ((this.lang === 'java' || this.lang === 'c_sharp') && node.type === 'field_declaration') {
      const emitted: AstSymbol[] = []
      const visit = (child: import('web-tree-sitter').Node) => {
        if (child.type === 'variable_declarator') {
          const name = child.childForFieldName('name') ?? child.children.find(item => item.type === 'identifier')
          if (name) emitted.push(this.emit(node, name.text, 'field', prefix, parent))
        } else for (const item of child.children) visit(item)
      }
      visit(node)
      if (emitted.length > 1) for (const symbol of emitted) symbol.sharedDeclaration = true
      return
    }
    if (this.lang === 'python' && node.type === 'assignment') {
      const target = node.childForFieldName('left')
      if (scope !== 'function' && target?.type === 'identifier') this.emit(node, target.text, scope === 'class' ? 'field' : 'variable', prefix, parent)
      return
    }
    if (this.lang === 'lua' && ['local_variable_declaration', 'variable_assignment'].includes(node.type)) {
      if (scope === 'function') return
      const targets = node.children.find(child => child.type === 'variable_list')?.children.filter(child => child.type === 'variable') ?? []
      const values = node.children.find(child => child.type === 'expression_list')?.children.filter(child => child.isNamed) ?? []
      targets.forEach((target, index) => {
        const value = values[index]
        const symbol = this.emit(node, target.text.replaceAll(':', '.'), value?.type === 'table' ? 'object' : value?.type === 'function_definition' ? 'function' : 'variable', prefix, parent)
        if (targets.length > 1) symbol.sharedDeclaration = true
        if (value) {
          const inner = new Collector(spec, this.lang, this.sep)
          for (const child of value.children) inner.collect(child, symbol.qualifiedName, value, value.type === 'table' ? 'class' : 'function')
          symbol.children = inner.out
        }
      })
      return
    }
    if (this.lang === 'lua' && node.type === 'field') {
      const key = node.childForFieldName('key'), value = node.childForFieldName('value')
      if (key?.type === 'identifier') {
        const symbol = this.emit(node, key.text, value?.type === 'function_definition' ? 'method' : value?.type === 'table' ? 'object' : 'field', prefix, parent)
        if (value) {
          const inner = new Collector(spec, this.lang, this.sep)
          for (const child of value.children) inner.collect(child, symbol.qualifiedName, value, value.type === 'table' ? 'class' : 'function')
          symbol.children = inner.out
        }
      }
      return
    }
    // Go type declarations: `type Greeter struct {…}` / interface — the kind
    // depends on the child type node, so it cannot sit in the static map.
    if (this.lang === 'go' && node.type === 'type_spec') {
      const name = nameOf(node, spec)
      if (name) {
        const childTypes = node.children.map((c) => c.type)
        const kind: SymbolKind = childTypes.includes('struct_type') ? 'struct'
          : childTypes.includes('interface_type') ? 'interface' : 'type'
        const qualified = prefix ? `${prefix}${this.sep}${name}` : name
        const sym: AstSymbol = {
          startOffset: node.startIndex, endOffset: node.endIndex,
          name,
          qualifiedName: qualified,
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          children: [],
        }
        if (isListMember(node, parent, this.lang)) sym.listMember = true
        const cStart = commentStartRow(parent, node, spec)
        if (cStart !== null && cStart.line < sym.startLine) { sym.commentStartLine = cStart.line; sym.commentStartOffset = cStart.offset }
        this.out.push(sym)
        const inner = new Collector(spec, this.lang, this.sep)
        for (const child of node.children) inner.collect(child, qualified, node, 'class')
        sym.children = inner.out
      }
      return
    }
    // Rust impl blocks qualify their functions by the target type:
    // impl Store { fn put_blob() } → Store::put_blob
    if (this.lang === 'rust' && node.type === 'impl_item') {
      const targetType = node.childForFieldName('type')
      const implPrefix = targetType ? (prefix ? `${prefix}::${targetType.text}` : targetType.text) : prefix
      const inner = new Collector(spec, this.lang, '::')
      for (const child of node.children) inner.collect(child, implPrefix, node, 'class')
      const sym = this.emit(node, `impl ${targetType?.text ?? '?'}`, 'impl', prefix, parent)
      sym.children = inner.out
      return
    }
    if (spec.wrappers.includes(node.type)) {
      for (const child of node.children) this.collect(child, prefix, node, scope)
      return
    }
    const kind = spec.declarations[node.type]
    if (kind) {
      let simple = nameOf(node, spec)
      if (node.type === 'function_definition' && (this.lang === 'c' || this.lang === 'cpp')) {
        let declarator = node.childForFieldName('declarator')
        while (declarator?.childForFieldName('declarator')) declarator = declarator.childForFieldName('declarator')
        simple = declarator?.text.replaceAll('::', '.') ?? null
      }
      if (this.lang === 'lua') simple = simple?.replaceAll(':', '.') ?? null
      // Python class-level defs are methods (PF parity: 类内函数记为 method)
      const effectiveKind: SymbolKind = this.lang === 'python' && node.type === 'function_definition' && scope === 'class'
        ? 'method'
        : (this.lang === 'c' || this.lang === 'cpp') && kind === 'function' && scope === 'class' ? 'method'
        : this.lang === 'lua' && simple?.includes('.') && kind === 'function' ? 'method' : kind
      if (effectiveKind === 'variable' && scope === 'function') return
      if (node.type === 'method_declaration' && this.lang === 'go') {
        const receiver = goReceiverName(node)
        if (receiver) simple = `${receiver}.${simple ?? ''}`
      }
      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        // handled by caller shaping below (arrow/function assignment)
      }
      if (simple) {
        const qualified = prefix ? `${prefix}${this.sep}${simple}` : simple
        const sym: AstSymbol = {
          startOffset: declarationStart(node, parent, this.lang), endOffset: node.endIndex,
          name: simple,
          qualifiedName: qualified,
          kind: effectiveKind,
          startLine: parent?.type === 'decorated_definition' ? parent.startPosition.row + 1 : node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          children: [],
        }
        if ((this.lang === 'c' || this.lang === 'cpp') && parent && ['declaration', 'field_declaration', 'type_definition'].includes(parent.type)
          && parent.children.some(child => ['identifier', 'field_identifier', 'type_identifier', 'init_declarator', 'function_declarator', 'pointer_declarator', 'array_declarator'].includes(child.type))) sym.sharedDeclaration = true
        if (isListMember(node, parent, this.lang)) sym.listMember = true
        const cStart = commentStartRow(parent, node, spec)
        if (cStart !== null && cStart.line < sym.startLine) { sym.commentStartLine = cStart.line; sym.commentStartOffset = cStart.offset }
        this.out.push(sym)
        // recurse for nested symbols with this symbol as qualifier
        const inner = new Collector(spec, this.lang, this.sep)
        const childScope = ['class', 'interface', 'trait', 'struct', 'enum', 'object'].includes(effectiveKind) ? 'class'
          : ['function', 'method'].includes(effectiveKind) ? 'function' : 'module'
        for (const child of node.children) inner.collect(child, qualified, node, childScope)
        sym.children = inner.out
        return
      }
    }
    // arrow/function assignments: const foo = () => {} / const foo = function(){}
    if (['javascript', 'typescript', 'tsx'].includes(this.lang) && (node.type === 'lexical_declaration' || node.type === 'variable_declaration')) {
      const declarators = node.children.filter((c) => c.type === 'variable_declarator')
      for (const declarator of declarators) {
        const value = declarator.childForFieldName('value')
        const target = declarator.childForFieldName('name')
        const callable = value && ['arrow_function', 'function_expression', 'function', 'generator_function'].includes(value.type)
        if (target?.type === 'identifier' && (callable || scope !== 'function')) {
          const qualified = prefix ? `${prefix}${this.sep}${target.text}` : target.text
          const sym: AstSymbol = {
            ...(declarators.length > 1 ? { sharedDeclaration: true } : {}),
            startOffset: declarators.length === 1 ? parent?.type === 'export_statement' ? parent.startIndex : node.startIndex : declarator.startIndex,
            endOffset: declarators.length === 1 ? node.endIndex : declarator.endIndex,
            name: target.text,
            qualifiedName: qualified,
            kind: callable ? 'function' : value?.type === 'object' ? 'object' : 'variable',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            children: [],
          }
          const cStart = commentStartRow(parent, node, spec)
          if (cStart !== null && cStart.line < sym.startLine) { sym.commentStartLine = cStart.line; sym.commentStartOffset = cStart.offset }
          const inner = new Collector(spec, this.lang, this.sep)
          if (value) for (const child of value.children) inner.collect(child, qualified, value, callable ? 'function' : 'class')
          sym.children = inner.out
          this.out.push(sym)
        }
      }
      return
    }
    if (['javascript', 'typescript', 'tsx'].includes(this.lang) && node.type === 'pair') {
      const key = node.childForFieldName('key'), value = node.childForFieldName('value')
      if (key?.type === 'property_identifier') {
        const callable = value && ['arrow_function', 'function_expression', 'function'].includes(value.type)
        const symbol = this.emit(node, key.text, callable ? 'method' : value?.type === 'object' ? 'object' : 'field', prefix, parent)
        if (value) {
          const inner = new Collector(spec, this.lang, this.sep)
          for (const child of value.children) inner.collect(child, symbol.qualifiedName, value, callable ? 'function' : 'class')
          symbol.children = inner.out
        }
      }
      return
    }
    for (const child of node.children) this.collect(child, prefix, node, scope)
  }
}

export function extractSymbols(tree: import('web-tree-sitter').Tree, lang: LangName): AstSymbol[] {
  const spec = familyFor(lang)
  const collector = new Collector(spec, lang, lang === 'rust' ? '::' : '.')
  collector.collect(tree.rootNode, null, null)
  return collector.out
}

/** Per-file byte cap for AST extraction (PF parity). */
export const MAX_AST_FILE_BYTES = 2 * 1024 * 1024

/** Validate a planned symbol mutation without touching disk or the file cache. */
export async function syntaxValid(text: string, lang: LangName): Promise<boolean> {
  const parser = await getParser(lang)
  const tree = parser.parse(text)
  if (!tree) return false
  try { return !tree.rootNode.hasError } finally { tree.delete() }
}

// ---------------------------------------------------------------------------
// Content-anchored file cache
// ---------------------------------------------------------------------------

export interface ParsedFile {
  absPath: string
  lang: LangName
  /** sha256 of the normalized text the symbols were extracted from. */
  hash: string
  /** The normalized text itself (transient — NOT retained by the cache). */
  text: string
  symbols: AstSymbol[]
  /** True when the tree contains ERROR/MISSING nodes (best-effort parse). */
  partial: boolean
}

interface CacheEntry {
  hash: string
  lang: LangName
  symbols: AstSymbol[]
  partial: boolean
}

const fileCache = new Map<string, CacheEntry>()

export interface ParseOutcome {
  value?: ParsedFile
  error?: string
}

/** Bound raw reads before decoding, normalization or hashing, even if a file grows. */
function readAstText(absPath: string): { text: string } | { error: string } {
  try {
    return { text: normalizeText(readBoundedFile(absPath, MAX_AST_FILE_BYTES).toString('utf8')) }
  } catch (cause) {
    return { error: `cannot read ${absPath} (2MB AST cap): ${cause instanceof Error ? cause.message : String(cause)}` }
  }
}

/**
 * Parse (or fetch from the content-anchored cache) a single file. ALWAYS
 * re-reads from disk: the hash of current content decides cache reuse, so a
 * file modified after a previous parse is parsed fresh — ranges can never go
 * stale (forge principle #1).
 *
 * Memory discipline: the cache retains only symbol metadata + hash, never the
 * file text (a full-corpus scan over large bundles otherwise pins hundreds of
 * MB). Text is transient per call — re-reading is cheap, parsing is what the
 * cache exists to skip.
 */
export async function parseFile(absPath: string, options: { readPath?: string } = {}): Promise<ParseOutcome> {
  const lang = detectLanguage(absPath)
  if (!lang) return { error: `unsupported language for ${path.basename(absPath)} — outline/symbol tools cover ${Object.keys(EXT_LANG).join(' ')}; use ffgrep for everything else` }
  // The caller's address supplies the language; a provider may pin byte reads
  // to a canonical target with a different extension (including no extension).
  const input = readAstText(options.readPath ?? absPath)
  if ('error' in input) return input
  const text = input.text
  const hash = createHash('sha256').update(text).digest('hex')
  const cached = fileCache.get(absPath)
  if (cached && cached.hash === hash && cached.lang === lang) {
    return { value: { absPath, lang, hash, text, symbols: cached.symbols, partial: cached.partial } }
  }

  // Per-file size cap, mirroring PF's findSymbols (2MB → truncated): bundled
  // monsters are low-value for symbol extraction and their parse trees blow
  // up the WASM heap high-water mark for the rest of the session.
  if (Buffer.byteLength(text, 'utf8') > MAX_AST_FILE_BYTES) {
    return { error: `${path.basename(absPath)} exceeds the ${(MAX_AST_FILE_BYTES / 1048576).toFixed(0)}MB AST cap — use ffgrep for it` }
  }

  try {
    const parser = await getParser(lang)
    const tree = parser.parse(text)
    if (!tree) return { error: `tree-sitter failed to parse ${absPath}` }
    const partial = tree.rootNode.hasError
    const symbols = extractSymbols(tree, lang)
    // Release the native tree promptly — WASM heap reuse, lower high-water.
    if (typeof (tree as unknown as { delete?: () => void }).delete === 'function') {
      (tree as unknown as { delete: () => void }).delete()
    }
    fileCache.set(absPath, { hash, lang, symbols, partial })
    if (fileCache.size > 5000) {
      const first = fileCache.keys().next().value
      if (first !== undefined) fileCache.delete(first)
    }
    return { value: { absPath, lang, hash, text, symbols, partial } }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { error: `AST engine unavailable for ${lang}: ${message} — use ffgrep instead` }
  }
}

/** Test hook: drop all cached parses. */
export function resetCache(): void {
  fileCache.clear()
}

// ---------------------------------------------------------------------------
// Facts extraction (fftrace) — same parse, separate cache keyed by content
// hash + bridge-globals set (bridge membership changes which member accesses
// count, so the key must include it).
// ---------------------------------------------------------------------------

export interface FactsParse {
  lang: LangName
  hash: string
  /** Normalized text (transient — not retained by the cache). */
  text: string
  facts: import('./facts.ts').FileFacts
  partial: boolean
}

interface FactsCacheEntry {
  hash: string
  bridgeKey: string
  facts: import('./facts.ts').FileFacts
  partial: boolean
}

const factsCache = new Map<string, FactsCacheEntry>()

export async function fileFacts(absPath: string, bridgeGlobals: readonly string[]): Promise<{ error?: string; value?: FactsParse }> {
  const lang = detectLanguage(absPath)
  if (!lang) return { error: `unsupported language for ${path.basename(absPath)}` }
  const input = readAstText(absPath)
  if ('error' in input) return input
  const text = input.text
  const hash = createHash('sha256').update(text).digest('hex')
  const bridgeKey = bridgeGlobals.join('|')
  const cached = factsCache.get(absPath)
  if (cached && cached.hash === hash && cached.bridgeKey === bridgeKey) {
    return { value: { lang, hash, text, facts: cached.facts, partial: cached.partial } }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_AST_FILE_BYTES) {
    return { error: `${path.basename(absPath)} exceeds the ${(MAX_AST_FILE_BYTES / 1048576).toFixed(0)}MB AST cap` }
  }
  try {
    const parser = await getParser(lang)
    const tree = parser.parse(text)
    if (!tree) return { error: `tree-sitter failed to parse ${absPath}` }
    const partial = tree.rootNode.hasError
    const facts = extractFacts(tree, lang, bridgeGlobals)
    if (typeof (tree as unknown as { delete?: () => void }).delete === 'function') {
      (tree as unknown as { delete: () => void }).delete()
    }
    factsCache.set(absPath, { hash, bridgeKey, facts, partial })
    if (factsCache.size > 5000) {
      const first = factsCache.keys().next().value
      if (first !== undefined) factsCache.delete(first)
    }
    return { value: { lang, hash, text, facts, partial } }
  } catch (cause) {
    return { error: `AST engine unavailable for ${lang}: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
}

/** Test hook: drop cached facts. */
export function resetFactsCache(): void {
  factsCache.clear()
}

/** Facts from an in-memory text (HTML inline script bodies — no file, no cache). */
export async function factsFromText(text: string, bridgeGlobals: readonly string[]): Promise<{ facts: import('./facts.ts').FileFacts; partial: boolean } | null> {
  try {
    const parser = await getParser('javascript')
    const tree = parser.parse(text)
    if (!tree) return null
    const partial = tree.rootNode.hasError
    const facts = extractFacts(tree, 'javascript', bridgeGlobals)
    if (typeof (tree as unknown as { delete?: () => void }).delete === 'function') {
      (tree as unknown as { delete: () => void }).delete()
    }
    return { facts, partial }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Symbol queries (pure functions over AstSymbol trees)
// ---------------------------------------------------------------------------

function* walkSymbols(symbols: AstSymbol[]): Generator<AstSymbol> {
  for (const sym of symbols) {
    yield sym
    yield* walkSymbols(sym.children)
  }
}

export function flattenSymbols(symbols: AstSymbol[]): AstSymbol[] {
  return [...walkSymbols(symbols)]
}

/** Address identities are assigned before query/kind/pagination filters. */
export function symbolOccurrences(symbols: AstSymbol[]): Map<AstSymbol, number> {
  const counters = new Map<string, number>()
  return new Map(flattenSymbols(symbols).sort((a, b) => a.startOffset - b.startOffset).map(symbol => {
    const occurrence = (counters.get(symbol.qualifiedName) ?? 0) + 1
    counters.set(symbol.qualifiedName, occurrence)
    return [symbol, occurrence]
  }))
}

export interface OutlineOptions {
  depth?: number
  kind?: string
}

/** Depth-trimmed view; entries carry their nesting level for rendering. */
export function outlineView(symbols: AstSymbol[], options: OutlineOptions = {}): Array<AstSymbol & { level: number }> {
  const kindFilter = options.kind ? options.kind.split(',').map((k) => k.trim()) : null
  const out: Array<AstSymbol & { level: number }> = []
  const visit = (list: AstSymbol[], level: number) => {
    if (options.depth !== undefined && level > options.depth) return
    for (const sym of list) {
      if (!kindFilter || kindFilter.includes(sym.kind)) out.push({ ...sym, level })
      visit(sym.children, level + 1)
    }
  }
  visit(symbols, 1)
  return out
}

export interface SymbolMatch {
  symbol: AstSymbol
  /** Matches by simple name, dotted qualified name, or Rust Type::name. */
}

export function findSymbol(symbols: AstSymbol[], query: string, exact = false): AstSymbol[] {
  const q = query.trim()
  const dotted = q.replace(/::/g, '.')
  const exacts: AstSymbol[] = []
  const fuzzies: AstSymbol[] = []
  for (const sym of walkSymbols(symbols)) {
    const qn = sym.qualifiedName.replace(/::/g, '.')
    if (qn === dotted || sym.name === dotted) {
      exacts.push(sym)
    } else if (!exact && dotted.length >= 3 && (qn.endsWith(`.${dotted}`) || sym.name.endsWith(dotted))) {
      fuzzies.push(sym)
    }
  }
  return exacts.length > 0 ? exacts : fuzzies
}

/** Innermost symbol whose range contains the 1-based line. */
export function enclosingSymbol(symbols: AstSymbol[], line: number): AstSymbol | null {
  let best: AstSymbol | null = null
  for (const sym of walkSymbols(symbols)) {
    if (sym.startLine <= line && line <= sym.endLine) {
      if (!best || (sym.endLine - sym.startLine) <= (best.endLine - best.startLine)) best = sym
    }
  }
  return best
}

/** Slice the normalized text for a symbol's range (comments included by default). */
export function sliceSymbol(parsed: ParsedFile, symbol: AstSymbol, body = false): string {
  const start = body || symbol.commentStartLine === undefined ? symbol.startLine : symbol.commentStartLine
  const lines = parsed.text.split('\n')
  return lines.slice(start - 1, symbol.endLine).join('\n')
}

/** Exact AST span; include comments only when they begin on otherwise blank lines. */
export function symbolSpan(parsed: ParsedFile, symbol: AstSymbol, body = false): { start: number; end: number } {
  let start = symbol.startOffset
  if (!body && symbol.commentStartLine !== undefined) {
    const lines = parsed.text.split('\n')
    // A trailing comment on another statement never owns that statement's line.
    const lineStart = lines.slice(0, symbol.commentStartLine - 1).reduce((total, line) => total + line.length + 1, 0)
    if (symbol.commentStartOffset !== undefined && !parsed.text.slice(lineStart, symbol.commentStartOffset).trim()) {
      start = Math.min(start, lineStart)
    }
  }
  return { start, end: symbol.endOffset }
}
