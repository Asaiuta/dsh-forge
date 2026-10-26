/** Bridge-independent per-file extraction shared by the main thread and AST workers. */
import path from 'node:path'
import { fileFacts, factsFromText, MAX_AST_FILE_BYTES, normalizeText } from './ast.ts'
import { readBoundedFile } from './fs-paths.ts'
import { emptyFacts, mergeFacts, scanComponentScripts, scanHtmlFacts, type FileFacts, type RequireFact, type TraceFileFacts } from './facts.ts'
import { supportsModuleFacts } from './module-facts.ts'
import { binaryFacts, BINARY_EXTENSIONS, MAX_BINARY_BYTES } from './binary-facts.ts'
import type { JsSyntax, TraceDiagnostic } from './trace-evidence.ts'

export interface TraceFileOutcome {
  value: TraceFileFacts | null
  parseErrors: number
  partialFiles: number
  diagnostics?: Array<Omit<TraceDiagnostic, 'path'>>
}

export async function extractTraceFile(file: string): Promise<TraceFileOutcome> {
  try {
    if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      const metadata = binaryFacts(readBoundedFile(file, MAX_BINARY_BYTES))
      return { value: { kind: 'binary', metadata }, parseErrors: 0, partialFiles: Number(metadata.limitations.length > 0) }
    }
    if (path.basename(file) === 'go.mod') {
      const text = normalizeText(readBoundedFile(file, MAX_AST_FILE_BYTES).toString('utf8'))
      const declarations = [...text.matchAll(/^\s*module\s+(?:"([^"\r\n]+)"|([^\s]+))\s*(?:\/\/.*)?$/gm)]
      const module = declarations.length === 1 ? declarations[0][1] ?? declarations[0][2] : null
      return { value: { kind: 'manifest', module }, parseErrors: 0, partialFiles: module ? 0 : 1 }
    }
    if (path.extname(file).toLowerCase() !== '.html') {
      const ext = path.extname(file).toLowerCase()
      const framework = ext === '.vue' ? 'vue' : ext === '.svelte' ? 'svelte' : null
      if (framework) {
        // Components expose script dependencies only; scopes stay separate.
        const text = normalizeText(readBoundedFile(file, MAX_AST_FILE_BYTES).toString('utf8'))
        const scripts: Array<{ syntax: JsSyntax; imports: RequireFact[]; requires: RequireFact[] }> = []
        let parseErrors = 0
        let partial = false
        for (const block of scanComponentScripts(text)) {
          const group = { syntax: block.syntax, imports: [] as RequireFact[], requires: [] as RequireFact[] }
          if (block.src !== undefined) group.requires.push({ spec: block.src, line: block.line, componentSrc: true })
          else if (block.text !== undefined && block.text.trim() !== '') {
            const parsed = await factsFromText(block.text, null, block.syntax)
            if (!parsed) parseErrors++
            else {
              partial ||= parsed.partial
              const offset = block.line - 1
              group.imports.push(...parsed.facts.imports.map(ref => ({ ...ref, line: ref.line + offset })))
              group.requires.push(...parsed.facts.requires.map(ref => ({ ...ref, line: ref.line + offset })))
            }
          }
          scripts.push(group)
        }
        return { value: { kind: 'component', framework, scripts }, parseErrors, partialFiles: Number(partial) }
      }
      // The workspace cache already validated stat/ctime. On a miss, hash the
      // bytes so a same-size edit with restored mtime cannot hit an older parse.
      const parsed = await fileFacts(file, null)
      if (!parsed.value) return { value: null, parseErrors: 1, partialFiles: 0, diagnostics: [{ reason: 'parse_failed', message: parsed.error ?? 'AST 未返回解析结果。' }] }
      if (supportsModuleFacts(parsed.value.lang)) {
        const { modules = [], moduleInfo, ffi } = parsed.value.facts
        return { value: { kind: 'source', lang: parsed.value.lang, modules, ...(moduleInfo ? { moduleInfo } : {}), ...(ffi ? { ffi } : {}) }, parseErrors: 0, partialFiles: Number(parsed.value.partial) }
      }
      return { value: { kind: 'js', lang: parsed.value.lang, ...parsed.value.facts }, parseErrors: 0, partialFiles: Number(parsed.value.partial) }
    }
    const html = scanHtmlFacts(normalizeText(readBoundedFile(file, MAX_AST_FILE_BYTES).toString('utf8')))
    let merged: FileFacts | undefined
    let parseErrors = 0
    let partial = false
    for (const body of html.inline) {
      const parsed = await factsFromText(body.text, null)
      if (!parsed) { parseErrors++; continue }
      partial ||= parsed.partial
      merged ??= emptyFacts()
      const scoped = emptyFacts()
      mergeFacts(scoped, parsed.facts, body.line - 1)
      if (body.module) scoped.globalsDefined = scoped.globalsDefined.filter(def => def.how === 'window')
      for (const ref of [...scoped.requires, ...scoped.imports]) ref.scriptIndex = body.scriptIndex
      mergeFacts(merged, scoped, 0)
    }
    return { value: merged ? { ...html, facts: merged } : html, parseErrors, partialFiles: Number(partial) }
  } catch (cause) {
    return { value: null, parseErrors: 1, partialFiles: 0, diagnostics: [{ reason: 'read_or_parse_failed', message: cause instanceof Error ? cause.message : String(cause) }] }
  }
}

/** Resolve bridge membership after discovering all aliases, without parsing
 *  source again. Per-file aliases retain the extractor's existing semantics. */
export function selectBridgeFacts(entry: TraceFileFacts, globals: readonly string[]): TraceFileFacts {
  if (entry.kind === 'source' || entry.kind === 'manifest' || entry.kind === 'binary') return entry
  // Components expose dependencies only; their script scopes carry no bridge facts.
  if (entry.kind === 'component') return entry
  const facts = entry.kind === 'js' ? entry : entry.facts
  if (!facts) return entry
  const effective = new Set([...globals, ...facts.bridgeAliases.map(alias => alias.name)])
  const bridge = facts.bridge.filter(ref => effective.has(ref.object))
  return entry.kind === 'js' ? { ...entry, bridge } : { ...entry, facts: { ...facts, bridge } }
}
