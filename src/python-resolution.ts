/** Python imports: workspace root as the only search root; no interpreter or sys.path. */
import path from 'node:path'
import { NOT_APPLICABLE, resolvedTo, unresolvedAs, withinRoot, type ResolvedModule, type SourceContext, type SourceResolver } from './source-resolution.ts'

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

export function pythonResolver({ isFile }: SourceContext): SourceResolver {
  return (fromRel, ref) => {
    if (ref.kind !== 'python_import' && ref.kind !== 'python_from' && ref.kind !== 'python_dynamic') return NOT_APPLICABLE
    if (ref.kind === 'python_dynamic' && ref.dynamic) return unresolvedAs('non_literal')
    const relative = ref.spec.startsWith('.')
    const base = ref.kind === 'python_dynamic' && relative && ref.package
      ? pythonBase(ref.package.replaceAll('.', '/') + '/__init__.py', ref.spec) : pythonBase(fromRel, ref.spec)
    if (!base) return unresolvedAs('outside_root', '相对导入越过扫描根的顶层包。')
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
    if (targets.length) return resolvedTo(targets)
    if (relative) return unresolvedAs('missing_target', '相对导入的目标模块文件不存在。')
    const top = base.split('/')[0]
    return pythonModule(top, isFile)
      ? unresolvedAs('missing_target', '本地顶层包存在，但其中没有该子模块。')
      : unresolvedAs('external_package', '扫描根下没有同名顶层模块，视为标准库或第三方包（src/ 布局与 pyproject 包根尚未支持）。')
  }
}
