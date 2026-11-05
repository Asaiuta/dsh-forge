/**
 * The Git page's change list as a directory tree.
 *
 * `git status` answers with a flat list of repo-relative paths. Rendered flat, a
 * refactor touching `src/client/changes/*` reads as a wall of near-identical
 * rows: the shape of the change disappears. Folding into the tree every editor
 * shows restores it, including the single-child chain compression, so a row
 * always stands for a place where something actually changed.
 *
 * Pure — no React, no DOM — so the folding rules are testable without a browser.
 *
 * @module dsh-forge/client/change-tree
 */

/** One changed file, a leaf. */
export interface ChangeLeaf {
  kind: 'file'
  /** The file's own name (its last path segment). */
  name: string
  /** The repo-relative path as git reported it: the row's identity. */
  path: string
  status: string
  origPath: string | null
  added: number | null
  removed: number | null
  binary: boolean
}

/** One directory row: its children plus how many changed files sit beneath. */
export interface ChangeDir {
  kind: 'dir'
  /** Display label: one segment, or a compressed chain such as `src/client`. */
  name: string
  /** The deepest directory this row stands for. */
  path: string
  children: ChangeNode[]
  /** Changed files anywhere below this row. */
  changes: number
  open: boolean
}

export type ChangeNode = ChangeDir | ChangeLeaf

/** The minimal shape a caller must supply per file. */
export interface ChangeInput {
  path: string
  status: string
  origPath?: string | null
  added?: number | null
  removed?: number | null
  binary?: boolean
}

interface DirDraft {
  name: string
  path: string
  dirs: Map<string, DirDraft>
  files: ChangeLeaf[]
  open: boolean
}

/**
 * Pinned collation: directories first, then names case-insensitively with a
 * code-point tiebreak.
 *
 * Leaving this to the runtime's default locale would let the same change list
 * order differently on two machines.
 */
function compareNames(left: string, right: string): number {
  const collated = left.localeCompare(right, 'en', { sensitivity: 'base' })
  if (collated !== 0) return collated
  if (left === right) return 0
  return left < right ? -1 : 1
}

function compareNodes(left: ChangeNode, right: ChangeNode): number {
  if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
  return compareNames(left.name, right.name)
}

function countFiles(nodes: readonly ChangeNode[]): number {
  let count = 0
  for (const node of nodes) count += node.kind === 'dir' ? node.changes : 1
  return count
}

/**
 * Materialize one draft, compressing its single-child chain.
 *
 * A directory with no file of its own and exactly one subdirectory is not worth
 * a row: the chain reads as one label. Compression stops the moment the path
 * branches or a file sits at this level.
 */
function finishDir(draft: DirDraft): ChangeDir {
  let name = draft.name
  let current = draft
  while (current.files.length === 0 && current.dirs.size === 1) {
    const only = [...current.dirs.values()][0]!
    name = `${name}/${only.name}`
    current = only
  }
  const children = finishChildren(current)
  return { kind: 'dir', name, path: current.path, children, changes: countFiles(children), open: current.open }
}

function finishChildren(draft: DirDraft): ChangeNode[] {
  const nodes: ChangeNode[] = []
  for (const child of draft.dirs.values()) nodes.push(finishDir(child))
  nodes.push(...draft.files)
  nodes.sort(compareNodes)
  return nodes
}

/**
 * Fold one group's changed files into a directory tree.
 *
 * @param entries - that group's changed files, in any order.
 * @param options - `open` seeds every directory's expanded state.
 * @returns the tree's roots, already ordered for rendering.
 */
export function buildChangeTree(entries: readonly ChangeInput[], options: { open?: (path: string, depth: number) => boolean } = {}): ChangeNode[] {
  const root: DirDraft = { name: '', path: '', dirs: new Map(), files: [], open: true }
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry?.path || seen.has(entry.path)) continue
    seen.add(entry.path)
    const segments = entry.path.split('/').filter(Boolean)
    if (segments.length === 0) continue
    const name = segments[segments.length - 1]!
    let cursor = root
    for (const segment of segments.slice(0, -1)) {
      const path = cursor.path ? `${cursor.path}/${segment}` : segment
      let next = cursor.dirs.get(segment)
      if (next === undefined) {
        next = { name: segment, path, dirs: new Map(), files: [], open: options.open?.(path, path.split('/').length - 1) ?? true }
        cursor.dirs.set(segment, next)
      }
      cursor = next
    }
    cursor.files.push({
      kind: 'file', name, path: entry.path, status: entry.status,
      origPath: entry.origPath ?? null, added: entry.added ?? null, removed: entry.removed ?? null, binary: entry.binary === true,
    })
  }
  return finishChildren(root)
}

/** One visible row after honoring the expanded state. */
export interface VisibleRow {
  node: ChangeNode
  depth: number
}

/**
 * Walk the tree, skipping the children of a collapsed directory.
 *
 * @param nodes - roots from {@link buildChangeTree}.
 * @param isOpen - whether a directory row is expanded.
 * @returns the rows to render, in order, with their depth.
 */
export function flattenVisible(nodes: readonly ChangeNode[], isOpen: (path: string, depth: number) => boolean): VisibleRow[] {
  const rows: VisibleRow[] = []
  const walk = (list: readonly ChangeNode[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth })
      if (node.kind === 'dir' && isOpen(node.path, depth)) walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return rows
}

/** Every changed file path in the tree, for a completeness check. */
export function collectPaths(nodes: readonly ChangeNode[]): string[] {
  const paths: string[] = []
  const walk = (list: readonly ChangeNode[]): void => {
    for (const node of list) {
      if (node.kind === 'file') paths.push(node.path)
      else walk(node.children)
    }
  }
  walk(nodes)
  return paths
}
