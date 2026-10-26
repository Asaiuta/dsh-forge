/**
 * Rust crates from Cargo.toml manifests: crate names, declared target roots and
 * path dependencies. Reads manifests as data; never runs cargo or build scripts.
 */
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { at, metadataReader, record, tomlError } from './metadata-reader.ts'
import { localPath } from './source-resolution.ts'
import type { ProjectContext, TraceDiagnostic } from './trace-evidence.ts'

export interface RustCrate {
  manifest: string
  /** Package directory (manifest directory). */
  dir: string
  /** Library crate name as written in `use` paths (`lib.name` or package name with `-` → `_`). */
  libName: string
  /** Declared or conventional lib root, workspace-relative; existence is checked at resolution. */
  libRoot: string
  /** Dependency alias (as used in paths) → dependency package directory; path dependencies only. */
  deps: Record<string, string>
}
export interface RustCrates {
  crates: RustCrate[]
  /** Target roots declared with `path =` ([lib], [[bin]], [[test]], [[example]], [[bench]]). */
  roots: string[]
}
export interface RustProject extends ProjectContext, RustCrates { issues: TraceDiagnostic[] }

export const cargoMetadata = (name: string): boolean => name === 'Cargo.toml'

const DEP_TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies']
const TARGET_TABLES = ['bin', 'test', 'example', 'bench']
const crateName = (name: string): string => name.replaceAll('-', '_')

export function loadRustProject(root: string, files: readonly string[], signal?: AbortSignal): RustProject {
  const { read, issues, signature } = metadataReader(root, 'Cargo', signal)
  const manifests = new Map<string, unknown>()
  for (const file of files) {
    const text = read(file)
    if (text === null) continue
    try { manifests.set(file, parseToml(text)) } catch (cause) {
      issues.push({ path: file, reason: 'metadata_parse', message: tomlError(cause) })
    }
  }
  /** Nearest enclosing manifest that declares [workspace] (a package manifest may declare both). */
  const workspaceOf = (dir: string): { file: string; data: unknown } | null => {
    for (let current = dir; ; current = path.posix.dirname(current)) {
      const file = current === '.' ? 'Cargo.toml' : `${current}/Cargo.toml`
      const data = manifests.get(file)
      if (data !== undefined && record(at(data, 'workspace'))) return { file, data }
      if (current === '.') return null
    }
  }
  const crates: RustCrate[] = [], roots: string[] = []
  const pending: Array<{ deps: Array<{ key: string; renamed: boolean; dir: string }>; crate: RustCrate }> = []
  for (const [file, data] of manifests) {
    const name = at(data, 'package', 'name')
    if (typeof name !== 'string') continue // virtual workspace manifest
    const dir = path.posix.dirname(file)
    const declaredRoot = (value: unknown, key: string): string | null => {
      if (value === undefined) return null
      const target = typeof value === 'string' ? localPath(dir, value) : null
      if (target === null) { issues.push({ path: file, reason: 'unsupported_config', message: `${key} 不是扫描根内的相对路径。` }); return null }
      if (!roots.includes(target)) roots.push(target)
      return target
    }
    const libPath = declaredRoot(at(data, 'lib', 'path'), 'lib.path')
    for (const table of TARGET_TABLES) {
      const targets = at(data, table)
      if (Array.isArray(targets)) for (const target of targets) declaredRoot(at(target, 'path'), `[[${table}]].path`)
    }
    const libName = at(data, 'lib', 'name')
    const deps: Array<{ key: string; renamed: boolean; dir: string }> = []
    const workspace = workspaceOf(dir)
    const addDeps = (table: unknown, where: string): void => {
      for (const [alias, spec] of Object.entries(record(table) ?? {})) {
        let base = dir, relative = at(spec, 'path'), renamed = typeof at(spec, 'package') === 'string'
        if (at(spec, 'workspace') === true && workspace) {
          const inherited = at(workspace.data, 'workspace', 'dependencies', alias)
          base = path.posix.dirname(workspace.file)
          relative = at(inherited, 'path')
          renamed ||= typeof at(inherited, 'package') === 'string'
        }
        if (typeof relative !== 'string') continue // registry / git dependency: external
        const target = localPath(base, relative)
        if (target === null) { issues.push({ path: file, reason: 'unsupported_config', message: `${where}.${alias} 的 path 越出扫描根。` }); continue }
        deps.push({ key: alias, renamed, dir: target })
      }
    }
    for (const table of DEP_TABLES) addDeps(at(data, table), table)
    for (const [cfg, target] of Object.entries(record(at(data, 'target')) ?? {})) {
      for (const table of DEP_TABLES) addDeps(at(target, table), `target.${cfg}.${table}`)
    }
    pending.push({ deps, crate: {
      manifest: file, dir, deps: {},
      libName: crateName(typeof libName === 'string' ? libName : name),
      libRoot: libPath ?? (dir === '.' ? 'src/lib.rs' : `${dir}/src/lib.rs`),
    } })
  }
  // The name a dependency has in code is its lib target name, unless the
  // dependency is renamed with `package = "…"` (then it is the table key).
  const byDir = new Map(pending.map(item => [item.crate.dir, item.crate]))
  for (const { deps, crate } of pending) {
    for (const dep of deps) {
      const target = byDir.get(dep.dir)
      crate.deps[dep.renamed || !target ? crateName(dep.key) : target.libName] = dep.dir
    }
    crates.push(crate)
  }
  crates.sort((a, b) => a.manifest.localeCompare(b.manifest))
  roots.sort()
  return { crates, roots, issues, signature: signature([crates, roots]), valid: () => true }
}
