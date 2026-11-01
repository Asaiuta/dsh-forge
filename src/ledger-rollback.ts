import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRollbackTool } from './tools-edit.ts'
import { storeFor } from './ledger.ts'
import { LedgerApiError } from './ledger-api.ts'
import type { FinderPool, ForgeExec } from './core.ts'

export type LedgerGuard = (exec: ForgeExec, args: Record<string, unknown>, tool: string) => Promise<ForgeExec>
export interface LedgerRollbackOptions { guard?: LedgerGuard; now?: () => number; ttlMs?: number }
interface Ticket { workspace: string; selection: Record<string, unknown>; reason: string; baseline: Map<string, string>; version: string; expires: number }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function bytesIdentity(file: string): string {
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new LedgerApiError('rollback target must be a regular file', 409)
    return `${realpathSync(file)}:${hash(readFileSync(file))}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}
function ledgerVersion(workspace: string): string {
  const store = storeFor(workspace)
  if (existsSync(path.join(store.dir, 'transaction.json'))) throw new LedgerApiError('pending transaction requires explicit guarded recovery before GUI rollback', 409)
  return existsSync(store.ledgerFile) ? hash(readFileSync(store.ledgerFile)) : 'absent'
}
function selectionOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LedgerApiError('selection is required')
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => !['batch', 'latest', 'throughBatch', 'node', 'pathContains'].includes(key))) throw new LedgerApiError('invalid selection field')
  if ([source.batch !== undefined, source.latest === true, source.throughBatch !== undefined].filter(Boolean).length !== 1) throw new LedgerApiError('provide exactly one of batch, latest=true or throughBatch')
  if (source.latest !== undefined && source.latest !== true) throw new LedgerApiError('latest must be true or omitted')
  if (source.batch !== undefined && (!Number.isSafeInteger(source.batch) || Number(source.batch) < 1)) throw new LedgerApiError('batch must be a positive integer')
  if (source.throughBatch !== undefined && (!Number.isSafeInteger(source.throughBatch) || Number(source.throughBatch) < 0)) throw new LedgerApiError('throughBatch must be a nonnegative integer')
  if (source.node !== undefined && (typeof source.node !== 'string' || !/^b\d+:n\d+$/.test(source.node) || source.batch === undefined)) throw new LedgerApiError('node requires a specific batch')
  if (source.pathContains !== undefined && (typeof source.pathContains !== 'string' || !source.pathContains.trim())) throw new LedgerApiError('pathContains must be a nonempty string')
  const { pathContains, ...selection } = source
  return { ...selection, ...(pathContains === undefined ? {} : { path: pathContains }) }
}

/** Tokens are short-lived, bounded, single-use and private to this route instance. */
export function createLedgerRollbackService(options: LedgerRollbackOptions = {}) {
  const tickets = new Map<string, Ticket>()
  const now = options.now ?? Date.now
  const tool = createRollbackTool(undefined as unknown as FinderPool)
  return async (body: Record<string, unknown>) => {
    if (!options.guard) throw new LedgerApiError('DSH filesystem execution guard is unavailable', 503)
    if (typeof body.workspace !== 'string' || !path.isAbsolute(body.workspace)) throw new LedgerApiError('workspace must be absolute')
    const workspace = storeFor(body.workspace).root
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) throw new LedgerApiError('reason is required')
    const fields = body.action === 'preview' ? ['action', 'workspace', 'selection', 'reason'] : ['action', 'workspace', 'token', 'reason']
    if (Object.keys(body).some(key => !fields.includes(key))) throw new LedgerApiError('unknown rollback request field')
    for (const [token, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(token)
    const exec: ForgeExec = { agent: { session: { header: { cwd: workspace, id: 'forge-ledger-http' } } } }
    if (body.action === 'preview') {
      const selection = selectionOf(body.selection)
      const version = ledgerVersion(workspace)
      let guarded: ForgeExec
      try { guarded = await options.guard(exec, {}, tool.name) }
      catch (error) { throw new LedgerApiError(String(error instanceof Error ? error.message : error), 503) }
      const denied = async (): Promise<never> => { throw new LedgerApiError('preview cannot authorize recovery or mutation', 409) }
      const preview = await tool.execute({ ...selection, reason, dryRun: true }, { ...guarded, prepareNativeWrite: denied, withNativeWrite: denied })
      if ('error' in preview) throw new LedgerApiError(preview.error, 409)
      if (preview.status !== 'plan') throw new LedgerApiError('rollback preview did not produce a plan', 409)
      const baseline = new Map(preview.items.map(item => { const file = path.resolve(workspace, item.file); return [file, bytesIdentity(file)] }))
      if (ledgerVersion(workspace) !== version) throw new LedgerApiError('ledger changed during preview', 409)
      const token = randomBytes(32).toString('base64url')
      const expires = now() + Math.min(options.ttlMs ?? 120_000, 120_000)
      if (tickets.size >= 256) tickets.delete(tickets.keys().next().value!)
      tickets.set(token, { workspace, selection, reason, baseline, version, expires })
      return { token, expiresAt: new Date(expires).toISOString(), preview }
    }
    if (body.action !== 'confirm') throw new LedgerApiError('action must be preview or confirm')
    if (typeof body.token !== 'string') throw new LedgerApiError('token is required')
    const ticket = tickets.get(body.token)
    tickets.delete(body.token)
    if (!ticket || ticket.expires <= now() || ticket.workspace !== workspace || ticket.reason !== reason || body.selection !== undefined) throw new LedgerApiError('token expired, consumed, or mismatched', 409)
    const assertBaseline = () => {
      if (ledgerVersion(workspace) !== ticket.version) throw new LedgerApiError('ledger changed since preview', 409)
      for (const [file, fingerprint] of ticket.baseline) if (bytesIdentity(file) !== fingerprint) throw new LedgerApiError('file changed since preview', 409)
    }
    assertBaseline()
    let guarded: ForgeExec
    try { guarded = await options.guard(exec, {}, tool.name) }
    catch (error) { throw new LedgerApiError(error instanceof Error ? error.message : String(error), 503) }
    if (!guarded.withNativeWrite) throw new LedgerApiError('DSH mutation fence is unavailable', 503)
    const fence = guarded.withNativeWrite
    const result = await tool.execute({ ...ticket.selection, reason, dryRun: false }, {
      ...guarded,
      withNativeWrite: (files, operation) => fence(files, () => { assertBaseline(); return operation() }),
    })
    if ('error' in result) throw new LedgerApiError(result.error, 409)
    if (result.status !== 'applied') throw new LedgerApiError('rollback did not commit', 409)
    return { result }
  }
}
