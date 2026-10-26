/**
 * Python package roots from local packaging metadata. Reads pyproject.toml and
 * setup.cfg as data; never runs setup.py, a build backend or an interpreter.
 */
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { at, metadataReader, record, strings, tomlError } from './metadata-reader.ts'
import { localPath } from './source-resolution.ts'
import type { ProjectContext, TraceDiagnostic } from './trace-evidence.ts'

export interface PythonRoot {
  /** Workspace-relative search root. */
  dir: string
  /** Declared by packaging metadata (certain) or inferred from layout (candidate). */
  declared: boolean
  source: string
}
/** `package-dir = { pkg = "lib/pkg" }`: one top-level package mapped to a directory. */
export interface PythonPackageDir { name: string; dir: string; source: string }
export interface PythonRoots { roots: PythonRoot[]; packageDirs: PythonPackageDir[] }
export interface PythonProject extends ProjectContext, PythonRoots { issues: TraceDiagnostic[] }

export const pythonMetadata = (name: string): boolean => name === 'pyproject.toml' || name === 'setup.cfg'

/** Minimal INI reader for setup.cfg: sections, `key = value` and indented continuation lines. */
function parseSetupCfg(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>()
  let section: Map<string, string> | undefined, key: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:[#;]|$)/.test(raw)) continue
    const header = /^\[([^\]]+)\]\s*$/.exec(raw)
    if (header) { section = new Map(); sections.set(header[1].trim(), section); key = undefined; continue }
    if (!section) continue
    if (/^\s/.test(raw) && key !== undefined) { section.set(key, `${section.get(key)}\n${raw.trim()}`); continue }
    const pair = /^([^=:]+)[=:](.*)$/.exec(raw)
    if (!pair) continue
    key = pair[1].trim().toLowerCase().replaceAll('-', '_')
    section.set(key, pair[2].trim())
  }
  return sections
}

export function loadPythonProject(root: string, files: readonly string[], pythonFiles: Iterable<string>, signal?: AbortSignal): PythonProject {
  const { read, issues, signature } = metadataReader(root, 'Python', signal)
  const roots: PythonRoot[] = [], packageDirs: PythonPackageDir[] = []
  const explicit = new Set<string>()
  const addRoot = (file: string, base: string, value: string, declared: boolean, key: string): void => {
    const dir = localPath(base, value)
    if (dir === null) { issues.push({ path: file, reason: 'unsupported_config', message: `${key} 指向扫描根外或不是相对路径：${value}` }); return }
    if (declared) explicit.add(path.posix.dirname(file))
    if (dir === '.') return // the workspace root is always searched first
    if (!roots.some(item => item.dir === dir && item.declared === declared)) roots.push({ dir, declared, source: `${file} · ${key}` })
  }
  const addPackageDir = (file: string, base: string, name: string, value: string, key: string): void => {
    const dir = localPath(base, value)
    if (dir === null || !/^[A-Za-z_]\w*$/.test(name)) { issues.push({ path: file, reason: 'unsupported_config', message: `${key} 条目无法使用：${name} = ${value}` }); return }
    explicit.add(path.posix.dirname(file))
    packageDirs.push({ name, dir, source: `${file} · ${key}` })
  }

  for (const file of files) {
    const base = path.posix.dirname(file)
    const text = read(file)
    if (text === null) continue
    if (path.posix.basename(file) === 'pyproject.toml') {
      let data: unknown
      try { data = parseToml(text) } catch (cause) {
        issues.push({ path: file, reason: 'metadata_parse', message: tomlError(cause) })
        continue
      }
      const packageDir = record(at(data, 'tool', 'setuptools', 'package-dir'))
      for (const [name, value] of Object.entries(packageDir ?? {})) {
        if (typeof value !== 'string') continue
        if (name === '') addRoot(file, base, value, true, 'tool.setuptools.package-dir')
        else addPackageDir(file, base, name, value, 'tool.setuptools.package-dir')
      }
      for (const where of strings(at(data, 'tool', 'setuptools', 'packages', 'find', 'where')) ?? []) addRoot(file, base, where, true, 'tool.setuptools.packages.find.where')
      const poetry = at(data, 'tool', 'poetry', 'packages')
      if (Array.isArray(poetry)) for (const item of poetry) {
        const from = at(item, 'from')
        if (typeof at(item, 'include') === 'string') addRoot(file, base, typeof from === 'string' ? from : '.', true, 'tool.poetry.packages')
      }
      for (const pkg of strings(at(data, 'tool', 'hatch', 'build', 'targets', 'wheel', 'packages')) ?? []) {
        addRoot(file, base, path.posix.dirname(pkg.replace(/\/+$/, '')), true, 'tool.hatch.build.targets.wheel.packages')
      }
      const pdm = at(data, 'tool', 'pdm', 'build', 'package-dir')
      if (typeof pdm === 'string') addRoot(file, base, pdm, true, 'tool.pdm.build.package-dir')
      const maturin = at(data, 'tool', 'maturin', 'python-source')
      if (typeof maturin === 'string') addRoot(file, base, maturin, true, 'tool.maturin.python-source')
    } else {
      const sections = parseSetupCfg(text)
      const packageDir = sections.get('options')?.get('package_dir')
      if (packageDir !== undefined) for (const line of packageDir.split('\n')) {
        const pair = /^([^=]*)=(.*)$/.exec(line.trim())
        if (!pair) continue
        const name = pair[1].trim(), value = pair[2].trim()
        if (name === '') addRoot(file, base, value, true, 'options.package_dir')
        else addPackageDir(file, base, name, value, 'options.package_dir')
      }
      for (const where of sections.get('options.packages.find')?.get('where')?.split(/[\n,]/).map(item => item.trim()).filter(Boolean) ?? []) {
        addRoot(file, base, where, true, 'options.packages.find.where')
      }
    }
  }
  // Layout conventions are candidates only: a nested project directory
  // without explicit roots (setuptools flat auto-discovery) and src/ layouts.
  for (const file of files) {
    const base = path.posix.dirname(file)
    if (base !== '.' && !explicit.has(base)) addRoot(file, base, '.', false, '工程目录（flat layout 约定）')
  }
  for (const file of pythonFiles) {
    const match = /^(?:(.*)\/)?src\/[A-Za-z_]\w*\/__init__\.pyi?$/.exec(file)
    if (!match) continue
    const dir = match[1] ? `${match[1]}/src` : 'src'
    if (!roots.some(item => item.dir === dir)) roots.push({ dir, declared: false, source: `${file} · src/ layout 约定` })
  }
  roots.sort((a, b) => Number(b.declared) - Number(a.declared) || a.dir.localeCompare(b.dir))
  return { roots, packageDirs, issues, signature: signature([roots, packageDirs]), valid: () => true }
}
