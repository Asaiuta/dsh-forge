/**
 * The settings page's bridge to the host: two JSON routes on the host web server.
 *
 * This is a *separate cordis row* (`dsh-forge-http`) rather than part of the main
 * plugin, for the same reason `dsh-blackhole` splits its routes out: the main row
 * injects `tools`/`commands`/`fs`/`systemPrompt` and has to keep loading in
 * headless and SDK profiles, which serve no web server. A row that injects
 * `webServer` is simply never applied there — no routes, no warning, and the
 * browser half is unreachable anyway on a host that shows no UI.
 *
 * ## Why `configEditor.edit()` and not `dsh-settings`
 *
 * The page changes `surface`, which decides which tools register. `dsh-settings`'
 * volatile form commits a change into the *running* fiber
 * instead of remounting it, so the names would change on the page and not in the
 * registry. `configEditor.edit()` takes the other path on purpose — it validates
 * the candidate config, writes it to the current profile's patch, and hands it to
 * the Loader's normal lifecycle, which remounts this row and re-registers the
 * surface. That is the whole reason that service exists.
 *
 * ## What it does not do
 *
 * It writes only the row's `config` node. A key this page does not own is copied
 * through untouched by `nextConfig`, and resetting a value to what the row
 * already inherits lets `edit()` drop the override entirely instead of pinning
 * it.
 *
 * @module dsh-forge/http-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CONFIG_PATH,
  ConfigEditError,
  FORGE_ROW_ID,
  nextConfig,
  readSettings,
} from './config-api.ts'
import { ledgerBatchDetail, ledgerList, ledgerNodeSnapshot, LedgerApiError } from './ledger-api.ts'
import { createLedgerRollbackService, type LedgerRollbackOptions } from './ledger-rollback.ts'
import { createExecutionGuard, type ForgeFileSystem, type ForgePolicyService } from './execution.ts'
import { getProject, listProjects, projectAction, projectOverview } from './projects.ts'
import { GitReadError, readGitDiff, readGitStatus } from './git-reader.ts'
import { createGitRun, DIFF_SIDE_MAX_BYTES, readWorktreeText, type SubprocessLike } from './git-subprocess.ts'

export const name = 'dsh-forge-http'

/**
 * Both services are required, not probed: without `webServer` there is no page to
 * serve, and without `configEditor` a save could not reach the profile patch.
 * A profile lacking either leaves this row inactive, which is the honest state.
 */
export const inject = ['webServer', 'configEditor'] as const

/** Upper bound on a save body. The real one is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Route served for the sidebar ledger tab.
 *
 * Separate from {@link CONFIG_PATH} because the two pages have different
 * lifetimes: the ledger is read on every tab mount and after every write, while
 * the settings page is read once. Both live on this row because both need the
 * host's web server, and that is the row's only reason to exist.
 */
const LEDGER_PATH = '/forge-ledger'

/** Read-only git route for the Git page; GET only, no mutation surface. */
const GIT_PATH = '/forge-git'

/** The route surface this plugin registers into. */
export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** One profile row, as `configEditor` addresses it. */
export interface ProfileEntryLike {
  options: { id: string; name?: string; config?: unknown }
}

/** The slice of `configEditor` this plugin uses. */
export interface ConfigEditorService {
  entries(): ProfileEntryLike[]
  edit(
    entry: ProfileEntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

interface HttpHostContext {
  webServer: WebServerService
  configEditor: ConfigEditorService
  get?(name: string): unknown
  effect(setup: () => Generator<unknown>, label?: string): unknown
  logger?: { warn(message: string): void }
}

/**
 * Reply with one JSON object. `no-store` because the page is the only reader and
 * a cached config is worse than a slow one.
 */
function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function optionalHostService<T>(host: HttpHostContext, name: string): T | undefined {
  try { return host.get?.(name) as T | undefined } catch { return undefined }
}

/** Reject cross-site form/fetch requests and DNS-rebinding Host values. */
export function assertMutationRequest(request: IncomingMessage): void {
  const host = request.headers?.host
  const origin = request.headers?.origin
  if (typeof host !== 'string' || typeof origin !== 'string') throw new LedgerApiError('同源 Origin 与 Host 是必需的')
  let target: URL
  let source: URL
  try { target = new URL(`http://${host}`); source = new URL(origin) }
  catch { throw new LedgerApiError('Origin 或 Host 无效') }
  const address = request.socket?.localAddress?.replace(/^::ffff:/, '')
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]', ...(address ? [address, `[${address}]`] : [])])
  if (!allowed.has(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash
    || source.host !== target.host || !['http:', 'https:'].includes(source.protocol) || source.origin !== origin) throw new LedgerApiError('拒绝非同源请求或不受信任 Host')
  const encrypted = Boolean((request.socket as { encrypted?: boolean } | undefined)?.encrypted)
  if (source.protocol !== (encrypted ? 'https:' : 'http:')) throw new LedgerApiError('Origin 协议不匹配')
  const localPort = request.socket?.localPort
  if (localPort !== undefined && Number(target.port || (encrypted ? 443 : 80)) !== localPort) throw new LedgerApiError('Host 端口不匹配')
  const media = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (media !== 'application/json') throw new LedgerApiError('Content-Type 必须为 application/json')
}


/** Read and parse one JSON request body, refusing anything oversized. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new ConfigEditError('请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ConfigEditError('请求体不是合法 JSON')
  }
}

/**
 * Locate the row this page configures.
 *
 * Looked up per request, never cached: `configEditor.edit()` rejects an entry
 * object that is no longer in `entries()`, and a save remounts this very row, so
 * a handle held across two requests would be stale exactly when it matters.
 */
function findEntry(editor: ConfigEditorService): ProfileEntryLike {
  const entry = editor.entries().find((candidate) => candidate.options.id === FORGE_ROW_ID)
  if (entry === undefined) {
    throw new ConfigEditError(`当前 profile 里没有 id 为「${FORGE_ROW_ID}」的条目`)
  }
  return entry
}

/**
 * Serve `GET /forge-config` (current values) and `POST /forge-config` (save).
 *
 * The editor is looked up per request rather than captured: services can be
 * replaced under a running plugin (an HMR reload of the settings stack, a fiber
 * that re-provides `configEditor`), and a captured handle would keep writing
 * through the old one. One registry read per call is cheap; a stale handle is
 * a bug.
 *
 * @param editor - reads the host's config editor from the live context.
 * @returns the request handler.
 */
export function createConfigHandler(editor: () => ConfigEditorService | undefined) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const current = editor()
      if (current === undefined) {
        send(response, 503, { ok: false, error: '宿主没有提供配置编辑器' })
        return
      }
      if (request.method === 'GET') {
        send(response, 200, { ok: true, state: readSettings(findEntry(current).options.config) })
        return
      }
      if (request.method !== 'POST') {
        send(response, 405, { ok: false, error: '只支持 GET 与 POST' })
        return
      }

      const body = await readJson(request)
      const entry = findEntry(current)
      let written: Record<string, unknown> = {}
      await current.edit(entry, (config) => {
        written = nextConfig(config, body)
        return written
      })
      // The write remounts this row; the new state is read back from what was
      // persisted rather than from the editor, so the page and the file agree
      // even if the remount is still in flight.
      send(response, 200, { ok: true, state: readSettings(written) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A rejected value is the user's to fix; anything else is ours.
      send(response, error instanceof ConfigEditError ? 400 : 500, { ok: false, error: message })
    }
  }
}

/**
 * GET lists batches with keyword/pathContains/actor/kind filters and an opaque
 * nextCursor, or opens one batch via ?batch=<positive id>. Cursors pin the
 * workspace, filters, page size and ledger prefix while allowing new appends.
 * POST accepts preview/confirm actions. Only the live host fs/sandboxPolicy
 * guard can authorize writes; a preview never grants recovery permission.
 * Workspaces must be absolute. POST requires same-origin JSON, a nonempty
 * reason, and confirmation of a short-lived, single-use preview token.
 *
 * @returns the request handler.
 */
export function createLedgerHandler(options: LedgerRollbackOptions = {}) {
  const rollback = createLedgerRollbackService(options)
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'POST') {
      send(response, 405, { ok: false, error: '只支持 GET 与 POST' })
      return
    }
    try {
      if (request.method === 'POST') {
        assertMutationRequest(request)
        const body = await readJson(request)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LedgerApiError('请求体必须是 JSON 对象')
        send(response, 200, { ok: true, ...await rollback(body as Record<string, unknown>) })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const workspace = url.searchParams.get('workspace') ?? ''
      if (!path.isAbsolute(workspace)) {
        send(response, 400, { ok: false, error: 'workspace 必须是绝对路径' })
        return
      }
      const address = url.searchParams.get('node')
      if (address !== null) {
        if (url.searchParams.has('batch')) throw new LedgerApiError('node snapshot and batch detail are exclusive')
        const side = url.searchParams.get('side')
        if (side !== 'before' && side !== 'after') throw new LedgerApiError('side must be before or after')
        let snapshot
        try { snapshot = ledgerNodeSnapshot(workspace, address, side, Number(url.searchParams.get('offset') ?? '0'), Number(url.searchParams.get('limit') ?? '32768')) }
        catch (e) { if (e instanceof LedgerApiError) throw e; throw new LedgerApiError(e instanceof Error ? e.message : String(e)) }
        send(response, 200, { ok: true, snapshot })
        return
      }
      if (url.searchParams.has('side') || url.searchParams.has('offset')) throw new LedgerApiError('side/offset require node')
      const rawBatch = url.searchParams.get('batch')
      if (rawBatch !== null) {
        const id = Number(rawBatch)
        if (!Number.isSafeInteger(id) || id < 1) {
          send(response, 400, { ok: false, error: 'batch 必须是正整数' })
          return
        }
        const detail = ledgerBatchDetail(workspace, id)
        if (detail === undefined) {
          send(response, 404, { ok: false, error: `没有批次 #${id}` })
          return
        }
        send(response, 200, { ok: true, ...detail })
        return
      }
      const rawLimit = Number(url.searchParams.get('limit') ?? '50')
      if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) throw new LedgerApiError('limit 必须是 1–200 的整数')
      const filters = Object.fromEntries(['keyword', 'pathContains', 'actor', 'kind', 'cursor', 'projectId', 'taskId', 'file'].flatMap(key => url.searchParams.has(key) ? [[key, url.searchParams.get(key)!]] : []))
      const unassigned = url.searchParams.get('unassigned')
      if (unassigned !== null && !['true', 'false'].includes(unassigned)) throw new LedgerApiError('unassigned must be true or false')
      send(response, 200, { ok: true, ...ledgerList(workspace, { limit: rawLimit, ...filters, ...(unassigned === null ? {} : { unassigned: unassigned === 'true' }) }) })
    } catch (error) {
      send(response, error instanceof LedgerApiError ? error.status : error instanceof ConfigEditError ? 400 : 503, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}


/**
 * Read-only git facts for the Git page.
 *
 * GET only: there is no route that stages, commits, or writes an index, so an
 * unreachable page cannot change a repository. The subprocess capability is read
 * at call time — a host that offers none answers 503 instead of spawning git
 * outside its sandbox.
 */
export function createGitHandler(service: () => SubprocessLike | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method !== 'GET') { send(response, 405, { ok: false, error: 'Git 页只读，仅支持 GET' }); return }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const workspace = url.searchParams.get('workspace') ?? ''
      if (!path.isAbsolute(workspace)) throw new LedgerApiError('workspace 必须是绝对路径')
      const subprocess = service()
      if (!subprocess) throw new LedgerApiError('宿主未提供子进程能力，无法读取 git', 503)
      const run = createGitRun(subprocess)
      const file = url.searchParams.get('file')
      if (file !== null) {
        if (!file) throw new LedgerApiError('file 不能为空')
        send(response, 200, { ok: true, diff: await readGitDiff(workspace, file, run, readWorktreeText, { maxBytes: DIFF_SIDE_MAX_BYTES }) })
        return
      }
      const status = await readGitStatus(workspace, run)
      if (!status.isRepo) { send(response, 200, { ok: true, repo: { isRepo: false } }); return }
      send(response, 200, { ok: true, repo: status })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send(response, error instanceof LedgerApiError ? error.status : error instanceof GitReadError ? 400 : 503, { ok: false, error: message })
    }
  }
}

/** Projects live only in forge's private store; actions retain the shared service validation. */
export function createProjectsHandler() {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const workspace = url.searchParams.get('workspace') ?? undefined
        if (workspace !== undefined && !path.isAbsolute(workspace)) throw new LedgerApiError('workspace 必须是绝对路径')
        const projectId = url.searchParams.get('projectId')
        if (projectId !== null) {
          if (!workspace) throw new LedgerApiError('workspace 是必需的')
          send(response, 200, { ok: true, project: getProject(workspace, projectId), overview: projectOverview(workspace, projectId) })
        } else {
          send(response, 200, { ok: true, projects: listProjects({ workspace, query: url.searchParams.get('query') ?? undefined }) })
        }
        return
      }
      if (request.method !== 'POST') { send(response, 405, { ok: false, error: '只支持 GET 与 POST' }); return }
      assertMutationRequest(request)
      const body = await readJson(request)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LedgerApiError('请求体必须是 JSON 对象')
      const result = await projectAction(body, undefined, 'forge-projects-http')
      const action = (body as Record<string, unknown>).action
      send(response, 200, { ok: true, ...(action === 'list' ? { projects: result } : action === 'overview' ? { overview: result } : { project: result }) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send(response, error instanceof LedgerApiError ? error.status : /revision conflict/i.test(message) ? 409 : 400, { ok: false, error: message })
    }
  }
}

/**
 * Mount the route for as long as this row is active.
 *
 * @param ctx - the browser-serving host context.
 */
export function apply(ctx: Context): void {
  const host = ctx as unknown as HttpHostContext
  host.effect(function* () {
    yield host.webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: createConfigHandler(() => host.configEditor),
    })
    yield host.webServer.register({
      kind: 'exact',
      path: LEDGER_PATH,
      handler: createLedgerHandler({ guard: async (exec, args, tool) => {
        const provider = optionalHostService<ForgeFileSystem>(host, 'fs')
        if (!provider) throw new LedgerApiError('宿主没有提供 DSH 文件系统', 503)
        const policy = optionalHostService<ForgePolicyService>(host, 'sandboxPolicy')
        return createExecutionGuard(provider, {}, policy)(exec, args, tool)
      } }),
    })
    yield host.webServer.register({ kind: 'exact', path: '/forge-projects', handler: createProjectsHandler() })
    yield host.webServer.register({ kind: 'exact', path: GIT_PATH, handler: createGitHandler(() => optionalHostService<SubprocessLike>(host, 'subprocess')) })
  }, 'dsh-forge: config and ledger routes')
}
