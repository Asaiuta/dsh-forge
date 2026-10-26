/**
 * Go imports mapped to local package directories. The visible module with the
 * longest matching module path provides the package — the importing module,
 * plus go.work `use` modules in workspace mode — after local-path replaces.
 */
import path from 'node:path'
import type { GoModule } from './go-project.ts'
import { NOT_APPLICABLE, resolvedTo, unresolvedAs, type SourceContext, type SourceResolver } from './source-resolution.ts'

const inside = (dir: string, file: string): boolean => dir === '.' || file.startsWith(dir + '/')

export function goResolver({ entries, go }: SourceContext): SourceResolver {
  // Without loaded project metadata, module paths still come from go.mod facts.
  const modules: GoModule[] = go?.modules ?? [...entries].flatMap(([file, facts]) => facts.kind === 'manifest' ? [{ dir: path.posix.dirname(file), path: facts.module, replaces: [] }] : [])
  const workspaces = go?.workspaces ?? []
  const goPackages = new Map<string, string[]>()
  for (const [file, facts] of entries) {
    if (facts.kind !== 'source' || facts.lang !== 'go' || file.endsWith('_test.go') || !facts.moduleInfo?.package || facts.moduleInfo.package === 'main') continue
    const dir = path.posix.dirname(file), members = goPackages.get(dir) ?? []
    if (!members.includes(file)) members.push(file)
    goPackages.set(dir, members)
  }
  /** Nearest enclosing go.work that lists the module; Go uses the first go.work found upward. */
  const workspaceOf = (moduleDir: string) => {
    const enclosing = workspaces.filter(work => inside(work.dir, moduleDir)).sort((a, b) => b.dir.length - a.dir.length)[0]
    return enclosing?.uses.includes(moduleDir) ? enclosing : undefined
  }
  return (from, ref) => {
    if (ref.kind !== 'go_import') return NOT_APPLICABLE
    const own = modules.filter(module => inside(module.dir, from)).sort((a, b) => b.dir.length - a.dir.length)[0]
    if (!own?.path) return unresolvedAs('unsupported_resolution', own === undefined ? '文件不属于任何 go.mod。' : '所属 go.mod 的 module 声明无法解析。')
    const workspace = workspaceOf(own.dir)
    const members = workspace ? workspace.uses.flatMap(dir => modules.filter(module => module.dir === dir)) : [own]
    const visible = new Map<string, { dir: string; via: string }[]>()
    const offer = (modulePath: string, dir: string, via: string): void => {
      const list = visible.get(modulePath) ?? []
      if (!list.some(item => item.dir === dir)) list.push({ dir, via })
      visible.set(modulePath, list)
    }
    for (const module of members) if (module.path) offer(module.path, module.dir, workspace ? 'go.work use' : 'go.mod')
    // go.work replaces win over those of its modules; a replace overrides the module it names.
    const replaces = [...workspace?.replaces ?? [], ...members.flatMap(module => module.replaces)]
    const replaced = new Set<string>()
    for (const replace of replaces) {
      if (replaced.has(replace.from)) continue
      replaced.add(replace.from)
      visible.set(replace.from, [{ dir: replace.dir, via: `replace（${replace.source}）` }])
    }
    const best = [...visible.keys()].filter(modulePath => ref.spec === modulePath || ref.spec.startsWith(modulePath + '/')).sort((a, b) => b.length - a.length)[0]
    if (best === undefined) return unresolvedAs('external_package', '导入路径不属于任何可见模块（标准库或外部模块）。')
    const providers = visible.get(best)!
    if (providers.length > 1) return unresolvedAs('unsupported_resolution', `多个工作区模块声明同一 module 路径 ${best}（go 会报错）。`)
    const { dir: moduleDir, via } = providers[0]
    const suffix = ref.spec.slice(best.length).replace(/^\//, '')
    if (suffix.split('/').some(part => part === '..' || part === '.') || ref.spec.includes('\\')) return unresolvedAs('unsupported_resolution', '非规范导入路径。')
    const target = path.posix.join(moduleDir, suffix)
    // A nested module owns its directory; it provides packages only when visible itself.
    if (modules.some(module => module.dir !== moduleDir && inside(moduleDir, module.dir) && (target === module.dir || inside(module.dir, target)))) {
      return unresolvedAs('unsupported_resolution', '目标目录属于嵌套模块，且该模块不在 go.work 中或未被 replace。')
    }
    const files = goPackages.get(target) ?? []
    if (!files.length) return unresolvedAs('missing_target', `${via} 提供的模块内没有该包目录或其中没有非测试源文件。`)
    const packages = new Set(files.map(file => { const entry = entries.get(file); return entry?.kind === 'source' ? entry.moduleInfo?.package : undefined }))
    // Mixed package names fail `go build`; a source error, not a resolution limit.
    return packages.size === 1 ? resolvedTo(files.map(to => ({ to, candidate: true }))) : unresolvedAs('unsupported_resolution', '包目录内声明了多个包名（go build 会报错）。')
  }
}
