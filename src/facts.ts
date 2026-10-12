/**
 * dsh-forge facts layer: per-file link facts for fftrace, extracted from
 * tree-sitter parse trees of the JS family plus a lightweight HTML script
 * scanner. Clean-room implementation following the fact model documented in
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

type TsNode = import('web-tree-sitter').Node
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
}

export interface ExposeFact {
  name: string
  keys: string[]
  line: number
}

export interface FileFacts {
  requires: RequireFact[]
  imports: RequireFact[]
  ipc: IpcFact[]
  bridge: BridgeFact[]
  bridgeAliases: AliasFact[]
  globalsDefined: GlobalDefFact[]
  globalsUsed: GlobalUseFact[]
  exposes: ExposeFact[]
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

export function emptyFacts(): FileFacts {
  return { requires: [], imports: [], ipc: [], bridge: [], bridgeAliases: [], globalsDefined: [], globalsUsed: [], exposes: [] }
}

/** Concatenate `source` into `target`, shifting every 1-based line by `offset`. */
export function mergeFacts(target: FileFacts, source: FileFacts, offset: number): void {
  target.requires.push(...source.requires.map(r => ({ ...r, line: r.line + offset })))
  target.imports.push(...source.imports.map(r => ({ ...r, line: r.line + offset })))
  target.ipc.push(...source.ipc.map(f => ({ ...f, line: f.line + offset })))
  target.bridge.push(...source.bridge.map(b => ({ ...b, line: b.line + offset })))
  target.bridgeAliases.push(...source.bridgeAliases.map(a => ({ ...a, line: a.line + offset })))
  target.globalsDefined.push(...source.globalsDefined.map(d => ({ ...d, line: d.line + offset })))
  target.globalsUsed.push(...source.globalsUsed.map(u => ({ ...u, line: u.line + offset })))
  target.exposes.push(...source.exposes.map(e => ({ ...e, line: e.line + offset })))
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
      const bodyLine = masked.slice(0, m.index + m[1].length).split('\n').length
      inline.push({ text: m[2], line: bodyLine, ...(module ? { module: true } : {}) })
    }
  }
  return { kind: 'html', scripts, inline }
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

class FactsCollector {
  readonly out: FileFacts = emptyFacts()
  private readonly consts = new Map<string, string>()
  private readonly wrappers = new Map<string, WrapperDef>()
  private readonly paramCalls: Array<{ fact: IpcFact; wrapper: string }> = []
  private readonly wrapperCallSites = new Map<string, number>()
  private readonly usedSeen = new Set<string>()

  collect(tree: TsTree, bridgeGlobals: ReadonlySet<string>): FileFacts {
    const root = tree.rootNode
    for (const stmt of root.children) this.scanTopLevel(stmt)
    // The file's own aliases count as bridge objects for its own accesses.
    const effective = new Set<string>(bridgeGlobals)
    for (const alias of this.out.bridgeAliases) effective.add(alias.name)
    for (const stmt of root.children) this.scanWrappers(stmt, TOP_CTX)
    for (const child of root.children) this.walk(child, TOP_CTX, effective)
    // A wrapper never called with a resolvable channel must not hide the
    // unresolved passthrough (PF parity).
    for (const record of this.paramCalls) {
      if (!this.wrapperCallSites.get(record.wrapper)) record.fact.via = 'dynamic'
    }
    return this.out
  }

  // ---- pass 1: top-level const channels, aliases, global defs -------------

  private scanTopLevel(stmt: TsNode): void {
    if (stmt.type === 'export_statement') {
      const inner = stmt.childForFieldName('declaration')
      if (inner) this.scanTopLevel(inner)
      return
    }
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
      const kind = /^\s*const\b/.test(stmt.text) ? 'const' : /^\s*let\b/.test(stmt.text) ? 'let' : 'var'
      for (const declarator of stmt.children.filter((c) => c.type === 'variable_declarator')) {
        const name = declarator.childForFieldName('name')
        const value = declarator.childForFieldName('value')
        if (!name || !value) continue
        if (kind === 'const') this.scanConstValue(name.text, value, declarator.startPosition.row + 1, true)
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
    const first = /(?:window|globalThis)\.([A-Za-z_$][\w$]*)/.exec(value.text)
    const object = first?.[1]
    if (object && ['binary_expression', 'member_expression', 'await_expression', 'parenthesized_expression', 'identifier'].includes(value.type)) {
      this.out.bridgeAliases.push({ name, object, line, topLevel })
    }
  }

  // ---- pass 2: wrapper definitions (ipc passthrough bodies) ---------------

  private scanWrappers(node: TsNode, ctx: WalkCtx): void {
    if (isCall(node)) {
      const cls = this.classifyCallee(calleeOf(node))
      const arg0 = argsOf(node)[0]
      if (cls && ctx.owner && ctx.params && arg0?.type === 'identifier' && ctx.params.has(arg0.text) && !this.wrappers.has(ctx.owner)) {
        this.wrappers.set(ctx.owner, cls)
      }
    }
    const inner = this.descend(node, ctx)
    for (const child of node.children) this.scanWrappers(child, inner)
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

  private walk(node: TsNode, ctx: WalkCtx, bridge: ReadonlySet<string>): void {
    if (node.type === 'comment') return

    // Import/re-export edges.
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const source = node.childForFieldName('source')
      if (source) {
        const spec = literalString(source)
        if (spec !== null) this.out.imports.push({ spec, line: node.startPosition.row + 1 })
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
          if (arg) this.out.requires.push({ spec: truncate(arg.text), line: node.startPosition.row + 1, dynamic: true })
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

    // contextBridge.exposeInMainWorld('name', {keys…}).
    if (isCall(node)) {
      const callee = calleeOf(node)
      if (callee?.type === 'member_expression' && propertyName(callee) === 'exposeInMainWorld') {
        const args = argsOf(node)
        const name = literalString(args[0])
        if (name !== null) {
          const keys: string[] = []
          const table = args[1]
          if (table?.type === 'object') {
            for (const entry of table.children) {
              if (entry.type === 'pair') {
                const key = entry.childForFieldName('key')
                if (key) keys.push(key.type === 'string' ? literalString(key) ?? key.text : key.text)
              } else if (entry.type === 'shorthand_property_identifier') {
                keys.push(entry.text)
              }
            }
          }
          this.out.exposes.push({ name, keys, line: node.startPosition.row + 1 })
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

  private recordMember(node: TsNode, ctx: WalkCtx, bridge: ReadonlySet<string>): void {
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
    if (bridge.has(base) && /^[\w$]+$/.test(base)) {
      const name = propertyName(node)
      if (name) this.out.bridge.push({ object: base, name, line: node.startPosition.row + 1, symbol: ctx.owner ?? undefined })
    }
  }

  private recordIpcCall(node: TsNode, ctx: WalkCtx): void {
    const callee = calleeOf(node)
    if (!callee) return
    const args = argsOf(node)

    // Call through a same-file wrapper: real channel comes from the argument.
    if (callee.type === 'identifier' && this.wrappers.has(callee.text)) {
      const def = this.wrappers.get(callee.text)!
      const resolved = this.resolveChannel(args[0])
      if (resolved) {
        this.wrapperCallSites.set(callee.text, (this.wrapperCallSites.get(callee.text) ?? 0) + 1)
        this.out.ipc.push({ side: def.side, method: def.method, channel: resolved.value, via: 'wrapper', line: node.startPosition.row + 1, symbol: ctx.owner ?? undefined })
      }
      return
    }

    const cls = this.classifyCallee(callee)
    if (!cls) return
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
}

/** Extract link facts from a parsed JS-family tree. Other languages yield empty facts. */
export function extractFacts(tree: TsTree, lang: LangName, bridgeGlobals: readonly string[]): FileFacts {
  if (!JS_FAMILY.has(lang)) return emptyFacts()
  return new FactsCollector().collect(tree, new Set(bridgeGlobals))
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
