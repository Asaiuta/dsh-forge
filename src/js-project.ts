/** Read only local project metadata and track every input used by graph assembly. */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { canonicalTarget, readBoundedFile, within } from './fs-paths.ts'
import { configFor, loadConfigs, local, object, parseJsonc, type JsConfig } from './js-config.ts'
import { packageResolver, pnpmPatterns, type JsPackage } from './js-packages.ts'
import { configuredJs, relativeJs } from './js-resolution.ts'
import type { JsReference } from './facts.ts'
import { unresolved, type JsResolution, type JsResolver, type TraceDiagnostic } from './trace-evidence.ts'

/** Membership pushes beyond this stop closure expansion; unexpanded files keep the no-fallback guard. */
const CLOSURE_BUDGET = 100_000
const TS_FILE = /\.(?:[cm]?tsx?)$/
const JS_FILE = /\.(?:[cm]?jsx?)$/

export interface JsProject {
  signature: string
  resolve: JsResolver
  issues: TraceDiagnostic[]
  configs: number
  workspacePackages: number
  valid: () => boolean
}
export const projectMetadata = (name: string): boolean => name === 'package.json' || name === 'pnpm-workspace.yaml'
  || /^(?:ts|js)config(?:\.[^/]+)?\.json$/.test(name)

export function loadJsProject(root: string, files: readonly string[], signal?: AbortSignal, knownFiles: ReadonlySet<string> = new Set(), jsRefs: ReadonlyMap<string, ReadonlyArray<JsReference>> = new Map()): JsProject {
  const issues: TraceDiagnostic[] = [], reads = new Map<string, string | null>(), stamps: unknown[] = [], probes = new Map<string, string | null>()
  let bytes = 0, canonicalRoot: string | null = null
  try { canonicalRoot = realpathSync(root) } catch { /* scanFacts reports inaccessible roots */ }
  const identity = (file: string): string | null => { try { return canonicalTarget(path.resolve(root, file)) } catch { return null } }
  const read = (file: string): string | null => {
    signal?.throwIfAborted()
    if (reads.has(file)) return reads.get(file) ?? null
    const target = local(file) ? identity(file) : null
    try {
      if (reads.size >= 2000 || bytes >= 8 * 1024 * 1024) throw new Error('超过工程元数据预算（2,000 个文件 / 8 MiB）。')
      if (!target || !canonicalRoot || !within(canonicalRoot, target)) throw new Error('工程元数据路径超出扫描根或无法确认身份。')
      const data = readBoundedFile(path.resolve(root, file), Math.min(256 * 1024, 8 * 1024 * 1024 - bytes))
      bytes += data.length
      stamps.push([file, target, createHash('sha256').update(data).digest('hex')])
      const text = data.toString('utf8'); reads.set(file, text); return text
    } catch (cause) {
      reads.set(file, null); stamps.push([file, target, 'failed'])
      issues.push({ path: file, reason: 'metadata_read', message: cause instanceof Error ? cause.message : String(cause) })
      return null
    }
  }
  const readObject = (file: string): Record<string, unknown> | null => {
    const text = read(file)
    if (text === null) return null
    try {
      const value: unknown = file.endsWith('package.json') ? JSON.parse(text.replace(/^\uFEFF/, '')) : parseJsonc(text)
      if (!object(value)) throw new Error('工程元数据必须是 JSON 对象。')
      return value
    } catch (cause) {
      issues.push({ path: file, reason: 'metadata_parse', message: cause instanceof Error ? cause.message.slice(0, 240) : '无效 JSON。' })
      return null
    }
  }
  const packages: JsPackage[] = []
  let pnpm: string[] | null | undefined
  for (const file of files) {
    if (path.posix.basename(file) === 'package.json') {
      const data = readObject(file)
      packages.push({ file, dir: path.posix.dirname(file), data: data ?? {} })
    } else if (file === 'pnpm-workspace.yaml') {
      const text = read(file); pnpm = text === null ? null : pnpmPatterns(text)
    }
  }
  const configs = loadConfigs(files, readObject, issues), packagesIndex = packageResolver(packages, pnpm, issues)
  // TypeScript program membership, propagated per config: roots come from
  // files/include/exclude; the closure then follows only program-expanding
  // references — static imports, `import = require()` and literal dynamic
  // imports. A plain `require()` written in TS never expands the program;
  // CommonJS `require()` inside JS members does. allowJs decides whether a
  // reached JS file joins (and keeps expanding); noResolve keeps roots only.
  // File dependency edges alone are never membership.
  const memberConfigs = new Map<string, JsConfig[]>()
  let closureLimited = false
  if (jsRefs.size && configs.length) {
    let pushes = 0
    const knownIsFile = (file: string): boolean => knownFiles.has(file)
    for (const config of configs) {
      if (config.invalid) continue
      signal?.throwIfAborted()
      const allowJs = config.allowJs ?? path.posix.basename(config.file) === 'jsconfig.json'
      const queue: string[] = []
      for (const file of knownFiles) {
        if (!(TS_FILE.test(file) || (allowJs && JS_FILE.test(file)))) continue
        if (configFor([config], file).length) queue.push(file)
      }
      if (!queue.length) continue
      const seen = new Set<string>()
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const file = queue[cursor]
        if (seen.has(file)) continue
        seen.add(file)
        const owners = memberConfigs.get(file)
        if (owners) { if (!owners.includes(config)) owners.push(config) }
        else memberConfigs.set(file, [config])
        if (++pushes > CLOSURE_BUDGET) { closureLimited = true; break }
        if (config.noResolve) continue
        for (const { mode, ref, syntax } of jsRefs.get(file) ?? []) {
          if (ref.unresolved || !ref.spec) continue
          const fromJs = (syntax ?? (JS_FILE.test(file) ? 'javascript' : 'typescript')) === 'javascript'
          if (!(mode === 'import' || mode === 'dynamic_import' || (mode === 'require' && (ref.importEquals || fromJs)))) continue
          const resolution: JsResolution | null = ref.spec.startsWith('.') || ref.spec.startsWith('/')
            ? relativeJs(file, ref.spec, mode, knownIsFile, syntax)
            : configuredJs(config, ref.spec, knownIsFile)
          if (resolution?.status !== 'resolved') continue
          for (const target of resolution.targets) {
            if (!knownFiles.has(target.to) || seen.has(target.to)) continue
            if (TS_FILE.test(target.to) || (allowJs && JS_FILE.test(target.to))) queue.push(target.to)
          }
        }
      }
    }
  }
  let blocked = false
  const safeFile = (isFile: (file: string) => boolean) => (file: string): boolean => {
    if (!local(file) || !isFile(file)) return false
    if (knownFiles.has(file)) return true
    let target = probes.get(file)
    if (!probes.has(file)) { target = identity(file); probes.set(file, target) }
    const inside = Boolean(target && canonicalRoot && within(canonicalRoot, target))
    if (!inside) blocked = true
    return inside
  }
  /** Apply every owner config's paths/baseUrl; disagreeing mappings stop as ambiguity. */
  const configuredTargets = (owners: readonly JsConfig[], spec: string, check: (file: string) => boolean): JsResolution | null => {
    const hits: Array<{ to: string; evidence: import('./trace-evidence.ts').EdgeEvidence }> = []
    let failure: JsResolution | null = null
    for (const config of owners) {
      const result = configuredJs(config, spec, check)
      if (!result) continue
      if (result.status === 'resolved') hits.push(...result.targets)
      else failure ??= result
    }
    const distinct = [...new Map(hits.map(target => [target.to, target])).values()]
    if (distinct.length > 1) return unresolved('ambiguous_target', '多个工程配置把该导入映射到不同文件。')
    if (distinct.length === 1) return { status: 'resolved', targets: distinct }
    return failure
  }
  const resolve: JsResolver = (from, spec, mode, isFile, syntax) => {
    if (!spec || spec.includes('\0') || spec.includes('\\')) return unresolved('unsupported_resolution', '无效或非规范模块路径。')
    const check = safeFile(isFile)
    blocked = false
    const applicable = configFor(configs, from)
    if (applicable.some(config => config.invalid)) return unresolved('unsupported_config', '工程配置不完整，已停止路径推断。', applicable[0].file)
    const members = memberConfigs.get(from) ?? []
    const owners = [...applicable, ...members.filter(config => !applicable.includes(config))]
    if (!owners.length && !spec.startsWith('.') && !spec.startsWith('/') && /\.[cm]?tsx?$/.test(from)
      && configs.some(config => config.paths?.length || config.baseUrl !== undefined || config.module !== undefined)) {
      return unresolved('unsupported_config', '未确认该文件的工程归属：不在任何已识别 program 的 files/include 或导入闭包内，已停止包名回退。')
    }
    let packageMode: 'import' | 'require' | 'unknown' = mode === 'dynamic_import' ? 'import' : mode
    if (mode === 'import' && /\.[cm]?tsx?$/.test(from)) {
      const module = owners.length === 1 ? owners[0].module : undefined
      packageMode = /\.cts$/.test(from) ? 'require' : /\.mts$/.test(from) ? 'import'
        : module === 'commonjs' ? 'require' : module && /^node(?:16|18|20|next)$/.test(module) ? packagesIndex.nodeMode(from)
          : module && /^(?:es6|es2015|es2020|es2022|esnext|preserve)$/.test(module) ? 'import' : 'unknown'
    }
    const result = spec.startsWith('.') || spec.startsWith('/') ? relativeJs(from, spec, mode, check, syntax)
      : configuredTargets(owners, spec, check) ?? packagesIndex.resolve(from, spec, packageMode, check)
    return blocked ? unresolved('outside_root', '目标通过目录或文件链接指向扫描根外，已停止推断。') : result
  }
  return { signature: JSON.stringify([canonicalRoot, stamps, [...memberConfigs.entries()].map(([file, list]) => [file, list.map(config => config.file)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), closureLimited]), resolve, issues, configs: configs.length, workspacePackages: packagesIndex.workspacePackages,
    valid: () => [...probes].every(([file, expected]) => identity(file) === expected) }
}
