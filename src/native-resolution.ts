/** C/C++/cgo includes and C++20 module units. No preprocessor or compiler runs. */
import path from 'node:path'
import { localPath, NOT_APPLICABLE, resolvedTo, unresolvedAs, type SourceContext, type SourceResolver } from './source-resolution.ts'

export function nativeResolver({ entries, isFile, includeResolver }: SourceContext): SourceResolver {
  const providers = new Map<string, string[]>()
  for (const [file, facts] of entries) {
    if (facts.kind !== 'source' || facts.lang !== 'cpp' || facts.moduleInfo?.cppModules?.length !== 1) continue
    for (const module of facts.moduleInfo.cppModules) {
      if (!module.interface && !module.name.includes(':')) continue
      const files = providers.get(module.name) ?? []
      if (!files.includes(file)) files.push(file)
      providers.set(module.name, files)
    }
  }
  return (from, ref) => {
    if (ref.kind === 'cpp_import' || ref.kind === 'cpp_implementation') {
      if (ref.kind === 'cpp_import' && ref.dynamic) return unresolvedAs('non_literal')
      const facts = entries.get(from), declarations = facts?.kind === 'source' ? facts.moduleInfo?.cppModules : undefined
      const context = declarations?.length === 1 ? declarations[0].name.split(':')[0] : undefined
      const name = ref.spec.startsWith(':') && context ? context + ref.spec : ref.spec
      if (name.includes(':') && name.split(':')[0] !== context) return unresolvedAs('unsupported_resolution', '分区名不属于当前文件声明的模块。')
      const files = providers.get(name) ?? []
      if (files.length > 1) return unresolvedAs('ambiguous_target', '多个文件提供同名模块接口。')
      if (!files.length) return unresolvedAs('external_package', '工作区内没有该模块的接口单元（可能是标准库或外部模块）。')
      return files[0] === from ? unresolvedAs('unsupported_resolution', '模块单元指向自身。') : resolvedTo([{ to: files[0], candidate: true }])
    }
    if (ref.kind !== 'c_include' && ref.kind !== 'cgo_include' && ref.kind !== 'cpp_header') return NOT_APPLICABLE
    const candidate = ref.kind !== 'c_include'
    if (ref.kind !== 'cgo_include' && includeResolver) {
      const targets = includeResolver(from, ref.spec, ref.mode, isFile)
      if (targets !== null) {
        if (targets.length) return resolvedTo(targets.map(to => ({ to, ...(ref.kind === 'cpp_header' ? { candidate: true as const } : {}) })))
        return ref.mode === 'system'
          ? unresolvedAs('external_package', '编译数据库的搜索路径中未找到，视为系统或外部头文件。')
          : unresolvedAs('missing_target', '编译数据库的搜索路径中未找到。')
      }
    }
    if (ref.mode === 'dynamic') return unresolvedAs('non_literal')
    if (ref.mode === 'system') return unresolvedAs('external_package', '尖括号 include 需要编译数据库提供搜索路径，视为系统或外部头文件。')
    const to = localPath(path.posix.dirname(from), ref.spec)
    if (!to) return unresolvedAs('outside_root', 'include 路径越出扫描根。')
    return isFile(to)
      ? resolvedTo([{ to, ...(candidate ? { candidate: true as const } : {}) }])
      : unresolvedAs('missing_target', '相对当前文件未找到；没有编译数据库时不搜索 -I 目录。')
  }
}
