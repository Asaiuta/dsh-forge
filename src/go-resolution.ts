/** Go imports mapped through go.mod module paths to local package directories. */
import path from 'node:path'
import { NOT_APPLICABLE, resolvedTo, unresolvedAs, type SourceContext, type SourceResolver } from './source-resolution.ts'

const inside = (dir: string, file: string): boolean => dir === '.' || file.startsWith(dir + '/')

export function goResolver({ entries }: SourceContext): SourceResolver {
  const goModules = new Map<string, string | null>(), goPackages = new Map<string, string[]>()
  for (const [file, facts] of entries) {
    if (facts.kind === 'manifest') goModules.set(path.posix.dirname(file), facts.module)
    if (facts.kind !== 'source' || facts.lang !== 'go' || file.endsWith('_test.go') || !facts.moduleInfo?.package || facts.moduleInfo.package === 'main') continue
    const dir = path.posix.dirname(file), members = goPackages.get(dir) ?? []
    if (!members.includes(file)) members.push(file)
    goPackages.set(dir, members)
  }
  return (from, ref) => {
    if (ref.kind !== 'go_import') return NOT_APPLICABLE
    const directory = [...goModules.keys()].filter(dir => inside(dir, from)).sort((a, b) => b.length - a.length)[0]
    const module = directory === undefined ? undefined : goModules.get(directory)
    if (!module) return unresolvedAs('unsupported_resolution', directory === undefined ? '文件不属于任何 go.mod。' : '所属 go.mod 的 module 声明无法解析。')
    if (ref.spec !== module && !ref.spec.startsWith(module + '/')) return unresolvedAs('external_package', '导入路径不在本模块内（标准库或外部模块）。')
    const suffix = ref.spec.slice(module.length).replace(/^\//, '')
    if (suffix.split('/').some(part => part === '..' || part === '.') || ref.spec.includes('\\')) return unresolvedAs('unsupported_resolution', '非规范导入路径。')
    const target = path.posix.join(directory!, suffix)
    // Nested modules do not belong to the importing module without go.work/replace.
    if ([...goModules.keys()].some(dir => dir !== directory && inside(directory!, dir) && (target === dir || inside(dir, target)))) {
      return unresolvedAs('unsupported_resolution', '目标目录属于嵌套模块；需要 go.work 或 replace（尚未支持）。')
    }
    const members = goPackages.get(target) ?? []
    if (!members.length) return unresolvedAs('missing_target', '本模块内没有该包目录或其中没有非测试源文件。')
    const packages = new Set(members.map(file => { const entry = entries.get(file); return entry?.kind === 'source' ? entry.moduleInfo?.package : undefined }))
    // Mixed package names fail `go build`; a source error, not a resolution limit.
    return packages.size === 1 ? resolvedTo(members.map(to => ({ to, candidate: true }))) : unresolvedAs('unsupported_resolution', '包目录内声明了多个包名（go build 会报错）。')
  }
}
