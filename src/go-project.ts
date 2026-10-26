/**
 * Go modules from go.mod and go.work: module paths, local-path replace
 * directives and workspace `use` lists. Reads files as data; never runs go.
 */
import path from 'node:path'
import { metadataReader } from './metadata-reader.ts'
import { localPath } from './source-resolution.ts'
import type { ProjectContext, TraceDiagnostic } from './trace-evidence.ts'

/** `replace old [v] => ./dir [v]`: only local-path targets; version replacements stay external. */
export interface GoReplace { from: string; dir: string; source: string }
export interface GoModule { dir: string; path: string | null; replaces: GoReplace[] }
export interface GoWorkspace { file: string; dir: string; uses: string[]; replaces: GoReplace[] }
export interface GoModules { modules: GoModule[]; workspaces: GoWorkspace[] }
export interface GoProject extends ProjectContext, GoModules { issues: TraceDiagnostic[] }

export const goMetadata = (name: string): boolean => name === 'go.mod' || name === 'go.work'

/** Directives with block syntax (`replace ( … )`), quoted tokens and // comments. */
export function goDirectives(text: string): Array<{ verb: string; args: string[]; line: number }> {
  const out: Array<{ verb: string; args: string[]; line: number }> = []
  let block: string | null = null
  text.split(/\r?\n/).forEach((raw, index) => {
    const tokens: string[] = []
    for (const match of raw.matchAll(/"(?:[^"\\]|\\.)*"|`[^`]*`|\S+/g)) {
      if (match[0].startsWith('//')) break
      tokens.push(match[0].startsWith('"') ? match[0].slice(1, -1).replace(/\\(.)/g, '$1') : match[0].startsWith('`') ? match[0].slice(1, -1) : match[0])
    }
    if (!tokens.length) return
    if (block !== null) {
      if (tokens[0] === ')') { block = null; return }
      out.push({ verb: block, args: tokens, line: index + 1 })
    } else if (tokens[1] === '(' && tokens.length === 2) block = tokens[0]
    else out.push({ verb: tokens[0], args: tokens.slice(1), line: index + 1 })
  })
  return out
}

export function loadGoProject(root: string, files: readonly string[], signal?: AbortSignal): GoProject {
  const { read, issues, signature } = metadataReader(root, 'Go', signal)
  const modules: GoModule[] = [], workspaces: GoWorkspace[] = []
  for (const file of files) {
    const text = read(file)
    if (text === null) continue
    const dir = path.posix.dirname(file)
    const replaces: GoReplace[] = [], uses: string[] = []
    let modulePath: string | null = null, declarations = 0
    for (const { verb, args, line } of goDirectives(text)) {
      if (verb === 'module') { declarations++; modulePath = args.length === 1 ? args[0] : null }
      else if (verb === 'use') {
        const target = args.length === 1 ? localPath(dir, args[0]) : null
        if (target === null) issues.push({ path: file, line, reason: 'unsupported_config', message: `use 目标不是扫描根内的相对路径：${args.join(' ')}` })
        else if (!uses.includes(target)) uses.push(target)
      } else if (verb === 'replace') {
        const arrow = args.indexOf('=>')
        const to = arrow > 0 ? args[arrow + 1] : undefined
        if (to === undefined) { issues.push({ path: file, line, reason: 'unsupported_config', message: 'replace 指令格式无法识别。' }); continue }
        if (!/^\.\.?(?:\/|$)/.test(to)) continue // module replacement by version: external
        const target = localPath(dir, to)
        if (target === null) { issues.push({ path: file, line, reason: 'unsupported_config', message: `replace 目标越出扫描根：${to}` }); continue }
        replaces.push({ from: args[0], dir: target, source: `${file}:${line}` })
      }
    }
    if (path.posix.basename(file) === 'go.work') workspaces.push({ file, dir, uses, replaces })
    else modules.push({ dir, path: declarations === 1 ? modulePath : null, replaces })
  }
  modules.sort((a, b) => a.dir.localeCompare(b.dir))
  workspaces.sort((a, b) => a.file.localeCompare(b.file))
  return { modules, workspaces, issues, signature: signature([modules, workspaces]), valid: () => true }
}
