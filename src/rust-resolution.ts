/** Rust mod trees from crate roots, `use` paths and include! macros. No Cargo or macro expansion. */
import path from 'node:path'
import type { ModuleFact } from './module-facts.ts'
import { localPath, NOT_APPLICABLE, resolvedTo, unresolvedAs, type SourceContext, type SourceResolution, type SourceResolver } from './source-resolution.ts'

type RustMod = Extract<ModuleFact, { kind: 'rust_mod' }>

export function isRustRoot(file: string, isFile: (rel: string) => boolean): boolean {
  const dir = path.posix.dirname(file)
  return /(?:^|\/)src\/(?:lib|main)\.rs$/.test(file) || /^(?:lib|main)\.rs$/.test(file)
    || /(?:^|\/)(?:src\/bin|tests|examples|benches)\/(?:[^/]+\.rs|[^/]+\/main\.rs)$/.test(file)
    || path.posix.basename(file) === 'build.rs' && (dir === '.' || isFile(path.posix.join(dir, 'Cargo.toml')))
}

/** mod.rs and conventional crate roots own their containing directory;
 *  other module files own a subdirectory named after the file stem. */
function resolveMod(fromRel: string, ref: RustMod, isFile: (rel: string) => boolean): SourceResolution {
  if (ref.dynamic) return unresolvedAs('unsupported_resolution', 'cfg_attr 或外层 #[path] 下的模块路径不做推断。')
  const dir = path.posix.dirname(fromRel)
  const moduleDir = path.posix.basename(fromRel) === 'mod.rs' || isRustRoot(fromRel, isFile) ? dir : path.posix.join(dir, path.posix.basename(fromRel, '.rs'))
  const base = path.posix.join(moduleDir, ...ref.scope)
  if (ref.path !== undefined) {
    const to = localPath(ref.scope.length ? base : dir, ref.path)
    if (!to) return unresolvedAs('outside_root', '#[path] 越出扫描根。')
    return isFile(to) ? resolvedTo([{ to }]) : unresolvedAs('missing_target', '#[path] 指向的文件不存在。')
  }
  const target = localPath(base, ref.spec)
  if (!target) return unresolvedAs('outside_root', '模块路径越出扫描根。')
  const candidates = [`${target}.rs`, path.posix.join(target, 'mod.rs')].filter(isFile)
  // rustc rejects this (E0761): a source error the analysis fully observed,
  // not a resolution limit, so it must not mark the query incomplete.
  if (candidates.length > 1) return unresolvedAs('unsupported_resolution', `${ref.spec}.rs 与 ${ref.spec}/mod.rs 同时存在（rustc E0761）。`)
  return candidates.length ? resolvedTo([{ to: candidates[0] }]) : unresolvedAs('missing_target', `未找到 ${ref.spec}.rs 或 ${ref.spec}/mod.rs。`)
}

const one = (values: string[] | undefined): string | null => values?.length === 1 ? values[0] : null

export function rustResolver({ entries, isFile, onLimit }: SourceContext): SourceResolver {
  // Follow actual mod declarations, including #[path], instead of searching
  // arbitrary Rust filenames. Ownership can be shared by lib/main crates.
  const rustModules = new Map<string, Map<string, string[]>>()
  const owners = new Map<string, Array<{ root: string; scope: string[] }>>()
  const add = (map: Map<string, string[]>, key: string, value: string): void => {
    const values = map.get(key) ?? []
    if (!values.includes(value)) values.push(value)
    map.set(key, values)
  }
  let work = 0, limited = false
  for (const [root, facts] of entries) {
    if (facts.kind !== 'source' || facts.lang !== 'rust' || !isRustRoot(root, isFile)) continue
    const modules = new Map<string, string[]>(), queue = [{ file: root, scope: [] as string[] }], seen = new Set<string>()
    rustModules.set(root, modules)
    for (let n = 0; n < queue.length; n++) {
      const { file, scope } = queue[n], key = JSON.stringify([file, scope])
      if (seen.has(key)) continue
      if (++work > 20_000 || scope.length > 64) { limited = true; break }
      seen.add(key); add(modules, scope.join('::'), file)
      const own = owners.get(file) ?? []
      own.push({ root, scope }); owners.set(file, own)
      const entry = entries.get(file)
      if (entry?.kind !== 'source') continue
      for (const inline of entry.moduleInfo?.inlineModules ?? []) add(modules, [...scope, ...inline].join('::'), file)
      for (const ref of entry.modules) if (ref.kind === 'rust_mod' && !ref.dynamic) {
        const result = resolveMod(file, ref, isFile)
        if (result.status === 'resolved') for (const target of result.targets) {
          if (queue.length >= 20_000) { limited = true; break }
          queue.push({ file: target.to, scope: [...scope, ...ref.scope, ref.spec] })
        }
      }
    }
    if (limited) break
  }
  if (limited) onLimit?.()

  return (from, ref) => {
    if (ref.kind === 'rust_mod') return resolveMod(from, ref, isFile)
    if (ref.kind === 'rust_include') {
      if (ref.dynamic) return unresolvedAs('non_literal')
      const to = localPath(path.posix.dirname(from), ref.spec)
      if (!to) return unresolvedAs('outside_root', 'include! 路径越出扫描根。')
      return isFile(to) ? resolvedTo([{ to }]) : unresolvedAs('missing_target', 'include! 指向的文件不存在。')
    }
    if (ref.kind !== 'rust_use') return NOT_APPLICABLE
    if (ref.dynamic) return unresolvedAs('non_literal')
    // A partially enumerated ownership set cannot establish agreement
    // between all crates that own a file. Refuse every use inference.
    if (limited) return unresolvedAs('unsupported_resolution', 'crate 模块树超出遍历预算，已停止 use 推断。')
    const own = owners.get(from) ?? []
    if (!own.length) return unresolvedAs('unsupported_resolution', '文件不在任何已识别 crate 根的 mod 树中。')
    const parts0 = ref.spec.replace(/^::/, '').split('::').map(part => part.replace(/^r#/, ''))
    const explicit = ['crate', 'self', 'super'].includes(parts0[0])
    if (!explicit && ref.spec.startsWith('::')) return unresolvedAs('external_package', '绝对路径指向外部 crate。')
    const targets = own.map(owner => {
      const parts = [...parts0]
      const scope = [...owner.scope, ...ref.scope]
      if (parts[0] === 'crate') { parts.shift(); scope.length = 0 }
      else if (parts[0] === 'self') parts.shift()
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
    if (targets[0] && targets.every(to => to === targets[0])) return resolvedTo([{ to: targets[0], candidate: true }])
    if (targets.some(Boolean)) return unresolvedAs('ambiguous_target', '共享该文件的多个 crate 对此路径给出不同结果。')
    return explicit
      ? unresolvedAs('missing_target', 'crate 模块树中没有该路径。')
      : unresolvedAs('external_package', '首段不是本 crate 的模块，视为外部 crate 或标准库（Cargo workspace 尚未读取）。')
  }
}
