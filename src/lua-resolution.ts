/** Lua require() mapped to `a/b.lua` or `a/b/init.lua` from the workspace root; package.path is not read. */
import path from 'node:path'
import { NOT_APPLICABLE, resolvedTo, unresolvedAs, type SourceContext, type SourceResolver } from './source-resolution.ts'

export function luaResolver({ isFile }: SourceContext): SourceResolver {
  return (_from, ref) => {
    if (ref.kind !== 'lua_require') return NOT_APPLICABLE
    if (ref.dynamic) return unresolvedAs('non_literal')
    if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(ref.spec)) return unresolvedAs('unsupported_resolution', '模块名不是点分标识符。')
    const base = ref.spec.replaceAll('.', '/')
    const to = [base + '.lua', path.posix.join(base, 'init.lua')].find(isFile)
    return to ? resolvedTo([{ to, candidate: true }]) : unresolvedAs('unsupported_resolution', `扫描根下没有 ${base}.lua 或 ${base}/init.lua（未读取 package.path，可能是外部模块）。`)
  }
}
