/** Local workspace package maps, retaining conditional branches as candidates. */
import path from 'node:path'
import { glob, local, object, strings, under } from './js-config.ts'
import { jsFile, mappingKey } from './js-resolution.ts'
import { unresolved, type JsResolution, type TraceDiagnostic } from './trace-evidence.ts'

export interface JsPackage { file: string; dir: string; data: Record<string, unknown> }
interface Selection { targets: string[]; conditional: boolean; invalid?: true }

/** Literal pnpm packages block; complex YAML is reported instead of evaluated. */
export function pnpmPatterns(text: string): string[] | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const start = lines.findIndex(line => /^packages\s*:/.test(line))
  if (start < 0) return []
  if (!/^packages\s*:\s*(?:#.*)?$/.test(lines[start])) return null
  const patterns: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (/^\S/.test(line)) break
    const match = /^\s+-\s+(?:'([^']*)'|"([^"\\]*)"|([^\s#'"\[\]{}&*!][^#]*?))\s*(?:#.*)?$/.exec(line)
    if (!match) return null
    patterns.push((match[1] ?? match[2] ?? match[3]).trim())
  }
  return patterns
}

function select(value: unknown, mode: 'import' | 'require', types: boolean, depth = 0): Selection {
  if (depth > 16) return { targets: [], conditional: true, invalid: true }
  if (typeof value === 'string') return { targets: [value], conditional: false }
  if (value === null) return { targets: [], conditional: false }
  if (!object(value)) return { targets: [], conditional: false, invalid: true }
  const targets: string[] = []
  for (const [condition, branch] of Object.entries(value)) {
    if (condition.startsWith('.') || /^\d+$/.test(condition)) return { targets: [], conditional: true, invalid: true }
    if (condition === (mode === 'import' ? 'require' : 'import') || condition === 'types' && !types) continue
    const selection = select(branch, mode, types, depth + 1)
    if (selection.invalid) return selection
    targets.push(...selection.targets)
    // import/require/default are known for this syntax. Environment-specific
    // branches (node/browser/custom/types) may differ and remain candidates.
    if (condition === mode || condition === 'default') break
  }
  return { targets: [...new Set(targets)], conditional: true, ...(targets.length > 32 ? { invalid: true } : {}) }
}

function mapped(value: unknown, spec: string, exports: boolean, mode: 'import' | 'require', types: boolean): Selection | null {
  let selected = value, capture = ''
  if (object(value) && Object.keys(value).some(key => exports ? key.startsWith('.') : key.startsWith('#'))) {
    if (Object.keys(value).some(key => exports ? !key.startsWith('.') : !key.startsWith('#'))) return { targets: [], conditional: false, invalid: true }
    const match = mappingKey(Object.keys(value), spec, true)
    if (!match) return null
    selected = value[match.key]; capture = match.capture
  } else if (!exports || spec !== '.') return null
  const selection = select(selected, mode, types)
  return { ...selection, targets: selection.targets.map(target => target.replaceAll('*', capture)) }
}

export function packageResolver(packages: readonly JsPackage[], pnpm: string[] | null | undefined, issues: TraceDiagnostic[]) {
  const reported = new Set<string>()
  const missingBranch = (pkg: JsPackage, target: string): void => {
    const key = pkg.file + ':' + target
    if (reported.has(key)) return
    reported.add(key)
    issues.push({ path: pkg.file, reason: 'conditional_target_missing', message: '条件分支目标未解析：' + target + '；已保留其他可用候选。' })
  }
  const root = packages.find(pkg => pkg.dir === '.')
  const workspaces = root?.data.workspaces
  const npm = workspaces === undefined ? [] : strings(workspaces) ? workspaces : object(workspaces) && strings(workspaces.packages) ? workspaces.packages : null
  if (npm === null) issues.push({ path: 'package.json', reason: 'unsupported_config', message: 'workspaces 必须是路径模式数组或包含 packages 数组的对象。' })
  if (pnpm === null) issues.push({ path: 'pnpm-workspace.yaml', reason: 'unsupported_config', message: '仅支持字面量 packages 列表，不解析复杂 YAML。' })
  const patterns = [...npm ?? [], ...pnpm ?? []]
  const positive = patterns.filter(pattern => !pattern.startsWith('!')).map(pattern => glob(pattern.replace(/^\.\//, '').replace(/\/$/, '')))
  const negative = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => glob(pattern.slice(1).replace(/^\.\//, '').replace(/\/$/, '')))
  const unsupported = positive.includes(null) || negative.includes(null) || npm === null || pnpm === null
  if (positive.includes(null) || negative.includes(null)) issues.push({ path: 'package.json', reason: 'unsupported_config', message: 'workspace 模式仅支持 *、**、?。' })
  const workspace = packages.filter(pkg => !unsupported && pkg.dir !== '.' && positive.some(pattern => pattern!.test(pkg.dir)) && !negative.some(pattern => pattern!.test(pkg.dir)))
  const byName = new Map<string, JsPackage[]>()
  for (const pkg of workspace) if (typeof pkg.data.name === 'string') {
    const list = byName.get(pkg.data.name) ?? []; list.push(pkg); byName.set(pkg.data.name, list)
  }
  const owner = (from: string): JsPackage | undefined => packages.filter(pkg => under(pkg.dir, from)).sort((a, b) => (b.dir === '.' ? 0 : b.dir.length) - (a.dir === '.' ? 0 : a.dir.length))[0]
  const resolve = (from: string, spec: string, mode: 'import' | 'require' | 'unknown', isFile: (file: string) => boolean, depth = 0, types = /\.[cm]?tsx?$/.test(from)): JsResolution => {
    if (depth > 16) return unresolved('unsupported_config', '包 imports 映射循环或超过深度预算。')
    if (mode === 'unknown') {
      const alternatives = (['import', 'require'] as const).map(variant => resolve(from, spec, variant, isFile, depth, types))
      const first = alternatives[0], second = alternatives[1]
      if (first.status === 'resolved' && second.status === 'resolved'
        && first.targets.every(target => target.evidence.confidence === 'certain')
        && JSON.stringify(first.targets) === JSON.stringify(second.targets)) return first
      const targets = new Map<string, { to: string; evidence: { confidence: 'candidate'; basis: string; config?: string } }>()
      for (const alternative of alternatives) if (alternative.status === 'resolved') for (const target of alternative.targets) {
        targets.set(target.to, { to: target.to, evidence: { ...target.evidence, confidence: 'candidate' } })
      }
      return targets.size ? { status: 'resolved', targets: [...targets.values()] } : alternatives[0]
    }
    if (spec === '#' || spec.startsWith('#/')) return unresolved('unsupported_resolution', '无效的 package imports 名称。')
    const self = owner(from)
    let pkg: JsPackage | undefined, selection: Selection | null, basis: string
    if (spec.startsWith('#')) {
      pkg = self; basis = 'package_imports'
      if (!pkg || pkg.data.imports === undefined) return unresolved('missing_target', '所属包未声明 imports。', pkg?.file)
      selection = mapped(pkg.data.imports, spec, false, mode, types)
    } else {
      const parts = spec.split('/'), name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
      const subpath = spec.slice(name.length), candidates = self?.data.name === name && self.data.exports != null ? [self] : byName.get(name) ?? []
      if (candidates.length > 1) return unresolved('ambiguous_target', 'workspace 中存在同名包。')
      pkg = candidates[0]; basis = 'package_exports'
      if (!pkg) return unresolved(unsupported ? 'unsupported_config' : 'external_package')
      if (pkg.data.exports != null) selection = mapped(pkg.data.exports, '.' + subpath, true, mode, types)
      else {
        basis = 'workspace_package'
        const main = types && typeof (pkg.data.types ?? pkg.data.typings) === 'string' ? pkg.data.types ?? pkg.data.typings : pkg.data.main
        const target = subpath ? '.' + subpath : typeof main === 'string' ? main : './index'
        selection = { targets: [target.startsWith('./') ? target : './' + target], conditional: Boolean(types && (pkg.data.types || pkg.data.typings)) }
      }
    }
    if (selection?.invalid) return unresolved('unsupported_config', '包映射数组、无效条件或过深分支尚未支持。', pkg.file)
    if (!selection || !selection.targets.length) return unresolved('missing_target', '包映射未暴露该入口，或入口显式禁用。', pkg.file)
    const targets: Array<{ to: string; evidence: { confidence: 'certain' | 'candidate'; basis: string; config: string } }> = []
    for (const target of selection.targets) {
      if (!target.startsWith('./')) {
        if (basis !== 'package_imports') return unresolved('unsupported_config', 'exports 目标必须以 ./ 开头。', pkg.file)
        const nested = resolve(path.posix.join(pkg.dir, types ? '__imports__.ts' : '__imports__.js'), target, mode, isFile, depth + 1, types)
        if (nested.status !== 'resolved') {
          if (selection.conditional) { missingBranch(pkg, target); continue }
          return nested
        }
        targets.push(...nested.targets.map(item => ({ to: item.to, evidence: { confidence: selection.conditional ? 'candidate' as const : item.evidence.confidence, basis, config: pkg.file } })))
        continue
      }
      if (target.slice(2).split('/').some(part => part === '.' || part === '..' || /^node_modules$/i.test(part)) || /[%\\\0]/.test(target)) return unresolved('unsupported_config', '包目标包含非法目录段或转义路径。', pkg.file)
      const base = path.posix.join(pkg.dir, target)
      if (!local(base)) return unresolved('outside_root', undefined, pkg.file)
      // exports/imports use exact filenames. Legacy package entries may use
      // extension/index search; missing first targets never select later maps.
      const to = basis === 'workspace_package' ? jsFile(base, isFile) : isFile(base) ? base : null
      if (!to) {
        if (selection.conditional) { missingBranch(pkg, target); continue }
        return unresolved('missing_target', '包目标文件不存在。', pkg.file)
      }
      targets.push({ to, evidence: { confidence: selection.conditional ? 'candidate' : 'certain', basis, config: pkg.file } })
    }
    return targets.length ? { status: 'resolved', targets } : unresolved('missing_target', '条件分支均无可用根内目标。', pkg.file)
  }
  return { resolve, workspacePackages: workspace.length, nodeMode: (from: string): 'import' | 'require' => owner(from)?.data.type === 'module' ? 'import' : 'require' }
}
