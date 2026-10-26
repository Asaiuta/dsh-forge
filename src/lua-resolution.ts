/**
 * Lua require() mapped through the default `?.lua` / `?/init.lua` patterns and
 * literal `package.path` patterns found in the workspace, all relative to the
 * workspace root (the interpreter's working directory is unknown statically).
 */
import path from 'node:path'
import { localPath, NOT_APPLICABLE, resolvedTo, unresolvedAs, type SourceContext, type SourceResolver } from './source-resolution.ts'

export function luaResolver({ entries, isFile }: SourceContext): SourceResolver {
  const patterns: string[] = []
  for (const facts of entries.values()) {
    if (facts.kind !== 'source' || facts.lang !== 'lua') continue
    for (const pattern of facts.moduleInfo?.luaPaths ?? []) if (!patterns.includes(pattern)) patterns.push(pattern)
  }
  return (_from, ref) => {
    if (ref.kind !== 'lua_require') return NOT_APPLICABLE
    if (ref.dynamic) return unresolvedAs('non_literal')
    if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(ref.spec)) return unresolvedAs('unsupported_resolution', '模块名不是点分标识符。')
    const base = ref.spec.replaceAll('.', '/')
    const conventional = [base + '.lua', path.posix.join(base, 'init.lua')].find(isFile)
    if (conventional) return resolvedTo([{ to: conventional, candidate: true }])
    // Assignment order across files is unknown, so distinct hits are ambiguous.
    const hits = [...new Set(patterns.map(pattern => localPath('.', pattern.replaceAll('?', base))).filter((to): to is string => to !== null && isFile(to)))]
    if (hits.length > 1) return unresolvedAs('ambiguous_target', `多个 package.path 模式命中不同文件：${hits.slice(0, 3).join('、')}。`)
    if (hits.length) return resolvedTo([{ to: hits[0], candidate: true }])
    return unresolvedAs('unsupported_resolution', `扫描根下没有 ${base}.lua 或 ${base}/init.lua${patterns.length ? `，${patterns.length} 个字面量 package.path 模式也未命中` : ''}（可能是外部模块）。`)
  }
}
