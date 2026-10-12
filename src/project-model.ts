/** Durable project identity and task state. Session todos remain turn-local. */
export type ProjectStatus = 'active' | 'review' | 'accepted'
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'
export interface ProjectTodo {
  id: string
  content: string
  status: TodoStatus
  note: string
}
export interface ProjectReport {
  conclusion: string
  issues: string
  actor: string
  ts: number
  throughBatch: number
  content: string
}
export interface ProjectRecord {
  id: string
  name: string
  root: string
  description: string
  status: ProjectStatus
  createdAt: number
  createdBy: string
  updatedAt: number
  revision: number
  deletedAt: number | null
  todos: ProjectTodo[]
  report: ProjectReport | null
}
export interface ProjectLink { projectId: string; todoId?: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!record(value) || typeof value.id !== 'string' || !/^p_[a-f0-9]{32}$/.test(value.id)
    || typeof value.name !== 'string' || !value.name.trim() || typeof value.root !== 'string'
    || typeof value.description !== 'string' || !['active', 'review', 'accepted'].includes(String(value.status))
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || typeof value.createdBy !== 'string'
    || !(value.deletedAt === null || Number.isFinite(value.deletedAt)) || !Array.isArray(value.todos)) return false
  const ids = new Set<string>()
  for (const todo of value.todos) {
    if (!record(todo) || typeof todo.id !== 'string' || !/^t_[a-f0-9]{32}$/.test(todo.id)
      || ids.has(todo.id) || typeof todo.content !== 'string' || !todo.content.trim()
      || !['pending', 'in_progress', 'completed', 'blocked'].includes(String(todo.status)) || typeof todo.note !== 'string') return false
    ids.add(todo.id)
  }
  if (value.report !== null) {
    const report = value.report
    if (!record(report) || typeof report.conclusion !== 'string' || typeof report.issues !== 'string'
      || typeof report.actor !== 'string' || !Number.isFinite(report.ts) || !Number.isSafeInteger(report.throughBatch)
      || typeof report.content !== 'string') return false
  }
  return true
}
