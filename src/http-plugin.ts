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
 * The page has to change `registration`/`takeover`, and those decide which tools
 * exist at all: `apply()` calls `planRegistration` once and registers from the
 * result. `dsh-settings`' volatile form commits a change into the *running* fiber
 * instead of remounting it, so the names would change on the page and not in the
 * registry. `configEditor.edit()` takes the other path on purpose — it validates
 * the candidate config, writes it to the current profile's patch, and hands it to
 * the Loader's normal lifecycle, which remounts this row and re-registers the
 * surface. That is the whole reason that service exists.
 *
 * ## What it does not do
 *
 * It writes only the row's `config` node. `cards` — including an endpoint
 * credential — is copied through untouched by `nextConfig`, and resetting a value
 * to what the row already inherits lets `edit()` drop the override entirely
 * instead of pinning it.
 *
 * @module dsh-forge/http-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CONFIG_PATH,
  ConfigEditError,
  FORGE_ROW_ID,
  nextConfig,
  readSettings,
} from './config-api.ts'

export const name = 'dsh-forge-http'

/**
 * Both services are required, not probed: without `webServer` there is no page to
 * serve, and without `configEditor` a save could not reach the profile patch.
 * A profile lacking either leaves this row inactive, which is the honest state.
 */
export const inject = ['webServer', 'configEditor'] as const

/** Upper bound on a save body. The real one is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024

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

/** Read and parse one JSON request body, refusing anything oversized. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
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
 * through the old one. Same rule `./delegate.ts` follows for tool lookups — one
 * registry read per call is cheap, a stale handle is a bug.
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
  }, 'dsh-forge: config routes')
}
