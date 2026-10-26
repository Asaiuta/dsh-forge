/**
 * dsh-forge facts layer: per-file link facts for fftrace, extracted from
 * tree-sitter parse trees of JS/TS, Rust, Python and C/C++, plus a lightweight
 * HTML script scanner. Non-JS languages expose static file dependencies.
 * Clean-room implementation following the fact model documented in
 * the ProjectForge blueprint (5.3/5.6): requires/imports, IPC register/call/
 * push with confidence (literal > const > wrapper > param; dynamic never
 * enters an edge), preload bridge member accesses, top-level bridge aliases,
 * window globals defined/used, and contextBridge exposes. No function-level
 * call graph and no type inference — same honesty contract as PF.
 *
 * Line contract: 1-based on BOM-stripped, LF-normalized text (forge-wide).
 *
 * @module dsh-forge/facts
 */

import { extractModuleFacts, supportsModuleFacts, type ModuleFact, type ModuleLanguage } from './module-facts.ts'
import { extractModuleInfo, type ModuleInfo } from './language-facts.ts'
import { extractFfiFacts, type FfiFact } from './ffi-facts.ts'
import type { JsMode, JsSyntax } from './trace-evidence.ts'
import type { BinaryInfo } from './binary-facts.ts'
import { cppModules } from './cpp-modules.ts'
import { cgoIncludes } from './cgo-facts.ts'

interface TsNode {
  readonly id: number
  readonly type: string
  readonly text: string
  readonly startPosition: { row: number }
  readonly isNamed: boolean
  readonly children: TsNode[]
  readonly parent: TsNode | null
  childForFieldName(name: string): TsNode | null
  descendantsOfType(type: string): TsNode[]
}
type TsTree = import('web-tree-sitter').Tree
type LangName = import('./ast.ts').LangName

export interface FactRef {
  /** 1-based on normalized text. */
  line: number
  /** Nearest enclosing named function/method, when any. */
  symbol?: string
}

export interface IpcFact extends FactRef {
  side: 'register' | 'call' | 'push'
  method: string
  channel: string | null
  /** Raw argument text for dynamic channels (truncated). */
  expr?: string
  via: 'literal' | 'const' | 'wrapper' | 'param' | 'dynamic'
}

export interface BridgeFact extends FactRef {
  /** Root object after window./globalThis. stripping (may be a page alias). */
  object: string
  name: string
}

export interface AliasFact {
  name: string
  object: string
  line: number
  topLevel: boolean
}

export interface GlobalDefFact extends FactRef {
  name: string
  how: 'window' | 'function' | 'var' | 'let' | 'const'
}

export interface GlobalUseFact extends FactRef {
  name: string
}

export interface RequireFact {
  spec: string
  line: number
  dynamic?: boolean
  /** The argument was not a string literal and must never resolve to a file. */
  unresolved?: true
  /** Owning 1-based script index when this fact came from inline HTML. */
  scriptIndex?: number
  /** TS import-equals contributes to a program; an ordinary TS require does not. */
  importEquals?: true
  /** Literal Vue external script declaration, separate from script body imports. */
  componentSrc?: true
}

/**
 * Electron preload wiring: `webPreferences.preload` is a structural file
 * reference — preloads load via BrowserWindow options, never require/import,
 * so the file graph misses them without this fact (real-repo A10: a preload
 * showed 0 dependents and the model rebuilt the reference list by hand).
 */
export interface PreloadFact {
  /** Literal path, joined literal pieces, or a bare role token resolved from the const table. */
  spec: string
  line: number
  /** Direct path literal (or path.join of literals); role values resolve by convention only. */
  literal?: true
  /** A name this file could not resolve locally — retried against workspace const tables. */
  externalRef?: true
}

/** A local function whose body forwards to an ipc primitive (`function invoke(ch) { ipcRenderer.invoke(ch) }`). */
export interface WrapperFact {
  name: string
  side: 'register' | 'call' | 'push'
  method: string
}

/**
 * A local name bound to another module's export — `const { invoke } = require('../core/define')`,
 * `import { send as s } from './bridge'`, or a namespace binding (`imported: null`).
 * Wrappers are routinely defined in one module and called from many others; without
 * these bindings a cross-file wrapper call is indistinguishable from a local helper.
 */
export interface ModuleBindingFact {
  local: string
  spec: string
  imported: string | null
}

/**
 * A resolved call through an imported binding, held back until the target
 * module's wrapper table is known (the second pass of a link graph).
 */
export interface DeferredCallFact {
  local: string
  spec: string
  imported: string | null
  line: number
  symbol?: string
  channel: string
  via: 'literal' | 'const'
}

/**
 * `name: <wrapper>('channel')` — the preload API table read straight from source,
 * so `api:<name>` resolves without a hand-written declaration file. The wrapper
 * may be local or imported; the link graph confirms imported ones.
 */
export interface NamedEntryFact {
  name: string
  channel: string
  line: number
  symbol?: string
  /** `null` when the wrapper is defined in this same file, else its module specifier. */
  spec: string | null
  /** Exported wrapper name in `spec`, or the local wrapper name when `spec` is null. */
  wrapper: string
}

export interface ExposeFact {
  name: string
  keys: string[]
  line: number
  /** First argument is an identifier, not a literal global name. */
  dynamic?: boolean
  /** Where `keys` came from; absent when the exposed object is built at runtime. */
  keySource?: 'literal' | 'identifier'
  /** A spread/unknown member makes `keys` a lower bound, not the full set. */
  partial?: boolean
}

/** `export … from` (or an exported import binding): names this module forwards from another. */
export interface ForwardFact {
  spec: string
  line: number
  /** `export * from` — every named export except default. */
  star?: true
  /** `export * as ns from` — the namespace object of the target module. */
  namespace?: string
  names?: Array<{ exported: string; imported: string }>
}

/** ES module export table: declared names plus forwards. Absent for CommonJS-only files. */
export interface ModuleExportsFact {
  names: string[]
  forwards: ForwardFact[]
  /** Exported default/namespace import bindings: exported, but the definition is not traced. */
  opaque?: string[]
}

export interface FileFacts {
  /** Present only for the non-JavaScript module collectors. */
  modules?: ModuleFact[]
  moduleInfo?: ModuleInfo
  ambientModules?: Array<{ name: string; line: number }>
  ffi?: FfiFact[]
  preloads?: PreloadFact[]
  requires: RequireFact[]
  imports: RequireFact[]
  ipc: IpcFact[]
  bridge: BridgeFact[]
  bridgeAliases: AliasFact[]
  globalsDefined: GlobalDefFact[]
  globalsUsed: GlobalUseFact[]
  exposes: ExposeFact[]
  /** Top-level string consts (≤128, dotted keys for object members) — cross-file preload wiring lookup. */
  constStrings?: Record<string, string>
  wrappers: WrapperFact[]
  bindings: ModuleBindingFact[]
  deferredCalls: DeferredCallFact[]
  namedEntries: NamedEntryFact[]
  moduleExports?: ModuleExportsFact
}

export interface HtmlScriptFact {
  line: number
  src?: string
  inline?: boolean
  module?: boolean
}

export interface HtmlInlineBody {
  /** Inline script body text (comment-masked source slice). */
  text: string
  /** 1-based line in the HTML file where the body starts. */
  line: number
  /** 1-based index in the page's ordered script list, including empty scripts. */
  scriptIndex: number
  /** Inline module script (top-level declarations are scoped, not global). */
  module?: boolean
}

export interface HtmlFacts {
  kind: 'html'
  scripts: HtmlScriptFact[]
  /** Inline script bodies — parsed as JS so their facts land on the page (PF parity). */
  inline: HtmlInlineBody[]
}

export type TraceFileFacts =
  | ({ kind: 'js'; lang: LangName } & FileFacts)
  | ({ kind: 'html' } & HtmlFacts & { facts?: FileFacts })
  | { kind: 'component'; framework: 'vue' | 'svelte'; scripts: Array<{ syntax: JsSyntax; imports: RequireFact[]; requires: RequireFact[] }> }
  | { kind: 'source'; lang: ModuleLanguage; modules: ModuleFact[]; moduleInfo?: ModuleInfo; ffi?: FfiFact[] }
  | { kind: 'manifest'; module: string | null }
  | { kind: 'binary'; metadata: BinaryInfo }

/** Only script facts participate in IPC, page aliases and browser globals. */
export function scriptFacts(entry: TraceFileFacts): FileFacts | null {
  return entry.kind === 'js' ? entry : entry.kind === 'html' ? entry.facts ?? null : null
}

export interface JsReference { mode: JsMode; ref: RequireFact; syntax?: JsSyntax }
/** Components deliberately expose dependencies only, keeping their script scopes separate. */
export function jsReferences(entry: TraceFileFacts): JsReference[] {
  const groups = entry.kind === 'component' ? entry.scripts
    : entry.kind === 'html' && entry.facts ? [entry.facts]
      : entry.kind === 'js' && JS_FAMILY.has(entry.lang) ? [{ ...entry, syntax: entry.lang as JsSyntax }] : []
  return groups.flatMap(group => ([['require', group.requires], ['import', group.imports]] as const)
    .flatMap(([mode, refs]) => refs.map(ref => ({ mode: ref.dynamic ? 'dynamic_import' as const : mode, ref, ...('syntax' in group ? { syntax: group.syntax } : {}) }))))
}

export function emptyFacts(): FileFacts {
  return {
    requires: [], imports: [], ipc: [], bridge: [], bridgeAliases: [], globalsDefined: [], globalsUsed: [], exposes: [],
    wrappers: [], bindings: [], deferredCalls: [], namedEntries: [],
  }
}

/** Concatenate `source` into `target`, shifting every 1-based line by `offset`. */
export function mergeFacts(target: FileFacts, source: FileFacts, offset: number): void {
  if (source.modules?.length) (target.modules ??= []).push(...source.modules.map(ref => ({ ...ref, line: ref.line + offset })))
  target.requires.push(...source.requires.map(r => ({ ...r, line: r.line + offset })))
  target.imports.push(...source.imports.map(r => ({ ...r, line: r.line + offset })))
  target.ipc.push(...source.ipc.map(f => ({ ...f, line: f.line + offset })))
  target.bridge.push(...source.bridge.map(b => ({ ...b, line: b.line + offset })))
  target.bridgeAliases.push(...source.bridgeAliases.map(a => ({ ...a, line: a.line + offset })))
  target.globalsDefined.push(...source.globalsDefined.map(d => ({ ...d, line: d.line + offset })))
  target.globalsUsed.push(...source.globalsUsed.map(u => ({ ...u, line: u.line + offset })))
  target.exposes.push(...source.exposes.map(e => ({ ...e, line: e.line + offset })))
  target.wrappers.push(...source.wrappers.map(w => ({ ...w })))
  target.bindings.push(...source.bindings.map(b => ({ ...b })))
  target.deferredCalls.push(...source.deferredCalls.map(c => ({ ...c, line: c.line + offset })))
  target.namedEntries.push(...source.namedEntries.map(n => ({ ...n, line: n.line + offset })))
}

// ---------------------------------------------------------------------------
// HTML: ordered <script> scanner (no grammar — comment-masked, order-faithful)
// ---------------------------------------------------------------------------

export function scanHtmlFacts(text: string): HtmlFacts {
  // Mask comments with same-length whitespace so line numbers survive and
  // commented-out <script> tags are excluded (PF parity).
  const masked = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  const scripts: HtmlScriptFact[] = []
  const inline: HtmlInlineBody[] = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const attrs = m[1]
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
    const module = /\btype\s*=\s*["']?module["']?/i.test(attrs)
    scripts.push({
      line: masked.slice(0, m.index).split('\n').length,
      ...(src ? { src: (src[1] ?? src[2] ?? src[3]).trim() } : { inline: true }),
      ...(module ? { module: true } : {}),
    })
    if (!src && m[2].trim() !== '') {
      // The body starts right after the opening tag's '>' — same line.
      const bodyLine = masked.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length
      inline.push({ text: m[2], line: bodyLine, scriptIndex: scripts.length, ...(module ? { module: true } : {}) })
    }
  }
  return { kind: 'html', scripts, inline }
}

// ---------------------------------------------------------------------------
// Single-file components: top-level <script> blocks only. Template/style
// compile dependencies are deliberately out of scope (framework compilers,
// not static import resolution).
// ---------------------------------------------------------------------------

export interface ComponentScriptBlock {
  /** 1-based line of the opening <script> tag. */
  line: number
  /** Vue external script declaration; absent for inline bodies. */
  src?: string
  /** Language of this block — decides TS-aware resolution of its specs. */
  syntax: JsSyntax
  /** Inline body (comment-masked source slice); absent when src is set. */
  text?: string
}

export function scanComponentScripts(text: string): ComponentScriptBlock[] {
  const masked = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  const blocks: ComponentScriptBlock[] = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const attrs = m[1]
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
    const lang = /\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
    const raw = (lang?.[1] ?? lang?.[2] ?? lang?.[3] ?? '').trim().toLowerCase()
    const syntax: JsSyntax = raw === 'ts' || raw === 'typescript' ? 'typescript' : raw === 'tsx' || raw === 'jsx' ? 'tsx' : 'javascript'
    blocks.push({
      line: masked.slice(0, m.index).split('\n').length,
      ...(src ? { src: (src[1] ?? src[2] ?? src[3]).trim() } : { text: m[2] }),
      syntax,
    })
  }
  return blocks
}

// ---------------------------------------------------------------------------
// JS family: three-pass extraction — top-level const/alias tables, wrapper
// definitions, then the full fact walk with confidence resolution.
// ---------------------------------------------------------------------------

const JS_FAMILY: ReadonlySet<string> = new Set(['javascript', 'typescript', 'tsx'])
const FUNCTION_NODES: ReadonlySet<string> = new Set(['arrow_function', 'function_expression', 'function', 'generator_function'])

function isCall(node: TsNode): boolean {
  return node.type === 'call_expression'
}

function calleeOf(call: TsNode): TsNode | null {
  return call.childForFieldName('function')
}

function argsOf(call: TsNode): TsNode[] {
  const args = call.childForFieldName('arguments')
  if (!args) return []
  return args.children.filter((c) => c.isNamed && c.type !== 'comment')
}

function propertyName(node: TsNode): string | null {
  const prop = node.childForFieldName('property')
  if (!prop) return null
  return prop.type === 'property_identifier' || prop.type === 'identifier' || prop.type === 'private_property_identifier' ? prop.text : null
}

function objectText(node: TsNode): string | null {
  const obj = node.childForFieldName('object')
  return obj ? obj.text : null
}

/** Value of a string-literal-ish node, else null. */
function literalString(node: TsNode | null | undefined): string | null {
  if (!node) return null
  if (node.type === 'string') {
    const t = node.text
    return t.length >= 2 ? t.slice(1, -1) : null
  }
  if (node.type === 'template_string' && !node.text.includes('${')) {
    const t = node.text
    return t.length >= 2 ? t.slice(1, -1) : null
  }
  return null
}

function stripWindowPrefix(name: string): string {
  return name.replace(/^(?:window|globalThis)\./, '')
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

const IPC_MAIN = /^(?:[A-Za-z_$][\w$]*\.)*ipcMain$/
const IPC_RENDERER = /^(?:[A-Za-z_$][\w$]*\.)*ipcRenderer$/
const REGISTER_METHODS = ['handle', 'on', 'once', 'addHandler', 'removeHandler']

interface WrapperDef {
  side: 'register' | 'call' | 'push'
  method: string
}

/** Scope context: nearest named function + its parameter names. */
interface WalkCtx {
  owner: string | null
  params: ReadonlySet<string> | null
}

const TOP_CTX: WalkCtx = { owner: null, params: null }
const TERMINAL_FACT_NODES = new Set(['identifier', 'property_identifier', 'private_property_identifier',
  'shorthand_property_identifier', 'shorthand_property_identifier_pattern', 'string', 'number', 'regex',
  'true', 'false', 'null', 'this', 'super', 'comment'])

/** The wrapper and fact passes revisit the same nodes. Read each WASM field
 *  once, and skip anonymous punctuation during traversal. Views live only for
 *  this extraction; no tree or source text is retained in the facts cache. */
class FactNodeView implements TsNode {
  readonly id: number
  readonly type: string
  readonly isNamed = true
  private cachedText?: string
  private cachedChildren?: TsNode[]
  private cachedStart?: { row: number }
  private cachedParent?: TsNode | null
  private fields?: Map<string, TsNode | null>

  constructor(
    private readonly raw: import('web-tree-sitter').Node,
    private readonly wrap: (raw: import('web-tree-sitter').Node) => TsNode,
  ) {
    this.id = raw.id
    this.type = raw.type
  }
  get text(): string { return this.cachedText ??= this.raw.text }
  get startPosition(): { row: number } { return this.cachedStart ??= this.raw.startPosition }
  get children(): TsNode[] {
    return this.cachedChildren ??= TERMINAL_FACT_NODES.has(this.type)
      ? []
      : this.raw.namedChildren
        .filter((child): child is import('web-tree-sitter').Node => child !== null)
        .map(this.wrap)
  }
  get parent(): TsNode | null {
    if (this.cachedParent === undefined) { const parent = this.raw.parent; this.cachedParent = parent ? this.wrap(parent) : null }
    return this.cachedParent
  }
  descendantsOfType(type: string): TsNode[] {
    return this.raw.descendantsOfType(type)
      .filter((node): node is import('web-tree-sitter').Node => node !== null)
      .map(this.wrap)
  }
  childForFieldName(name: string): TsNode | null {
    const fields = this.fields ??= new Map<string, TsNode | null>()
    if (!fields.has(name)) {
      const child = this.raw.childForFieldName(name)
      fields.set(name, child ? this.wrap(child) : null)
    }
    return fields.get(name)!
  }
}

function nodeView(root: import('web-tree-sitter').Node): TsNode {
  const views = new Map<number, TsNode>()
  const wrap = (raw: import('web-tree-sitter').Node): TsNode => {
    const existing = views.get(raw.id)
    if (existing) return existing
    const view = new FactNodeView(raw, wrap)
    views.set(raw.id, view)
    return view
  }
  return wrap(root)
}

class FactsCollector {
  readonly out: FileFacts = emptyFacts()
  private hasIpcSyntax = false
  private readonly consts = new Map<string, string>()
  private readonly constShapes = new Map<string, { keys: string[]; complete: boolean }>()
  private readonly wrappers = new Map<string, WrapperDef>()
  private readonly bindings = new Map<string, ModuleBindingFact>()
  /** `export { a as b }` without a source: a may be a declaration or an import binding (hoisted). */
  private readonly localExports: Array<{ local: string; exported: string; line: number }> = []
  private readonly paramCalls: Array<{ fact: IpcFact; wrapper: string }> = []
  private readonly wrapperCallSites = new Map<string, number>()
  private readonly usedSeen = new Set<string>()

  collect(tree: TsTree, bridgeGlobals: ReadonlySet<string> | null): FileFacts {
    const root = nodeView(tree.rootNode)
    // Every direct IPC shape recognized by classifyCallee contains one of
    // these exact names. Absence safely skips IPC work in ordinary modules;
    // comments/strings may cause extra work but cannot suppress a fact.
    const source = root.text
    this.hasIpcSyntax = source.includes('ipcMain') || source.includes('ipcRenderer') || source.includes('webContents')
    for (const stmt of root.children) this.scanTopLevel(stmt)
    if (!root.children.some(node => node.type === 'import_statement' || node.type === 'export_statement')) {
      for (const node of root.descendantsOfType('ambient_declaration')) {
        const declaration = node.children.find(child => child.type === 'module')
        const name = declaration && literalString(declaration.childForFieldName('name'))
        if (name && !name.includes('*')) (this.out.ambientModules ??= []).push({ name, line: node.startPosition.row + 1 })
      }
    }
    // The file's own aliases count as bridge objects for its own accesses.
    const effective = bridgeGlobals === null ? null : new Set<string>(bridgeGlobals)
    for (const alias of this.out.bridgeAliases) effective?.add(alias.name)
    this.scanWrappers(root)
    for (const child of root.children) this.walk(child, TOP_CTX, effective)
    // A wrapper never called with a resolvable channel must not hide the
    // unresolved passthrough (PF parity).
    for (const record of this.paramCalls) {
      if (!this.wrapperCallSites.get(record.wrapper)) record.fact.via = 'dynamic'
    }
    // Exported import bindings become forwards; imports are hoisted, so this
    // runs after the whole top level has been scanned.
    for (const item of this.localExports) {
      const exports = this.exportsFact(), binding = this.bindings.get(item.local)
      if (!binding) { if (!exports.names.includes(item.exported)) exports.names.push(item.exported) }
      else if (binding.imported !== null) exports.forwards.push({ spec: binding.spec, line: item.line, names: [{ exported: item.exported, imported: binding.imported }] })
      else (exports.opaque ??= []).push(item.exported)
    }
    // Wrapper table for cross-file callers. Only top-level declarations are
    // importable; a wrapper nested inside another function never is.
    const topLevel = new Set(this.out.globalsDefined.map((d) => d.name))
    for (const [name, def] of this.wrappers) {
      if (topLevel.has(name)) this.out.wrappers.push({ name, side: def.side, method: def.method })
    }
    // Cross-file const lookup for preload wiring (`const { PRELOAD_ROLES } =
    // require(...)` hides the table from this file's own const resolution).
    if (this.consts.size) {
      const exported: Record<string, string> = {}
      let count = 0
      for (const [name, value] of this.consts) {
        if (count >= 128) break
        if (value.length > 200) continue
        exported[name] = value
        count++
      }
      this.out.constStrings = exported
    }
    return this.out
  }

  // ---- pass 1: top-level const channels, aliases, global defs -------------

  private scanTopLevel(stmt: TsNode): void {
    if (stmt.type === 'export_statement') {
      this.scanExport(stmt)
      const inner = stmt.childForFieldName('declaration')
      if (inner) this.scanTopLevel(inner)
      return
    }
    if (stmt.type === 'import_statement') {
      this.scanImportBindings(stmt)
      return
    }
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
      const kind = /^\s*const\b/.test(stmt.text) ? 'const' : /^\s*let\b/.test(stmt.text) ? 'let' : 'var'
      for (const declarator of stmt.children.filter((c) => c.type === 'variable_declarator')) {
        const name = declarator.childForFieldName('name')
        const value = declarator.childForFieldName('value')
        if (!name || !value) continue
        if (kind === 'const') {
          this.scanConstValue(name.text, value, declarator.startPosition.row + 1, true)
          this.scanRequireBinding(name, value)
        }
        if (name.type === 'identifier') {
          this.out.globalsDefined.push({ name: name.text, how: kind, line: declarator.startPosition.row + 1 })
        }
      }
      return
    }
    if (stmt.type === 'function_declaration' || stmt.type === 'generator_function_declaration') {
      const name = stmt.childForFieldName('name')
      if (name) this.out.globalsDefined.push({ name: name.text, how: 'function', line: stmt.startPosition.row + 1 })
    }
  }

  private exportsFact(): ModuleExportsFact {
    return this.out.moduleExports ??= { names: [], forwards: [] }
  }

  /** Top-level export statement → declared names or forwards. Unknown shapes add nothing. */
  private scanExport(stmt: TsNode): void {
    const line = stmt.startPosition.row + 1
    const source = stmt.childForFieldName('source')
    const spec = source ? literalString(source) : null
    if (source && spec === null) return
    const nameOf = (node: TsNode | null | undefined): string | null => !node ? null : node.type === 'string' ? literalString(node) : node.text
    const clause = stmt.children.find(child => child.type === 'export_clause')
    const specifiers = (clause?.children ?? []).filter(child => child.type === 'export_specifier').flatMap(child => {
      const imported = nameOf(child.childForFieldName('name'))
      const exported = nameOf(child.childForFieldName('alias')) ?? imported
      return imported && exported ? [{ imported, exported }] : []
    })
    const exports = this.exportsFact()
    if (spec !== null) {
      const namespace = stmt.children.find(child => child.type === 'namespace_export')
      if (namespace) {
        const name = nameOf(namespace.children.find(child => child.type === 'identifier' || child.type === 'string'))
        if (name) exports.forwards.push({ spec, line, namespace: name })
      } else if (clause) exports.forwards.push({ spec, line, names: specifiers })
      else if (/^export\s+\*\s*from\b/.test(stmt.text)) exports.forwards.push({ spec, line, star: true })
      return
    }
    if (clause) {
      for (const item of specifiers) this.localExports.push({ local: item.imported, exported: item.exported, line })
      return
    }
    if (/^export\s+default\b/.test(stmt.text)) { exports.names.push('default'); return }
    const declared = (node: TsNode | null): string[] => {
      if (!node) return []
      if (node.type === 'ambient_declaration') return node.children.flatMap(child => declared(child))
      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        return node.children.filter(child => child.type === 'variable_declarator').flatMap(declarator => {
          const name = declarator.childForFieldName('name')
          if (!name) return []
          if (name.type === 'identifier') return [name.text]
          // Destructuring: every bound identifier is exported.
          return [...name.descendantsOfType('identifier'), ...name.descendantsOfType('shorthand_property_identifier_pattern')]
            .filter(id => id.parent?.type !== 'pair_pattern' || id.parent.childForFieldName('value') === id).map(id => id.text)
        })
      }
      const name = node.childForFieldName('name')
      return name && (name.type === 'identifier' || name.type === 'type_identifier') ? [name.text] : []
    }
    for (const name of declared(stmt.childForFieldName('declaration'))) if (!exports.names.includes(name)) exports.names.push(name)
  }

  /** `const { invoke, send: s } = require('spec')` / `const bridge = require('spec')`. */
  private scanRequireBinding(name: TsNode, value: TsNode): void {
    if (value.type !== 'call_expression') return
    const callee = calleeOf(value)
    if (callee?.type !== 'identifier' || callee.text !== 'require') return
    const spec = literalString(argsOf(value)[0])
    if (spec === null) return
    if (name.type === 'identifier') {
      this.addBinding({ local: name.text, spec, imported: null })
      return
    }
    if (name.type !== 'object_pattern') return
    for (const child of name.children) {
      if (child.type === 'shorthand_property_identifier_pattern') {
        this.addBinding({ local: child.text, spec, imported: child.text })
      } else if (child.type === 'pair_pattern') {
        const key = child.childForFieldName('key')
        const target = child.childForFieldName('value')
        const imported = key === null ? null : key.type === 'string' ? literalString(key) : key.text
        if (imported && target?.type === 'identifier') this.addBinding({ local: target.text, spec, imported })
      }
    }
  }

  /** `import { a, b as c } from 'spec'` / `import * as ns from 'spec'` / `import d from 'spec'`. */
  private scanImportBindings(stmt: TsNode): void {
    const spec = literalString(stmt.childForFieldName('source'))
    if (spec === null) return
    const clause = stmt.children.find((c) => c.type === 'import_clause')
    if (!clause) return
    const visit = (node: TsNode): void => {
      if (node.type === 'import_specifier') {
        const name = node.childForFieldName('name')
        const alias = node.childForFieldName('alias')
        const imported = name?.type === 'string' ? literalString(name) : name?.text ?? null
        const local = alias?.text ?? imported
        if (imported && local) this.addBinding({ local, spec, imported })
        return
      }
      if (node.type === 'namespace_import') {
        const id = node.children.find((c) => c.type === 'identifier')
        if (id) this.addBinding({ local: id.text, spec, imported: null })
        return
      }
      if (node.type === 'identifier' && node.parent?.type === 'import_clause') {
        this.addBinding({ local: node.text, spec, imported: null })
        return
      }
      for (const child of node.children) visit(child)
    }
    visit(clause)
  }

  private addBinding(binding: ModuleBindingFact): void {
    if (this.bindings.has(binding.local)) return
    this.bindings.set(binding.local, binding)
    this.out.bindings.push(binding)
  }

  /** const NAME = 'lit' | Object.freeze({k: 'lit'}) | {k: 'lit'} | window.Y (alias). */
  private scanConstValue(name: string, value: TsNode, line: number, topLevel: boolean): void {
    if (value.type === 'string' || value.type === 'template_string') {
      const lit = literalString(value)
      if (lit !== null) this.consts.set(name, lit)
      return
    }
    if (value.type === 'call_expression') {
      const callee = calleeOf(value)
      if (callee?.text === 'Object.freeze' || callee?.text === 'Object.seal') {
        const arg = argsOf(value)[0]
        if (arg) this.scanConstValue(name, arg, line, topLevel)
      }
      return
    }
    if (value.type === 'object') {
      this.constShapes.set(name, this.objectShape(value)!)
      for (const pair of value.children.filter((c) => c.type === 'pair')) {
        const key = pair.childForFieldName('key')
        const pairValue = pair.childForFieldName('value')
        if (!key || !pairValue) continue
        const lit = literalString(pairValue)
        if (lit !== null && (key.type === 'property_identifier' || key.type === 'identifier' || key.type === 'string')) {
          const keyName = key.type === 'string' ? literalString(key) : key.text
          if (keyName) this.consts.set(`${name}.${keyName}`, lit)
        }
      }
      return
    }
    // `const api = window.chatAPI || window.electronAPI` — bridge alias.
    // Recorded at any scope so IIFE-local aliases (`const api = window.x`
    // inside a renderer closure) still map member accesses back to the global.
    this.recordBridgeAlias(name, value, line, topLevel)
  }

  private recordBridgeAlias(name: string, value: TsNode, line: number, topLevel: boolean): void {
    const first = /(?:window|globalThis)\.([A-Za-z_$][\w$]*)/.exec(value.text)
    const object = first?.[1]
    if (object && ['binary_expression', 'member_expression', 'await_expression', 'parenthesized_expression', 'identifier'].includes(value.type)) {
      if (this.out.bridgeAliases.some(alias => alias.name === name && alias.line === line && alias.object === object)) return
      this.out.bridgeAliases.push({ name, object, line, topLevel })
    } else if (value.type === 'identifier') {
      const inherited = this.out.bridgeAliases.find(alias => alias.name === value.text && alias.line !== line)?.object
      if (inherited) {
        if (this.out.bridgeAliases.some(alias => alias.name === name && alias.line === line && alias.object === inherited)) return
        this.out.bridgeAliases.push({ name, object: inherited, line, topLevel })
        return
      }
      const shape = this.constShapes.get(value.text)
      if (shape) this.constShapes.set(name, shape)
    }
  }

  /**
   * Member names of an exposed object when statically knowable: object
   * literals, `Object.freeze/seal/assign(...)`, and identifiers bound to any
   * of those by a top-level const (`const chartAPI = Object.freeze({...})`).
   * `complete: false` means a spread hid members, so the list is a lower bound.
   */
  private objectShape(node: TsNode | null): { keys: string[]; complete: boolean } | null {
    if (!node) return null
    if (node.type === 'parenthesized_expression') {
      const inner = node.children.find((c) => c.type !== '(' && c.type !== ')')
      return inner ? this.objectShape(inner) : null
    }
    if (node.type === 'object') {
      const keys: string[] = []
      let complete = true
      for (const entry of node.children) {
        if (entry.type === 'pair') {
          const key = entry.childForFieldName('key')
          const name = key === null ? null : key.type === 'string' ? literalString(key) : key.text
          if (name === null) complete = false
          else keys.push(name)
        } else if (entry.type === 'shorthand_property_identifier' || entry.type === 'shorthand_property_identifier_pattern') {
          keys.push(entry.text)
        } else if (entry.type === 'method_definition') {
          const name = entry.childForFieldName('name')
          if (name) keys.push(name.text)
        } else if (entry.type === 'spread_element') {
          complete = false
        }
      }
      return { keys, complete }
    }
    if (node.type === 'call_expression') {
      const method = calleeOf(node)?.type === 'member_expression' ? propertyName(calleeOf(node)!) : null
      if (method === 'freeze' || method === 'seal') return this.objectShape(argsOf(node)[0] ?? null)
      if (method === 'assign') {
        const parts = argsOf(node).map((arg) => this.objectShape(arg))
        if (parts.length === 0 || parts.some((part) => part === null)) return null
        const keys: string[] = []
        for (const part of parts) for (const key of part!.keys) if (!keys.includes(key)) keys.push(key)
        return { keys, complete: parts.every((part) => part!.complete) }
      }
      return null
    }
    if (node.type === 'identifier') return this.constShapes.get(node.text) ?? null
    return null
  }

  // ---- pass 2: wrapper definitions (ipc passthrough bodies) ---------------

  private scanWrappers(root: TsNode): void {
    if (!this.hasIpcSyntax) return
    // Only calls can define a forwarding wrapper. Let WASM find them without
    // materializing and walking the entire tree once just for this pass.
    for (const node of root.descendantsOfType('call_expression')) {
      const cls = this.classifyCallee(calleeOf(node))
      if (!cls) continue
      const arg0 = argsOf(node)[0]
      if (arg0?.type !== 'identifier') continue
      const ancestors: TsNode[] = []
      for (let parent = node.parent; parent; parent = parent.parent) ancestors.push(parent)
      let ctx = TOP_CTX
      for (let index = ancestors.length - 1; index >= 0; index--) ctx = this.descend(ancestors[index], ctx)
      if (ctx.owner && ctx.params?.has(arg0.text) && !this.wrappers.has(ctx.owner)) {
        this.wrappers.set(ctx.owner, cls)
      }
    }
  }

  private classifyCallee(callee: TsNode | null): WrapperDef | null {
    if (!callee || callee.type !== 'member_expression') return null
    const prop = propertyName(callee)
    const obj = objectText(callee)
    if (!prop) return null
    if (obj && IPC_MAIN.test(obj) && REGISTER_METHODS.includes(prop)) return { side: 'register', method: prop }
    if (obj && IPC_RENDERER.test(obj)) return { side: 'call', method: prop }
    if (prop === 'send') {
      const objNode = callee.childForFieldName('object')
      if (objNode?.type === 'member_expression' && propertyName(objNode) === 'webContents') return { side: 'push', method: 'send' }
    }
    return null
  }

  // ---- pass 3: full fact walk ----------------------------------------------

  private walk(node: TsNode, ctx: WalkCtx, bridge: ReadonlySet<string> | null): void {
    if (node.type === 'comment') return

    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name')
      const value = node.childForFieldName('value')
      if (name?.type === 'identifier' && value) {
        this.recordBridgeAlias(name.text, value, node.startPosition.row + 1, false)
      }
    }

    // Electron preload wiring (see PreloadFact).
    if (node.type === 'pair') {
      const key = node.childForFieldName('key')
      if (key?.type === 'property_identifier' && key.text === 'preload') {
        const fact = this.preloadFact(node.childForFieldName('value'))
        if (fact) (this.out.preloads ??= []).push(fact)
      }
    }

    // Import/re-export edges.
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const equals = node.children.find(child => child.type === 'import_require_clause')
      const source = node.childForFieldName('source') ?? equals?.childForFieldName('source')
      if (source) {
        const spec = literalString(source)
        if (spec !== null) (equals ? this.out.requires : this.out.imports).push({ spec, line: node.startPosition.row + 1, ...(equals ? { importEquals: true as const } : {}) })
      }
    }

    if (isCall(node)) {
      const callee = calleeOf(node)
      this.recordIpcCall(node, ctx)
      // require(spec) — plain call; import(spec) — the callee node IS the
      // `import` keyword (type "import"), not an identifier.
      const dynamicImport = callee?.type === 'import'
      if (dynamicImport || (callee?.type === 'identifier' && callee.text === 'require')) {
        const spec = literalString(argsOf(node)[0])
        if (spec !== null) this.out.requires.push({ spec, line: node.startPosition.row + 1, ...(dynamicImport ? { dynamic: true } : {}) })
        else {
          const arg = argsOf(node)[0]
          if (arg) this.out.requires.push({ spec: truncate(arg.text), line: node.startPosition.row + 1, dynamic: true, unresolved: true })
        }
        return
      }
    }

    // Named function scope for the children.
    const inner = this.descend(node, ctx)

    // window.X = … definitions (walk on into the right-hand side).
    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName('left')
      if (left?.type === 'member_expression') {
        const obj = objectText(left)
        if (obj === 'window' || obj === 'globalThis') {
          const name = propertyName(left)
          if (name) this.out.globalsDefined.push({ name, how: 'window', line: node.startPosition.row + 1, symbol: ctx.owner ?? undefined })
        }
      }
    }

    if (node.type === 'member_expression') {
      this.recordMember(node, ctx, bridge)
    }

    // `name: <wrapper>('channel')` — the preload API key → channel pair, read
    // from source so `api:<name>` works without a declaration file.
    if (node.type === 'pair') {
      const value = node.childForFieldName('value')
      const call = value ? this.wrapperCallWithin(value) : null
      if (call !== null) {
        const key = node.childForFieldName('key')
        const name = key === null
          ? null
          : key.type === 'string' ? literalString(key) : key.type === 'property_identifier' || key.type === 'identifier' ? key.text : null
        const resolved = this.resolveChannel(argsOf(call.call)[0])
        if (name !== null && resolved) {
          this.out.namedEntries.push({
            name, channel: resolved.value, line: node.startPosition.row + 1,
            symbol: ctx.owner ?? undefined, spec: call.spec, wrapper: call.wrapper,
          })
        }
      }
    }

    // contextBridge.exposeInMainWorld('name', value) — literal name or a
    // role-global variable; keys resolved through the file's const shapes.
    if (isCall(node)) {
      const callee = calleeOf(node)
      if (callee?.type === 'member_expression' && propertyName(callee) === 'exposeInMainWorld') {
        const args = argsOf(node)
        const literal = literalString(args[0])
        const identifier = args[0]?.type === 'identifier' ? args[0].text : null
        const name = literal ?? identifier
        if (name !== null) {
          const table = args[1] ?? null
          const shape = this.objectShape(table)
          const known = shape !== null && (shape.keys.length > 0 || table?.type === 'object')
          this.out.exposes.push({
            name,
            keys: shape?.keys ?? [],
            line: node.startPosition.row + 1,
            ...(literal === null ? { dynamic: true } : {}),
            ...(known ? { keySource: table?.type === 'identifier' ? 'identifier' : 'literal' } : {}),
            ...(shape && !shape.complete ? { partial: true } : {}),
          })
        }
      }
    }

    for (const child of node.children) this.walk(child, inner, bridge)
  }

  /** Scope context for the children of `node` (named functions and arrow consts). */
  private descend(node: TsNode, ctx: WalkCtx): WalkCtx {
    if (node.type === 'function_declaration' || node.type === 'generator_function_declaration' || node.type === 'method_definition') {
      const name = node.childForFieldName('name')
      return { owner: name ? name.text : ctx.owner, params: this.functionParams(node) }
    }
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name')
      const value = node.childForFieldName('value')
      if (name?.type === 'identifier' && value && FUNCTION_NODES.has(value.type)) {
        return { owner: name.text, params: this.functionParams(value) }
      }
    }
    return ctx
  }

  private functionParams(node: TsNode): ReadonlySet<string> {
    const params = node.childForFieldName('parameters')
    const names = new Set<string>()
    if (!params) return names
    const collect = (param: TsNode): void => {
      if (param.type === 'identifier' || param.type === 'shorthand_property_identifier_pattern') names.add(param.text)
      else for (const child of param.children) collect(child)
    }
    for (const child of params.children) if (child.isNamed) collect(child)
    return names
  }

  private recordMember(node: TsNode, ctx: WalkCtx, bridge: ReadonlySet<string> | null): void {
    const obj = objectText(node)
    if (!obj) return
    // Assignment LHS is a definition site, not a use (handled by the
    // assignment branch); never double-record it.
    const parent = node.parent
    if (parent?.type === 'assignment_expression' && parent.childForFieldName('left')?.id === node.id) return
    if (obj === 'window' || obj === 'globalThis') {
      const name = propertyName(node)
      if (name) {
        const key = `${name}:${node.startPosition.row}`
        if (!this.usedSeen.has(key)) {
          this.usedSeen.add(key)
          this.out.globalsUsed.push({ name, line: node.startPosition.row + 1, symbol: ctx.owner ?? undefined })
        }
      }
      return
    }
    const base = stripWindowPrefix(obj)
    if ((bridge === null || bridge.has(base)) && /^[\w$]+$/.test(base)) {
      const name = propertyName(node)
      if (name) this.out.bridge.push({ object: base, name, line: node.startPosition.row + 1, symbol: ctx.owner ?? undefined })
    }
  }

  private recordIpcCall(node: TsNode, ctx: WalkCtx): void {
    const callee = calleeOf(node)
    if (!callee) return

    // Call through a same-file wrapper: real channel comes from the argument.
    if (callee.type === 'identifier' && this.wrappers.has(callee.text)) {
      const def = this.wrappers.get(callee.text)!
      const resolved = this.resolveChannel(argsOf(node)[0])
      if (resolved) {
        this.wrapperCallSites.set(callee.text, (this.wrapperCallSites.get(callee.text) ?? 0) + 1)
        this.out.ipc.push({ side: def.side, method: def.method, channel: resolved.value, via: 'wrapper', line: node.startPosition.row + 1, symbol: ctx.owner ?? undefined })
      }
      return
    }

    // Call through a wrapper imported from another module: hold the edge until
    // the graph has that module's wrapper table (cross-file wrappers are the
    // norm in Electron preload trees — `invoke()` lives in the bridge module).
    if (callee.type === 'identifier' && this.bindings.has(callee.text)) {
      const binding = this.bindings.get(callee.text)!
      const resolved = this.resolveChannel(argsOf(node)[0])
      if (resolved) {
        this.out.deferredCalls.push({
          local: binding.local,
          spec: binding.spec,
          imported: binding.imported,
          line: node.startPosition.row + 1,
          symbol: ctx.owner ?? undefined,
          channel: resolved.value,
          via: resolved.via,
        })
      }
    }

    if (!this.hasIpcSyntax) return
    const cls = this.classifyCallee(callee)
    if (!cls) return
    const args = argsOf(node)
    const resolved = this.resolveChannel(args[0])
    const fact: IpcFact = {
      side: cls.side, method: cls.method,
      channel: resolved ? resolved.value : null,
      via: resolved ? resolved.via : 'dynamic',
      line: node.startPosition.row + 1,
      symbol: ctx.owner ?? undefined,
    }
    if (!resolved) {
      fact.expr = args[0] ? truncate(args[0].text) : '…'
      // Passthrough inside a wrapper: the real channel arrives from the
      // wrapper's call sites (PF rule ③).
      if (ctx.owner && ctx.params && args[0]?.type === 'identifier' && ctx.params.has(args[0].text)) {
        fact.via = 'param'
        fact.channel = args[0].text
        if (!this.wrappers.has(ctx.owner)) this.wrappers.set(ctx.owner, { side: cls.side, method: cls.method })
        this.paramCalls.push({ fact, wrapper: ctx.owner })
      }
    }
    this.out.ipc.push(fact)
  }

  /**
   * Innermost call in a value expression whose callee is a known wrapper —
   * `invoke('ch')`, `invoke('ch').roles(...)`, `invoke('ch').mapResult(fn)`.
   * `spec` is null for same-file wrappers, else the import specifier.
   */
  private wrapperCallWithin(value: TsNode): { call: TsNode; spec: string | null; wrapper: string } | null {
    let current: TsNode | null = value
    for (let depth = 0; current && depth < 8; depth++) {
      if (!isCall(current)) return null
      const callee = calleeOf(current)
      if (callee?.type === 'identifier') {
        if (this.wrappers.has(callee.text)) return { call: current, spec: null, wrapper: callee.text }
        const binding = this.bindings.get(callee.text)
        if (binding) return { call: current, spec: binding.spec, wrapper: binding.imported ?? binding.local }
        return null
      }
      const object = callee?.type === 'member_expression' ? callee.childForFieldName('object') : null
      current = object?.type === 'call_expression' ? object : null
    }
    return null
  }

  /** literal > same-file const table; anything else stays unresolved here. */
  private resolveChannel(arg: TsNode | undefined): { value: string; via: 'literal' | 'const' } | null {
    const lit = literalString(arg)
    if (lit !== null) return { value: lit, via: 'literal' }
    if (!arg) return null
    if (arg.type === 'identifier') {
      const value = this.consts.get(arg.text)
      if (value !== undefined) return { value, via: 'const' }
      return null
    }
    if (arg.type === 'member_expression') {
      const normalized = arg.text.replace(/\[\s*(['"])([^'"\]]+)\1\s*\]/g, '.$2')
      const value = this.consts.get(normalized)
      if (value !== undefined) return { value, via: 'const' }
    }
    return null
  }

  /**
   * Preload wiring value: a literal path, a const-table identifier/member, or
   * a helper call whose literal pieces reconstruct the path — path.join of
   * literals stays certain; a bare role token (last piece) resolves by the
   * preloads/<role>.js convention downstream and is only ever a candidate.
   */
  private preloadFact(value: TsNode | null): PreloadFact | null {
    if (!value) return null
    const line = value.startPosition.row + 1
    const looksPath = (text: string): boolean => text.includes('/') || /\.(?:[cm]?js|jsx)$/.test(text)
    const lit = literalString(value)
    if (lit !== null && lit.trim() !== '') {
      const clean = lit.trim()
      return { spec: clean, line, ...(looksPath(clean) ? { literal: true } : {}) }
    }
    const resolved = this.resolveChannel(value)
    if (resolved && resolved.value.trim() !== '') return { spec: resolved.value.trim(), line }
    // An unresolved identifier/member keeps its name: the defining table may
    // live in another module (`const { PRELOAD_ROLES } = require(...)`), and
    // the link graph can retry against every file's exported const table.
    if (value.type === 'identifier' || value.type === 'member_expression') {
      const normalized = value.text.replace(/\[\s*(['"])([^'"\]]+)\1\s*\]/g, '.$2').trim()
      if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(normalized)) return { spec: normalized, line, externalRef: true }
    }
    if (value.type === 'call_expression') {
      const pieces: string[] = []
      for (const arg of argsOf(value)) {
        const piece = literalString(arg)
          ?? (arg.type === 'identifier' || arg.type === 'member_expression'
            ? this.resolveChannel(arg)?.value ?? null : null)
        if (piece !== null && piece.trim() !== '') pieces.push(piece.trim())
      }
      if (!pieces.length) {
        // helper(root, PRELOAD_ROLES.CHART) — the role may only resolve via
        // another module's const table; retry the last name-like argument.
        for (const arg of [...argsOf(value)].reverse()) {
          if (arg.type !== 'identifier' && arg.type !== 'member_expression') continue
          const normalized = arg.text.replace(/\[\s*(['"])([^'"\]]+)\1\s*\]/g, '.$2').trim()
          if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(normalized)) return { spec: normalized, line, externalRef: true }
        }
        return null
      }
      if (pieces.some(looksPath)) return { spec: pieces.join('/').replace(/\/+/g, '/'), line, literal: true }
      return { spec: pieces[pieces.length - 1], line }
    }
    return null
  }
}

/** Extract script facts or conventional module dependencies from a parsed tree. */
export function extractFacts(tree: TsTree, lang: LangName, bridgeGlobals: readonly string[] | null): FileFacts {
  if (supportsModuleFacts(lang)) {
    const cpp = lang === 'cpp' ? cppModules(tree.rootNode.text) : undefined
    const moduleInfo = cpp?.info ?? extractModuleInfo(tree, lang)
    const ffi = extractFfiFacts(tree, lang)
    const modules = [...extractModuleFacts(tree, lang), ...(cpp?.modules ?? []), ...(lang === 'go' ? cgoIncludes(tree) : [])]
    return { ...emptyFacts(), modules: modules.sort((a, b) => a.line - b.line), ...(moduleInfo ? { moduleInfo } : {}), ...(ffi.length ? { ffi } : {}) }
  }
  if (!JS_FAMILY.has(lang)) return emptyFacts()
  return new FactsCollector().collect(tree, bridgeGlobals === null ? null : new Set(bridgeGlobals))
}

/** Top-level bridge alias names across a facts map (bridge-globals extension). */
export function topLevelAliasNames(files: Iterable<{ facts: FileFacts | null }>): string[] {
  const names = new Set<string>()
  for (const file of files) {
    if (!file.facts) continue
    for (const alias of file.facts.bridgeAliases) if (alias.topLevel) names.add(alias.name)
  }
  return [...names]
}
