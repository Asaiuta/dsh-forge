/** Workspace input discovery shared by capture, plans and applicability. */
import path from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import ignore from 'ignore'
import { BINARY_EXTENSIONS } from './binary-facts.ts'
import { TRACE_SCAN_EXTENSIONS } from './trace-capabilities.ts'
import { projectMetadata } from './js-project.ts'
import { pythonMetadata } from './python-project.ts'
import { cargoMetadata } from './rust-project.ts'
import { goMetadata } from './go-project.ts'
import { sha256Hex } from './source-evidence.ts'

const FILE_CAP = 20_000
const WALK_VISIT_CAP = 200_000

/** Rules per root, reused while .gitignore is unchanged: the matcher caches
 *  each path's verdict, which a fresh instance per scan would discard. */
const IGNORE_RULES = new Map<string, { text: string; rules: ReturnType<typeof ignore> }>()

/** Collect supported source, HTML, manifests and binaries, root-.gitignore-aware, capped.
 *
 *  This is the reference the sidecar walk in `rust_indexer/src/candidates.rs`
 *  is held to, entry for entry and order included: tests/run-trace-candidates
 *  compares the two lists outright, so a rule that drifts on one side and not
 *  the other fails the suite instead of quietly changing what gets scanned. */
export function collectCandidatesLocal(root: string, signal?: AbortSignal): { files: Array<{ abs: string; rel: string }>; projectFiles: string[]; pythonFiles: string[]; cargoFiles: string[]; goFiles: string[]; truncated: boolean; walkErrors: number; ignoreHash?: string | null } {
  let walkErrors = 0
  let text = ''
  let ignoreHash: string | null = null
  const gitignore = path.join(root, '.gitignore')
  if (existsSync(gitignore)) {
    try {
      const raw = readFileSync(gitignore)
      text = raw.toString('utf8')
      ignoreHash = sha256Hex(raw)
    } catch { walkErrors++ }
  }
  let cached = IGNORE_RULES.get(root)
  if (!cached || cached.text !== text) {
    cached = { text, rules: ignore().add(text) }
    IGNORE_RULES.delete(root)
    IGNORE_RULES.set(root, cached)
    if (IGNORE_RULES.size > 8) IGNORE_RULES.delete(IGNORE_RULES.keys().next().value!)
  }
  const rules = cached.rules
  const files: Array<{ abs: string; rel: string }> = []
  const projectFiles: string[] = []
  const pythonFiles: string[] = []
  const cargoFiles: string[] = []
  const goFiles: string[] = []
  let visited = 0
  let truncated = false
  const walk = (dir: string, prefix = ''): void => {
    signal?.throwIfAborted()
    if (files.length >= FILE_CAP || visited > WALK_VISIT_CAP) {
      truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      walkErrors++
      return
    }
    for (const entry of entries) {
      if (files.length >= FILE_CAP || visited > WALK_VISIT_CAP) {
        truncated = true
        return
      }
      visited++
      const abs = path.join(dir, entry.name)
      const rel = prefix + entry.name
      if (rules.ignores(rel)) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh') continue
        // Host-owned artifact containers (any dot-directory carrying the _dsh
        // marker, e.g. .workbuddy/_dsh/asar-out) are runtime dumps, not
        // workspace source — detection is structural, never by directory name.
        if (entry.name.startsWith('.') && existsSync(path.join(abs, '_dsh'))) continue
        walk(abs, rel + '/')
      } else if (entry.isFile()) {
        if (projectMetadata(entry.name)) projectFiles.push(rel)
        if (pythonMetadata(entry.name)) pythonFiles.push(rel)
        if (cargoMetadata(entry.name)) cargoFiles.push(rel)
        if (goMetadata(entry.name)) goFiles.push(rel)
        if (TRACE_SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.name === 'go.mod') files.push({ abs, rel })
      }
    }
  }
  walk(root)
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), projectFiles: projectFiles.sort(), pythonFiles: pythonFiles.sort(), cargoFiles: cargoFiles.sort(), goFiles: goFiles.sort(), truncated, walkErrors, ignoreHash }
}

export function candidateFilesOf(candidates: Pick<ReturnType<typeof collectCandidatesLocal>, 'files' | 'projectFiles' | 'pythonFiles' | 'cargoFiles' | 'goFiles'>): string[] {
  return [...new Set([...candidates.files.map(file => file.rel), ...candidates.projectFiles, ...candidates.pythonFiles, ...candidates.cargoFiles, ...candidates.goFiles])].sort()
}

/** Added/deleted inputs and an incomplete walk invalidate the observed set. */
export function candidateSetDrift(workspace: string, expected: readonly string[]): string[] {
  const current = collectCandidatesLocal(workspace)
  const actual = new Set(candidateFilesOf(current))
  const previous = new Set(expected)
  const drifted = [...actual].filter(file => !previous.has(file))
  for (const file of previous) if (!actual.has(file)) drifted.push(file)
  if (current.truncated || current.walkErrors > 0) drifted.push('(incomplete source discovery)')
  return drifted
}
