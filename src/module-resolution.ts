/** Workspace indexes for package/module relationships that need other files. */
import path from 'node:path'
import type { TraceFileFacts } from './facts.ts'
import { isRustRoot, resolveModuleFact, type ModuleFact, type ResolvedModule } from './module-facts.ts'
import { javaResolver } from './java-resolution.ts'

const add = (map: Map<string, string[]>, key: string, value: string): void => {
  const values = map.get(key) ?? []
  if (!values.includes(value)) values.push(value)
  map.set(key, values)
}
const one = (values: string[] | undefined): string | null => values?.length === 1 ? values[0] : null
const inside = (dir: string, file: string): boolean => dir === '.' || file.startsWith(dir + '/')

export function moduleResolver(entries: Map<string, TraceFileFacts>, isFile: (file: string) => boolean, onLimit?: () => void): (from: string, ref: ModuleFact) => ResolvedModule[] | null {
  const resolveJava = javaResolver(entries, onLimit), cppProviders = new Map<string, string[]>()
  const goModules = new Map<string, string | null>(), goPackages = new Map<string, string[]>()
  const rustModules = new Map<string, Map<string, string[]>>()
  const owners = new Map<string, Array<{ root: string; scope: string[] }>>()
  for (const [file, facts] of entries) {
    if (facts.kind === 'manifest') goModules.set(path.posix.dirname(file), facts.module)
    if (facts.kind !== 'source') continue
    if (facts.lang === 'cpp' && facts.moduleInfo?.cppModules?.length === 1) for (const module of facts.moduleInfo.cppModules) {
      if (module.interface || module.name.includes(':')) add(cppProviders, module.name, file)
    }
    if (facts.lang === 'go' && !file.endsWith('_test.go') && facts.moduleInfo?.package && facts.moduleInfo.package !== 'main') add(goPackages, path.posix.dirname(file), file)
  }
  // Follow actual mod declarations, including #[path], instead of searching
  // arbitrary Rust filenames. Ownership can be shared by lib/main crates.
  let work = 0, rustLimited = false
  for (const [root, facts] of entries) {
    if (facts.kind !== 'source' || facts.lang !== 'rust' || !isRustRoot(root, isFile)) continue
    const modules = new Map<string, string[]>(), queue = [{ file: root, scope: [] as string[] }], seen = new Set<string>()
    rustModules.set(root, modules)
    for (let n = 0; n < queue.length; n++) {
      const { file, scope } = queue[n], key = JSON.stringify([file, scope])
      if (seen.has(key)) continue
      if (++work > 20_000 || scope.length > 64) { rustLimited = true; break }
      seen.add(key); add(modules, scope.join('::'), file)
      const own = owners.get(file) ?? []
      own.push({ root, scope }); owners.set(file, own)
      const entry = entries.get(file)
      if (entry?.kind !== 'source') continue
      for (const inline of entry.moduleInfo?.inlineModules ?? []) add(modules, [...scope, ...inline].join('::'), file)
      for (const ref of entry.modules) if (ref.kind === 'rust_mod' && !ref.dynamic) {
        for (const target of resolveModuleFact(file, ref, isFile)) {
          if (queue.length >= 20_000) { rustLimited = true; break }
          queue.push({ file: target.to, scope: [...scope, ...ref.scope, ref.spec] })
        }
      }
    }
    if (rustLimited) break
  }
  if (rustLimited) onLimit?.()
  return (from, ref) => {
    const java = resolveJava(from, ref)
    if (java !== null) return java
    if (ref.kind === 'cpp_import' || ref.kind === 'cpp_implementation') {
      if (ref.kind === 'cpp_import' && ref.dynamic) return []
      const facts = entries.get(from), declarations = facts?.kind === 'source' ? facts.moduleInfo?.cppModules : undefined
      const context = declarations?.length === 1 ? declarations[0].name.split(':')[0] : undefined
      const name = ref.spec.startsWith(':') && context ? context + ref.spec : ref.spec
      if (name.includes(':') && name.split(':')[0] !== context) return []
      const to = one(cppProviders.get(name))
      return to && to !== from ? [{ to, candidate: true }] : []
    }
    if (ref.kind === 'go_import') {
      const directory = [...goModules.keys()].filter(dir => inside(dir, from)).sort((a, b) => b.length - a.length)[0]
      const module = directory === undefined ? undefined : goModules.get(directory)
      if (!module || ref.spec !== module && !ref.spec.startsWith(module + '/')) return []
      const suffix = ref.spec.slice(module.length).replace(/^\//, '')
      if (suffix.split('/').some(part => part === '..' || part === '.') || ref.spec.includes('\\')) return []
      const target = path.posix.join(directory, suffix)
      // Nested modules do not belong to the importing module without go.work/replace.
      if ([...goModules.keys()].some(dir => dir !== directory && inside(directory, dir) && (target === dir || inside(dir, target)))) return []
      const members = goPackages.get(target) ?? []
      const packages = new Set(members.map(file => { const entry = entries.get(file); return entry?.kind === 'source' ? entry.moduleInfo?.package : undefined }))
      return packages.size === 1 ? members.map(to => ({ to, candidate: true })) : []
    }
    if (ref.kind === 'lua_require') {
      if (ref.dynamic || !/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(ref.spec)) return []
      const base = ref.spec.replaceAll('.', '/')
      const to = [base + '.lua', path.posix.join(base, 'init.lua')].find(isFile)
      return to ? [{ to, candidate: true }] : []
    }
    if (ref.kind === 'rust_use') {
      // A partially enumerated ownership set cannot establish agreement
      // between all crates that own a file. Refuse every use inference.
      if (ref.dynamic || rustLimited) return []
      const targets = (owners.get(from) ?? []).map(owner => {
        const parts = ref.spec.replace(/^::/, '').split('::').map(part => part.replace(/^r#/, ''))
        const scope = [...owner.scope, ...ref.scope]
        const explicit = ['crate', 'self', 'super'].includes(parts[0])
        if (parts[0] === 'crate') { parts.shift(); scope.length = 0 }
        else if (parts[0] === 'self') parts.shift()
        else if (parts[0] !== 'super' && ref.spec.startsWith('::')) return null // external crate
        while (parts[0] === 'super') { if (!scope.length) return null; scope.pop(); parts.shift() }
        if (parts.at(-1) === 'self' || parts.at(-1) === '*') parts.pop()
        const modules = rustModules.get(owner.root)!
        const exact = one(modules.get([...scope, ...parts].join('::')))
        if (exact) return exact
        // Only the final segment can be a symbol in a confirmed module. No
        // recursive prefix guessing through missing modules or re-exports.
        if (!explicit && parts.length < 2) return null
        if (parts.length) parts.pop()
        return one(modules.get([...scope, ...parts].join('::')))
      })
      return targets.length && targets[0] && targets.every(to => to === targets[0]) ? [{ to: targets[0], candidate: true }] : []
    }
    return null
  }
}
