/** Python imports: workspace root, then roots from packaging metadata; no interpreter or sys.path. */
import path from 'node:path'
import type { ModuleFact } from './module-facts.ts'
import { NOT_APPLICABLE, resolvedTo, unresolvedAs, withinRoot, type ResolvedModule, type SourceContext, type SourceResolution, type SourceResolver } from './source-resolution.ts'

function pythonBase(fromRel: string, spec: string): string | null {
  const dots = /^\.+/.exec(spec)?.[0].length ?? 0
  const dir = path.posix.dirname(fromRel)
  // The workspace root is the import search root. Relative imports cannot
  // climb beyond its top-level package (including namespace packages).
  const packageDepth = dir === '.' ? 0 : dir.split('/').length
  if (dots > packageDepth) return null
  const tail = spec.slice(dots).replaceAll('.', '/')
  const base = dots ? path.posix.join(dir, ...Array<string>(dots - 1).fill('..'), tail) : tail
  return base && withinRoot(base) ? base : null
}

function pythonModule(base: string, isFile: (rel: string) => boolean): { to: string; package: boolean } | null {
  const candidates = [
    { to: path.posix.join(base, '__init__.py'), package: true },
    ...(base === '.' ? [] : [{ to: `${base}.py`, package: false }]),
    { to: path.posix.join(base, '__init__.pyi'), package: true },
    ...(base === '.' ? [] : [{ to: `${base}.pyi`, package: false }]),
  ]
  return candidates.find(candidate => isFile(candidate.to)) ?? null
}

type PythonRef = Extract<ModuleFact, { kind: 'python_import' | 'python_from' | 'python_dynamic' }>

/** Module file plus from-import submodules found at one base directory. */
function targetsAt(base: string, ref: PythonRef, isFile: (rel: string) => boolean): ResolvedModule[] {
  const module = pythonModule(base, isFile)
  const targets: ResolvedModule[] = module ? [{ to: module.to }] : []
  if (ref.kind === 'python_from' && (!module || module.package)) {
    // A from-import can bind an attribute or a submodule; existence makes a
    // submodule a candidate, not proof that Python will load it at runtime.
    for (const name of ref.names) {
      const child = pythonModule(path.posix.join(base, name.replaceAll('.', '/')), isFile)
      if (child) targets.push({ to: child.to, candidate: true })
    }
  }
  return targets
}

export function pythonResolver({ isFile, python }: SourceContext): SourceResolver {
  const declared = python?.roots.filter(root => root.declared).map(root => root.dir) ?? []
  const inferred = python?.roots.filter(root => !root.declared).map(root => root.dir) ?? []
  const packageDirs = python?.packageDirs ?? []
  /** One search tier: a hit under exactly one root wins; hits under several roots are ambiguous. */
  const tier = (dirs: string[], base: string, ref: PythonRef, candidate: boolean): SourceResolution | null => {
    const hits = dirs.map(dir => targetsAt(path.posix.join(dir, base), ref, isFile)).filter(targets => targets.length)
    if (!hits.length) return null
    if (new Set(hits.map(targets => targets[0].to)).size > 1) return unresolvedAs('ambiguous_target', '多个 Python 包根下都有该模块；sys.path 顺序取决于安装方式。')
    return resolvedTo(candidate ? hits[0].map(target => ({ ...target, candidate: true as const })) : hits[0])
  }
  const exists = (base: string): boolean => [{ dir: '.' }, ...python?.roots ?? []].some(root => pythonModule(path.posix.join(root.dir, base), isFile) !== null)
    || packageDirs.some(item => item.name === base)
  return (fromRel, ref) => {
    if (ref.kind !== 'python_import' && ref.kind !== 'python_from' && ref.kind !== 'python_dynamic') return NOT_APPLICABLE
    if (ref.kind === 'python_dynamic' && ref.dynamic) return unresolvedAs('non_literal')
    const relative = ref.spec.startsWith('.')
    const base = ref.kind === 'python_dynamic' && relative && ref.package
      ? pythonBase(ref.package.replaceAll('.', '/') + '/__init__.py', ref.spec) : pythonBase(fromRel, ref.spec)
    if (!base) return unresolvedAs('outside_root', '相对导入越过扫描根的顶层包。')
    const local = targetsAt(base, ref, isFile)
    if (local.length) return resolvedTo(local)
    if (relative) return unresolvedAs('missing_target', '相对导入的目标模块文件不存在。')
    const [top, ...rest] = base.split('/')
    const mapped = packageDirs.filter(item => item.name === top)
    if (mapped.length) {
      const result = tier(mapped.map(item => item.dir), rest.join('/') || '.', ref, false)
      if (result) return result
    }
    const found = tier(declared, base, ref, false) ?? tier(inferred, base, ref, true)
    if (found) return found
    return exists(top)
      ? unresolvedAs('missing_target', '本地顶层包存在，但其中没有该子模块。')
      : unresolvedAs('external_package', '扫描根与已识别的 Python 包根下都没有同名顶层模块，视为标准库或第三方包。')
  }
}
