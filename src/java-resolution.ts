/** File candidates from Java names; not javac type checking or module linking. */
import path from 'node:path'
import type { TraceFileFacts } from './facts.ts'
import type { ModuleFact, ResolvedModule } from './module-facts.ts'

export function javaResolver(entries: Map<string, TraceFileFacts>, onLimit?: () => void): (from: string, ref: ModuleFact) => ResolvedModule[] | null {
  const types = new Map<string, Set<string>>(), packages = new Map<string, string[]>(), descriptors = new Map<string, string[]>()
  const parents = new Map<string, { file: string; scope: string[]; names: string[] }>()
  const add = (map: Map<string, Set<string>>, name: string, file: string): void => { const set = map.get(name) ?? new Set(); set.add(file); map.set(name, set) }
  for (const [file, facts] of entries) if (facts.kind === 'source' && facts.lang === 'java' && facts.moduleInfo) {
    const info = facts.moduleInfo, pkg = info.package ?? '', members = packages.get(pkg) ?? []
    members.push(file); packages.set(pkg, members)
    for (const type of info.javaTypes ?? info.classes ?? []) add(types, pkg ? pkg + '.' + type : type, file)
    for (const item of info.javaParents ?? []) parents.set(pkg ? pkg + '.' + item.name : item.name, { file, scope: item.name.split('.'), names: item.types })
    if (info.javaModule) { const files = descriptors.get(info.javaModule) ?? []; files.push(file); descriptors.set(info.javaModule, files) }
  }
  const target = (name: string): ResolvedModule[] => {
    const files = types.get(name)
    return files?.size === 1 ? [{ to: files.values().next().value!, candidate: true }] : []
  }
  /** Names from syntax/import tables only. null means an unknown or ambiguous
   * binding which must block lower-priority fallbacks. [] means no local type. */
  const ordinary = (from: string, spec: string, scope: string[]): string[] | null => {
    const facts = entries.get(from)
    if (facts?.kind !== 'source') return null
    const pkg = facts.moduleInfo?.package ?? '', parts = spec.split('.'), first = parts[0]
    const qualify = (name: string): string => pkg ? pkg + '.' + name : name
    for (let n = scope.length; n > 0; n--) {
      const prefix = qualify([...scope.slice(0, n), first].join('.'))
      if (types.has(prefix)) {
        const name = qualify([...scope.slice(0, n), spec].join('.'))
        return types.has(name) ? [name] : null
      }
    }
    const imports = facts.modules.filter((item): item is Extract<ModuleFact, { kind: 'java_import' }> => item.kind === 'java_import')
    const singles = imports.filter(item => !item.wildcard && item.spec.split('.').at(-1) === first)
    if (singles.length) {
      const names = new Set(singles.map(item => item.spec + (parts.length > 1 ? '.' + parts.slice(1).join('.') : '')))
      return names.size === 1 && types.has([...names][0]) ? [...names] : null
    }
    if (types.has(qualify(first))) return types.has(qualify(spec)) ? [qualify(spec)] : null
    if (parts.length > 1 && types.has(spec)) return [spec]
    const names = new Set(imports.filter(item => item.wildcard).map(item => item.spec + '.' + spec).filter(name => types.has(name)))
    if (types.has('java.lang.' + spec)) names.add('java.lang.' + spec)
    return names.size <= 1 ? [...names] : null
  }
  let work = 0, limited = false
  const inheritedCache = new Map<string, boolean>()
  const inheritanceBlocks = (owner: string, spec: string, active = new Set<string>()): boolean => {
    if (limited || active.has(owner)) return true
    const key = JSON.stringify([owner, spec])
    if (inheritedCache.has(key)) return inheritedCache.get(key)!
    if (++work > 20_000 || active.size >= 64) { limited = true; onLimit?.(); return true }
    if (types.get(owner)?.size !== 1) return true
    const declaration = parents.get(owner)
    if (!declaration) return false
    const next = new Set(active).add(owner)
    let unknown = false
    for (const parent of declaration.names) {
      // A parent type itself may be a member inherited by an enclosing class.
      // This collector does not recursively type-check that declaration; block
      // the binding instead of choosing an unrelated same-package name.
      const enclosingInheritance = declaration.scope.slice(0, -1).some((_part, index) => {
        const facts = entries.get(declaration.file)
        const pkg = facts?.kind === 'source' ? facts.moduleInfo?.package : ''
        const name = declaration.scope.slice(0, index + 1).join('.')
        return parents.has(pkg ? pkg + '.' + name : name)
      })
      const names = enclosingInheritance ? null : ordinary(declaration.file, parent, declaration.scope)
      if (names?.length !== 1 || types.get(names[0])?.size !== 1) { unknown = true; continue }
      const prefix = names[0] + '.' + spec.split('.')[0]
      // Access control, generic substitution and inherited member identities
      // require a compiler. Keep that binding unresolved; never link a private
      // or otherwise inaccessible member, or fall back to an unrelated type.
      if (types.has(prefix) || inheritanceBlocks(names[0], spec, next)) unknown = true
    }
    inheritedCache.set(key, unknown)
    return unknown
  }
  const moduleFiles = [...descriptors.values()].flat()
  const owner = (file: string): string | undefined => moduleFiles.filter(descriptor => {
    const dir = path.posix.dirname(descriptor)
    return dir === '.' || file.startsWith(dir + '/')
  }).sort((a, b) => b.length - a.length)[0]
  return (from, ref) => {
    if (ref.kind === 'java_requires') {
      const files = descriptors.get(ref.spec)
      return files?.length === 1 ? [{ to: files[0], candidate: true }] : []
    }
    if (ref.kind === 'java_package') return (packages.get(ref.spec) ?? []).filter(file => file !== from && owner(file) === from).map(to => ({ to, candidate: true }))
    if (ref.kind === 'java_import') {
      if (ref.wildcard && !ref.static) return (packages.get(ref.spec) ?? []).filter(file => file !== from).map(to => ({ to, candidate: true }))
      const name = ref.static && !ref.wildcard ? ref.spec.slice(0, ref.spec.lastIndexOf('.')) : ref.spec
      const files = types.get(name)
      // Explicit imports preserve the existing confirmed syntax edge. Static
      // imports can name a member of a known outer type, not an arbitrary FQN.
      return files?.size === 1 ? [{ to: files.values().next().value! }] : []
    }
    if (ref.kind !== 'java_type') return null
    const facts = entries.get(from)
    if (facts?.kind !== 'source') return []
    if (limited) return []
    const pkg = facts.moduleInfo?.package ?? ''
    const qualify = (name: string): string => pkg ? pkg + '.' + name : name
    // Lexically enclosing/member types precede imports. An ambiguous identity
    // must stop resolution, rather than falling through to another package.
    for (let n = ref.scope.length; n > 0; n--) {
      const name = qualify([...ref.scope.slice(0, n), ref.spec].join('.'))
      const prefix = qualify([...ref.scope.slice(0, n), ref.spec.split('.')[0]].join('.'))
      if (types.has(prefix)) return target(name)
      if (n === ref.scope.length && (ref.role === 'extends' || ref.role === 'implements')) continue
      if (inheritanceBlocks(qualify(ref.scope.slice(0, n).join('.')), ref.spec)) return []
    }
    const names = ordinary(from, ref.spec, ref.scope)
    return names?.length === 1 ? target(names[0]) : []
  }
}
