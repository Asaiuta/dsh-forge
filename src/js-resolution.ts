/** Static, root-local JS/TS file resolution. No package manager or loader is executed. */
import path from 'node:path'
import { local, type JsConfig } from './js-config.ts'
import { resolved, unresolved, type JsResolution, type JsResolver } from './trace-evidence.ts'

const EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.json']
export function jsFile(base: string, isFile: (file: string) => boolean, preferTypes = false): string | null {
  if (!local(base) || base === '.') return null
  const extensions = preferTypes ? ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'] : EXTENSIONS
  const candidates: string[] = []
  const substitution = /\.(js|jsx|mjs|cjs)$/.exec(base)
  if (substitution) {
    const stem = base.slice(0, -substitution[0].length)
    const mapped = (substitution[1] === 'mjs' ? ['.mts', '.d.mts'] : substitution[1] === 'cjs' ? ['.cts', '.d.cts'] : ['.ts', '.tsx', '.d.ts']).map(ext => stem + ext)
    if (preferTypes) candidates.push(...mapped, base)
    else candidates.push(base, ...extensions.map(ext => base + ext), ...mapped)
  }
  else candidates.push(base, ...extensions.map(ext => base + ext))
  candidates.push(...extensions.map(ext => path.posix.join(base, 'index' + ext)))
  return candidates.find(isFile) ?? null
}
export const relativeJs: JsResolver = (from, spec, _mode, isFile, syntax) => {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return unresolved('external_package')
  const clean = spec.replace(/[?#].*$/, '')
  const base = path.posix.normalize(clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(from), clean))
  if (!local(base)) return unresolved('outside_root')
  const to = jsFile(base, isFile, syntax ? syntax !== 'javascript' : /\.[cm]?tsx?$/.test(from))
  return to ? resolved(to, 'relative') : unresolved('missing_target')
}

/** TS ties retain order; package wildcard ties additionally prefer longer suffixes. */
export function mappingKey(keys: readonly string[], spec: string, packagePattern = false): { key: string; capture: string } | null {
  if (keys.includes(spec) && (!packagePattern || !spec.includes('*'))) return { key: spec, capture: '' }
  const matches = keys.flatMap(key => {
    const index = key.indexOf('*')
    if (index < 0 || key.indexOf('*', index + 1) >= 0) return []
    const prefix = key.slice(0, index), suffix = key.slice(index + 1)
    return spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length + Number(packagePattern)
      ? [{ key, capture: spec.slice(prefix.length, spec.length - suffix.length), prefix: prefix.length, suffix: suffix.length }] : []
  }).sort((a, b) => b.prefix - a.prefix || (packagePattern ? b.suffix - a.suffix : 0))
  return matches[0] ?? null
}

export function configuredJs(config: JsConfig, spec: string, isFile: (file: string) => boolean): JsResolution | null {
  if (config.invalid) return unresolved('unsupported_config', '工程配置不完整，已停止配置相关推断。', config.file)
  const mapping = mappingKey((config.paths ?? []).map(entry => entry.pattern), spec)
  if (mapping) {
    const entry = config.paths!.find(entry => entry.pattern === mapping.key)!
    let outside = false
    for (const target of entry.targets) {
      const base = path.posix.join(config.baseUrl ?? path.posix.dirname(entry.config), target.replace('*', mapping.capture))
      if (!local(base)) { outside = true; continue }
      // The extension check applies to the declared substitution, before
      // replacing '*'. A capture ending in .js must still prefer TS source.
      const explicit = /\.(?:[cm]?[jt]sx?|json)$/.test(target)
      const to = explicit && isFile(base) ? base : jsFile(base, isFile, true)
      if (to) return resolved(to, 'tsconfig_paths', entry.config)
    }
    return unresolved(outside ? 'outside_root' : 'missing_target', 'paths 已匹配，但没有可用的根内文件。', entry.config)
  }
  if (config.baseUrl !== undefined) {
    const base = path.posix.join(config.baseUrl, spec)
    if (!local(base)) return unresolved('outside_root', undefined, config.baseConfig)
    const to = jsFile(base, isFile, true)
    if (to) return resolved(to, 'tsconfig_baseUrl', config.baseConfig)
  }
  return null
}
