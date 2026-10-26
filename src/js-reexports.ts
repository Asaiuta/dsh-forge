/**
 * Follow ES re-export chains from a named import to the file that defines the
 * name. Conservative by ES semantics: `export *` never forwards default, a
 * name provided by several star targets is excluded, and an unknown export
 * table anywhere on the path stops the search rather than guessing.
 */
import type { TraceFileFacts } from './facts.ts'
import { scriptFacts } from './facts.ts'

const MAX_HOPS = 8

export interface NamedImport { from: string; line: number; to: string; names: readonly string[] }
export interface ReexportEdge { from: string; line: number; to: string; names: string[]; via: string[] }

type Lookup = { status: 'found'; file: string; via: string[] } | { status: 'absent' } | { status: 'unknown' }
const ABSENT: Lookup = { status: 'absent' }
const UNKNOWN: Lookup = { status: 'unknown' }

/** specTarget: the single file an ES import specifier resolved to (null/undefined: none or ambiguous). */
export function reexportEdges(entries: Map<string, TraceFileFacts>, specTarget: (file: string, spec: string) => string | null | undefined,
  imports: readonly NamedImport[]): ReexportEdge[] {
  const memo = new Map<string, Lookup>()
  const lookup = (file: string, name: string, depth: number, active: Set<string>): Lookup => {
    const key = `${file}\0${name}`
    const cached = memo.get(key)
    if (cached) return cached
    if (active.has(key) || depth > MAX_HOPS) return UNKNOWN
    const exports = (() => { const entry = entries.get(file); return entry ? scriptFacts(entry)?.moduleExports : undefined })()
    if (!exports) return UNKNOWN // CommonJS, non-JS, unparsed or outside the scan
    const next = new Set(active).add(key)
    const follow = (spec: string, imported: string): Lookup => {
      const target = specTarget(file, spec)
      if (!target) return UNKNOWN
      const result = lookup(target, imported, depth + 1, next)
      return result.status === 'found' ? { status: 'found', file: result.file, via: [file, ...result.via] } : result
    }
    const result = ((): Lookup => {
      if (exports.names.includes(name)) return { status: 'found', file, via: [] }
      if (exports.opaque?.includes(name)) return UNKNOWN
      for (const forward of exports.forwards) {
        if (forward.namespace === name) {
          const target = specTarget(file, forward.spec)
          return target ? { status: 'found', file: target, via: [file] } : UNKNOWN
        }
        const named = forward.names?.find(item => item.exported === name)
        if (named) return follow(forward.spec, named.imported)
      }
      if (name === 'default') return ABSENT
      const stars = exports.forwards.filter(forward => forward.star).map(forward => follow(forward.spec, name))
      const found = stars.filter((item): item is Extract<Lookup, { status: 'found' }> => item.status === 'found')
      // ES excludes a name exported by several star targets; with an unknown
      // star table, a sole hit cannot be proven unique.
      if (found.length === 1 && stars.every(item => item.status !== 'unknown')) return found[0]
      if (found.length > 1 || stars.some(item => item.status === 'unknown')) return UNKNOWN
      return ABSENT
    })()
    memo.set(key, result)
    return result
  }
  const out: ReexportEdge[] = []
  for (const item of imports) {
    const groups = new Map<string, { names: string[]; via: string[] }>()
    for (const name of item.names) {
      if (name.startsWith('*')) continue // namespace / default import binding: no single name to follow
      const result = lookup(item.to, name, 0, new Set())
      if (result.status !== 'found' || result.file === item.to) continue
      const key = `${result.file}\0${result.via.join('\0')}`
      const group = groups.get(key) ?? { names: [], via: result.via }
      group.names.push(name)
      groups.set(key, group)
    }
    for (const [key, group] of groups) out.push({ from: item.from, line: item.line, to: key.split('\0')[0], names: group.names, via: group.via })
  }
  return out
}
