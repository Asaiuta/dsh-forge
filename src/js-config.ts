/** Bounded JSONC project configuration, with paths anchored at their declaring file. */
import path from 'node:path'
import type { TraceDiagnostic } from './trace-evidence.ts'

export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
export const under = (dir: string, file: string): boolean => dir === '.' || file.startsWith(dir + '/')
export const local = (file: string): boolean => file !== '..' && !file.startsWith('../') && !path.posix.isAbsolute(file) && !/^[a-z]:/i.test(file) && !file.includes('\0') && !file.includes('\\')
const relativeConfigPath = (value: string): boolean => !path.posix.isAbsolute(value) && !/^[a-z]:/i.test(value) && !/[\\\0$]/.test(value)

/** Comments/trailing commas are removed only outside JSON strings. */
export function parseJsonc(text: string): unknown {
  const chars = [...text.replace(/^\uFEFF/, '')]
  let quoted = false
  for (let i = 0; i < chars.length; i++) {
    if (quoted) { if (chars[i] === '\\') i++; else if (chars[i] === '"') quoted = false; continue }
    if (chars[i] === '"') { quoted = true; continue }
    if (chars[i] !== '/') continue
    if (chars[i + 1] === '/') {
      chars[i++] = ' '; chars[i] = ' '
      while (i + 1 < chars.length && !/[\r\n]/.test(chars[i + 1])) chars[++i] = ' '
    } else if (chars[i + 1] === '*') {
      chars[i++] = ' '; chars[i] = ' '
      let closed = false
      while (++i < chars.length) {
        if (chars[i] === '*' && chars[i + 1] === '/') { chars[i++] = ' '; chars[i] = ' '; closed = true; break }
        if (!/[\r\n]/.test(chars[i])) chars[i] = ' '
      }
      if (!closed) throw new Error('Unterminated JSONC comment')
    }
  }
  quoted = false
  for (let i = 0; i < chars.length; i++) {
    if (quoted) { if (chars[i] === '\\') i++; else if (chars[i] === '"') quoted = false; continue }
    if (chars[i] === '"') quoted = true
    else if (chars[i] === ',') {
      let next = i + 1
      while (/\s/.test(chars[next] ?? '') && next < chars.length) next++
      if (chars[next] === '}' || chars[next] === ']') chars[i] = ' '
    }
  }
  return JSON.parse(chars.join(''))
}

/** Deliberately small glob dialect. Unsupported syntax never becomes a match. */
const GLOB_CACHE = new Map<string, RegExp | null>()
export function glob(pattern: string, dot = true): RegExp | null {
  const cacheKey = dot ? '\u0001' + pattern : '\u0000' + pattern
  if (GLOB_CACHE.has(cacheKey)) return GLOB_CACHE.get(cacheKey)!
  const value = compileGlob(pattern, dot)
  if (GLOB_CACHE.size < 4096) GLOB_CACHE.set(cacheKey, value)
  return value
}
function compileGlob(pattern: string, dot: boolean): RegExp | null {
  if (/[\[\]{}()!\\\0]/.test(pattern)) return null
  if (pattern.split('/').some(part => part.includes('**') && part !== '**')) return null
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      i++
      if (pattern[i + 1] === '/') { i++; source += dot ? '(?:.*/)?' : '(?:(?!\\.)[^/]+/)*' }
      else source += dot ? '.*' : '(?:(?!\\.)[^/]+/)*(?!\\.)[^/]*'
    } else if (pattern[i] === '*' || pattern[i] === '?') {
      if (!dot && (i === 0 || pattern[i - 1] === '/')) source += '(?!\\.)'
      source += pattern[i] === '*' ? '[^/]*' : '[^/]'
    }
    else source += pattern[i].replace(/[.*+?^${}|]/g, '\\$&')
  }
  return new RegExp(source + '$', process.platform === 'win32' ? 'i' : '')
}
interface PathMapping { pattern: string; targets: string[]; config: string }
export interface JsConfig {
  file: string
  dir: string
  baseUrl?: string
  baseConfig?: string
  module?: string
  allowJs?: boolean
  noResolve?: boolean
  outDir?: string
  declarationDir?: string
  paths?: PathMapping[]
  files?: string[]
  include?: string[]
  exclude?: string[]
  invalid?: true
}
type ReadObject = (file: string) => Record<string, unknown> | null

export function loadConfigs(files: readonly string[], read: ReadObject, issues: TraceDiagnostic[]): JsConfig[] {
  const cache = new Map<string, JsConfig>(), active = new Set<string>(), loading = new Set<string>()
  const fail = (file: string, message: string): void => { issues.push({ path: file, reason: 'unsupported_config', message }) }
  const load = (file: string, depth = 0): JsConfig => {
    const previous = cache.get(file)
    if (previous) return previous
    const config: JsConfig = { file, dir: path.posix.dirname(file) }
    if (loading.has(file) || depth > 32 || cache.size + loading.size >= 2000) {
      fail(file, '配置继承/引用存在循环或超过读取预算。'); return { ...config, invalid: true }
    }
    loading.add(file)
    const raw = read(file)
    if (!raw) config.invalid = true
    else {
      if (raw.extends !== undefined) {
        const parents = typeof raw.extends === 'string' ? [raw.extends] : strings(raw.extends) ? raw.extends : []
        if (!parents.length) { config.invalid = true; fail(file, 'extends 必须是本地相对配置路径。') }
        for (const parent of parents) {
          if (!parent.startsWith('.')) { config.invalid = true; fail(file, '未解析包名或绝对路径形式的 extends。'); continue }
          const target = path.posix.join(config.dir, parent.endsWith('.json') ? parent : parent + '.json')
          if (!local(target)) { config.invalid = true; fail(file, 'extends 超出扫描根。'); continue }
          const inherited = load(target, depth + 1)
          Object.assign(config, inherited, { file, dir: config.dir })
        }
      }
      const options = raw.compilerOptions
      if (options !== undefined && !object(options)) { config.invalid = true; fail(file, 'compilerOptions 必须是对象。') }
      if (object(options)) {
        for (const key of ['allowJs', 'noResolve'] as const) if (options[key] !== undefined) {
          if (typeof options[key] !== 'boolean') { config.invalid = true; fail(file, key + ' 必须是布尔值。') }
          else config[key] = options[key]
        }
        for (const key of ['outDir', 'declarationDir'] as const) if (options[key] !== undefined) {
          if (typeof options[key] !== 'string' || !relativeConfigPath(options[key])) { config.invalid = true; fail(file, key + ' 仅支持字面量相对路径。') }
          else config[key] = path.posix.join(config.dir, options[key])
        }
        if (options.module !== undefined) {
          if (typeof options.module !== 'string') { config.invalid = true; fail(file, 'module 必须是字符串。') }
          else config.module = options.module.toLowerCase()
        }
        if (options.baseUrl !== undefined) {
          if (typeof options.baseUrl !== 'string' || !relativeConfigPath(options.baseUrl)) { config.invalid = true; fail(file, 'baseUrl 仅支持字面量相对路径。') }
          else { config.baseUrl = path.posix.join(config.dir, options.baseUrl); config.baseConfig = file }
        }
        if (options.paths !== undefined) {
          config.paths = []
          if (!object(options.paths)) config.invalid = true
          else for (const [pattern, targets] of Object.entries(options.paths)) {
            if (!strings(targets) || !targets.length || (pattern.match(/\*/g)?.length ?? 0) > 1 || targets.some(target => !relativeConfigPath(target) || (target.match(/\*/g)?.length ?? 0) > 1)) {
              config.invalid = true; fail(file, 'paths 仅支持精确键或单个星号，以及非空字符串目标数组。'); continue
            }
            config.paths.push({ pattern, targets, config: file })
          }
        }
        if (options.rootDirs !== undefined || options.moduleSuffixes !== undefined || options.customConditions !== undefined || options.resolvePackageJsonExports === false || options.resolvePackageJsonImports === false) {
          config.invalid = true; fail(file, 'rootDirs/moduleSuffixes/customConditions 或关闭包映射尚未支持。')
        }
      }
      for (const key of ['files', 'include', 'exclude'] as const) if (raw[key] !== undefined) {
        if (!strings(raw[key]) || raw[key].some(value => !relativeConfigPath(value))) { config.invalid = true; fail(file, key + ' 必须是本地相对路径字符串数组。') }
        else {
          config[key] = raw[key].map(value => path.posix.join(config.dir, value))
          if (key !== 'files' && config[key]!.some(value => !glob(value, false))) {
            config.invalid = true; fail(file, 'include/exclude 模式仅支持 *、**、?。')
          }
        }
      }
      if (raw.references !== undefined) {
        if (!Array.isArray(raw.references)) { config.invalid = true; fail(file, 'references 必须是配置路径数组。') }
        else for (const ref of raw.references) {
          if (!object(ref) || typeof ref.path !== 'string' || !relativeConfigPath(ref.path)) { fail(file, 'references 条目需为字面量相对 path。'); continue }
          const target = path.posix.join(config.dir, ref.path, ref.path.endsWith('.json') ? '' : 'tsconfig.json')
          if (!local(target)) { fail(file, 'references 超出扫描根。'); continue }
          // References form a project graph, not an inheritance stack. A
          // referenced child may legitimately extend this solution config.
          active.add(target)
        }
      }
    }
    loading.delete(file); cache.set(file, config)
    return config
  }
  for (const file of files) if (/^(?:ts|js)config\.json$/.test(path.posix.basename(file))) active.add(file)
  for (const file of active) load(file)
  return [...active].map(file => cache.get(file) ?? load(file))
}

function matches(pattern: string, file: string): boolean | null {
  const expanded = /[*?]/.test(pattern) || /\.[^/]+$/.test(pattern) ? pattern : path.posix.join(pattern, '**/*')
  const regex = glob(expanded, false)
  return regex?.test(file) ?? null
}
export function configFor(configs: readonly JsConfig[], file: string): JsConfig[] {
  const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  return configs.filter(config => {
    if (config.files?.some(value => key(value) === key(file))) return true
    if (config.invalid) return under(config.dir, file)
    if (/\.html$/.test(file) || /\.[cm]?jsx?$/.test(file) && !(config.allowJs ?? path.posix.basename(config.file) === 'jsconfig.json')) return false
    if (config.include === undefined && config.files !== undefined) return false
    const include = config.include ?? [path.posix.join(config.dir, '**/*')]
    const exclude = config.exclude ?? ['**/node_modules', '**/bower_components', '**/jspm_packages', ...[config.outDir, config.declarationDir].filter((value): value is string => value !== undefined)]
    return include.some(pattern => matches(pattern, file) !== false) && !exclude.some(pattern => matches(pattern, file) === true)
  })
}
