/**
 * Resolver registry for non-JavaScript module facts. Each language owns one
 * resolver; every answer is explicit — resolved targets, an unresolved reason,
 * or not_applicable for facts owned by another language.
 */
import path from 'node:path'
import type { TraceFileFacts } from './facts.ts'
import type { ModuleFact } from './module-facts.ts'
import type { IncludeResolver } from './compile-commands.ts'
import type { UnresolvedReason } from './trace-evidence.ts'
import type { PythonRoots } from './python-project.ts'
import type { RustCrates } from './rust-project.ts'
import type { GoModules } from './go-project.ts'
import { javaResolver } from './java-resolution.ts'
import { goResolver } from './go-resolution.ts'
import { rustResolver } from './rust-resolution.ts'
import { luaResolver } from './lua-resolution.ts'
import { pythonResolver } from './python-resolution.ts'
import { nativeResolver } from './native-resolution.ts'

export interface ResolvedModule { to: string; candidate?: true }
export type SourceResolution =
  | { status: 'resolved'; targets: ResolvedModule[] }
  | { status: 'unresolved'; reason: UnresolvedReason; detail?: string }
  | { status: 'not_applicable' }
export type SourceResolver = (from: string, ref: ModuleFact) => SourceResolution

export interface SourceContext {
  entries: Map<string, TraceFileFacts>
  isFile: (rel: string) => boolean
  includeResolver?: IncludeResolver
  /** A workspace index hit its budget; inferences it would have made stop. */
  onLimit?: () => void
  /** Package roots from pyproject.toml / setup.cfg and layout conventions. */
  python?: PythonRoots
  /** Crate names, declared target roots and path dependencies from Cargo.toml. */
  rust?: RustCrates
  /** Module paths, local replaces and workspace use lists from go.mod / go.work. */
  go?: GoModules
}

export const NOT_APPLICABLE: SourceResolution = { status: 'not_applicable' }
export const resolvedTo = (targets: ResolvedModule[]): SourceResolution => ({ status: 'resolved', targets })
export const unresolvedAs = (reason: UnresolvedReason, detail?: string): SourceResolution =>
  ({ status: 'unresolved', reason, ...(detail ? { detail } : {}) })

export function withinRoot(rel: string): boolean {
  return rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel) && !/^[a-z]:/i.test(rel)
}

export function localPath(base: string, spec: string): string | null {
  const clean = spec.replaceAll('\\', '/')
  if (!clean || path.posix.isAbsolute(clean) || /^[a-z]:/i.test(clean) || clean.includes('\0')) return null
  const rel = path.posix.normalize(path.posix.join(base, clean))
  return withinRoot(rel) ? rel : null
}

export function sourceResolver(context: SourceContext): SourceResolver {
  const resolvers = [javaResolver(context), goResolver(context), rustResolver(context), luaResolver(context), pythonResolver(context), nativeResolver(context)]
  return (from, ref) => {
    for (const resolve of resolvers) {
      const result = resolve(from, ref)
      if (result.status !== 'not_applicable') return result
    }
    return unresolvedAs('unsupported_resolution', `没有解析器处理 ${ref.kind}。`)
  }
}
