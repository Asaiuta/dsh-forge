/** Project revisions and file commits share a workspace ledger and its lock. */
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { withFileLock, type ForgeExec } from './core.ts'
import { prepareWorkspace, readLedgerTail, recordBatch, requireProjectLedger, storeFor, type StorePaths } from './ledger.ts'
import { isProjectRecord, type ProjectLink, type ProjectRecord, type ProjectTodo, type ProjectStatus, type TodoStatus } from './project-model.ts'
import { isSymbolicLink } from './fs-paths.ts'

export function canonicalWorkspace(root: string): string {
  const canonical = realpathSync(root)
  if (!statSync(canonical).isDirectory()) throw new Error('workspace must be an existing directory')
  return canonical
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}
export function canonicalTarget(target: string): string {
  if (existsSync(target)) return realpathSync(target)
  if (isSymbolicLink(target)) throw new Error(`native operation refuses dangling symbolic link identity: ${target}`)
  const parent = path.dirname(target)
  return parent === target ? target : path.join(canonicalTarget(parent), path.basename(target))
}
export function listProjects(store: StorePaths): ProjectRecord[] {
  const projects = new Map<string, ProjectRecord>()
  for (const batch of readLedgerTail(store, Number.MAX_SAFE_INTEGER)) {
    if (batch.kind !== 'project') {
      const project = batch.projectId ? projects.get(batch.projectId) : undefined
      if (project && batch.nodes.length > 0) projects.set(project.id, {
        ...project, status: 'active', updatedAt: batch.ts, revision: project.revision + 1,
      })
      continue
    }
    if (!isProjectRecord(batch.projectRecord) || batch.projectRecord.id !== batch.projectId) {
      throw new Error(`invalid project revision in batch ${batch.id}; refusing incomplete project state`)
    }
    const previous = projects.get(batch.projectId!)
    if (batch.projectRecord.revision !== (previous?.revision ?? 0) + 1) throw new Error(`project revision gap: ${batch.projectId}`)
    projects.set(batch.projectRecord.id, batch.projectRecord)
  }
  return [...projects.values()]
}
export function getProject(store: StorePaths, id: string, includeDeleted = false): ProjectRecord {
  const project = listProjects(store).find(project => project.id === id)
  if (!project) throw new Error(`project not found in this workspace: ${id}`)
  if (project.deletedAt !== null && !includeDeleted) throw new Error(`project ${id} is deleted; restore it before use`)
  return project
}
export function resolveProjectLink(store: StorePaths, projectId: unknown, todoId: unknown, file?: string): ProjectLink | undefined {
  if (projectId === undefined && todoId === undefined) return undefined
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('projectId is required when linking a todo')
  const project = getProject(store, projectId)
  if (file && !within(project.root, canonicalTarget(file))) throw new Error(`file is outside project ${project.id}: ${file}`)
  if (todoId !== undefined && (typeof todoId !== 'string' || !project.todos.some(todo => todo.id === todoId))) {
    throw new Error(`todo not found in project ${project.id}: ${String(todoId)}`)
  }
  return { projectId: project.id, ...(typeof todoId === 'string' ? { todoId } : {}) }
}
function save(store: StorePaths, project: ProjectRecord, actor: string, reason: string): ProjectRecord {
  if (!isProjectRecord(project)) throw new Error('invalid project state')
  requireProjectLedger(store)
  recordBatch(store, { kind: 'project', projectId: project.id, projectRecord: project, actor, reason, nodes: [] })
  return project
}
function update(store: StorePaths, project: ProjectRecord, changes: Partial<ProjectRecord>, actor: string, reason: string): ProjectRecord {
  return save(store, { ...project, ...changes, updatedAt: Date.now(), revision: project.revision + 1 }, actor, reason)
}
export interface TodoPatch { id?: string; content?: string; status?: TodoStatus; note?: string; remove?: boolean }
export function parseTodoPatches(value: unknown): TodoPatch[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error('todos requires 1-100 patch objects')
  const seen = new Set<string>()
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('todo patch must be an object')
    const patch = item as Record<string, unknown>
    if (Object.keys(patch).some(key => !['id', 'content', 'status', 'note', 'remove'].includes(key))) throw new Error('unknown todo patch field')
    if (patch.id !== undefined && (typeof patch.id !== 'string' || !/^t_[a-f0-9]{32}$/.test(patch.id) || seen.has(patch.id))) throw new Error('invalid or duplicate todo id')
    if (typeof patch.id === 'string') seen.add(patch.id)
    if (patch.content !== undefined && (typeof patch.content !== 'string' || !patch.content.trim())) throw new Error('todo content must be nonempty')
    if (patch.note !== undefined && typeof patch.note !== 'string') throw new Error('todo note must be a string')
    if (patch.remove !== undefined && typeof patch.remove !== 'boolean') throw new Error('remove must be boolean')
    if (patch.status !== undefined && !['pending', 'in_progress', 'completed', 'blocked'].includes(String(patch.status))) throw new Error('invalid todo status')
    if (!patch.id && (patch.remove || !patch.content)) throw new Error('new todo requires content; removal requires id')
    return patch as TodoPatch
  })
}
export class ProjectRegistry {
  async mutate(root: string, fn: (store: StorePaths) => ProjectRecord, exec?: ForgeExec): Promise<ProjectRecord> {
    const store = storeFor(canonicalWorkspace(root))
    return withFileLock(store.dir, async () => { await prepareWorkspace(store, exec); return fn(store) })
  }
  async create(workspace: string, root: string, name: string, description: string, actor: string, reason: string, exec?: ForgeExec): Promise<ProjectRecord> {
    return this.mutate(workspace, store => {
      const projectRoot = canonicalWorkspace(path.resolve(store.root, root))
      if (!within(canonicalWorkspace(store.root), projectRoot)) throw new Error('project root must be inside the workspace')
      if (listProjects(store).some(project => project.deletedAt === null && project.root === projectRoot && project.name === name)) throw new Error('an active project with this root and name already exists')
      const now = Date.now()
      return save(store, { id: `p_${randomUUID().replaceAll('-', '')}`, root: projectRoot, name, description, status: 'active',
        createdAt: now, createdBy: actor, updatedAt: now, revision: 1, deletedAt: null, todos: [], report: null }, actor, reason)
    }, exec)
  }
  async todos(workspace: string, id: string, patches: TodoPatch[], revision: number, actor: string, reason: string, exec?: ForgeExec): Promise<ProjectRecord> {
    return this.mutate(workspace, store => {
      const project = getProject(store, id)
      if (project.revision !== revision) throw new Error(`project revision changed: expected ${revision}, current ${project.revision}; read project again`)
      const todos: ProjectTodo[] = project.todos.map(todo => ({ ...todo }))
      const history = readLedgerTail(store, Number.MAX_SAFE_INTEGER)
      for (const patch of patches) {
        const index = patch.id ? todos.findIndex(todo => todo.id === patch.id) : -1
        if (patch.id && index < 0) throw new Error(`todo not found: ${patch.id}`)
        if (patch.remove) {
          if (history.some(batch => batch.projectId === id && batch.todoId === patch.id)) throw new Error('cannot remove a task referenced by history; preserve its stable identity')
          todos.splice(index, 1); continue
        }
        const previous = index >= 0 ? todos[index] : { id: `t_${randomUUID().replaceAll('-', '')}`, content: '', status: 'pending' as const, note: '' }
        const next = { ...previous, ...(patch.content !== undefined ? { content: patch.content.trim() } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}) }
        if (index >= 0) todos[index] = next
        else todos.push(next)
      }
      return update(store, project, { todos, status: 'active' }, actor, reason)
    }, exec)
  }
  async setDeleted(workspace: string, id: string, deleted: boolean, actor: string, reason: string, exec?: ForgeExec): Promise<ProjectRecord> {
    return this.mutate(workspace, store => {
      const project = getProject(store, id, true)
      if ((project.deletedAt !== null) === deleted) return project
      if (!deleted && listProjects(store).some(other => other.id !== id && other.deletedAt === null
        && other.root === project.root && other.name === project.name)) throw new Error('cannot restore: another active project has this root and name')
      return update(store, project, { deletedAt: deleted ? Date.now() : null }, actor, reason)
    }, exec)
  }
  async report(workspace: string, id: string, conclusion: string, issues: string, status: ProjectStatus, revision: number, actor: string, reason: string, exec?: ForgeExec): Promise<ProjectRecord> {
    return this.mutate(workspace, store => {
      const project = getProject(store, id)
      if (project.revision !== revision) throw new Error('project revision changed; read project again before reporting')
      const history = readLedgerTail(store, Number.MAX_SAFE_INTEGER)
      const throughBatch = history.at(-1)?.id ?? 0
      const changes = history.filter(batch => batch.projectId === id && batch.nodes.length > 0)
      if (status === 'accepted' && project.todos.some(todo => todo.status !== 'completed')) throw new Error('acceptance requires all project tasks to be completed')
      const files = new Set(changes.flatMap(batch => batch.nodes.map(node => node.file)))
      const content = [`# ${project.name}`, `Status: ${status}`, `Root: ${project.root}`, `Through batch: ${throughBatch}`,
        `Changes: ${changes.length} batches / ${files.size} files`, '## Tasks', ...project.todos.map(todo => `- ${todo.id} [${todo.status}] ${todo.content}${todo.note ? ` — ${todo.note}` : ''}`),
        '## Files', ...files, '## Participants', ...new Set(changes.map(batch => batch.actor)), '## Conclusion', conclusion, '## Issues', issues || 'None'].join('\n')
      return update(store, project, { status, report: { conclusion, issues, actor, ts: Date.now(), throughBatch, content } }, actor, reason)
    }, exec)
  }
}
