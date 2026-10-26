/**
 * dsh-forge cordis glue: registers the FFF retrieval tools, the forge
 * prompt-guidance section and the /forge-status command on the host-plane
 * registries. Mounted by the bundle patch as a host-plane insert (dsh-ssh
 * shape), NOT inside the preset groups — dsh-blackhole's patch already
 * full-restates preset-standard's config, and a second full restatement would
 * overwrite its entries.
 *
 * Two registration modes, chosen by the row's `config.registration` (see
 * `./config.ts`):
 *
 *   additive (default)  every tool on the global registry under its own `ff*`
 *                       name — the byte-for-byte behaviour this plugin shipped.
 *   takeover            the listed native names (`read`) are registered into
 *                       each live agent's scope instead, shadowing the built-in
 *                       of that name for that agent; everything else stays
 *                       global. `./registration.ts` owns the ownership rules.
 *
 * Engine lifecycle: the FinderPool is created per plugin instance and
 * collected for disposal; nothing runs at session start (lazy per-workspace
 * init on first tool call).
 *
 * Lifecycle protocol: apply is a *generator function* (plain functions get
 * `new`-constructed and their return value dropped) and every yielded value is
 * collected as a disposable by the fork's `_execute` iterator branch. Per-agent
 * registrations are owned twice on purpose — by the agent scope itself and by
 * the disposer yielded here — because `practices.md` requires both: unloading
 * the plugin does not dispose `agent.ctx` registrations by itself.
 *
 * @module dsh-forge
 */

import { defineForgeTool } from './host.ts'
import type { Context } from '@deepseek-ai/cordis'
import { FinderPool } from './core.ts'
import { createFindTool, createGrepTool, createStatusCommand } from './tools.ts'
import { createEditTool, createHistoryTool, createRollbackTool } from './tools-edit.ts'
import { createExecutionGuard, type ForgeFileSystem, type ForgeFsEvents, type ForgePolicyService } from './execution.ts'
import { createNativeDelegate } from './delegate.ts'
import { createFileTool } from './tools-files.ts'
import { createReadTool } from './tools-read.ts'
import { createTraceTool } from './tools-trace.ts'
import { createCardsTool } from './tools-cards.ts'
import { AstWorkerPool } from './ast-pool.ts'
import { Config, resolveConfig } from './config.ts'
import {
  createScopeInstaller,
  planRegistration,
  surfaceFor,
  type ForgeRow,
  type ScopeLike,
} from './registration.ts'
import {
  ADDITIVE_SURFACE,
  FORGE_GUIDANCE_ORDER,
  FORGE_GUIDANCE_SECTION,
  visibleForgeText,
  type ForgeSystemPromptService,
  type ScopedToolLookup,
} from './guidance.ts'

export const name = 'dsh-forge'

export { Config }

/**
 * Services this plugin needs before `apply` runs.
 *
 * `systemPrompt` is listed rather than probed because the section has to be
 * registered *after* the service is mounted: cordis loads plugin rows in
 * parallel, so a `ctx.get('systemPrompt')` taken in `apply` can legitimately
 * miss a service that mounts a moment later, and the announcement would then
 * be dropped in silence. Every official `@deepseek-ai` tool package injects it
 * the same way (`dsh-tool-fs-search`: `['tools', 'systemPrompt', 'subprocess']`).
 * Services that are genuinely optional stay out of this list and are read with
 * `ctx.get()` — `sandboxPolicy` below, and `spillStore` in the official search
 * package. `agents` is likewise optional *here*: only `takeover` needs it, and
 * requiring it would make the plugin inactive in the headless profiles that
 * cannot host a scoped registration anyway.
 */
export const inject = ['tools', 'commands', 'fs', 'systemPrompt'] as const

/** The agent handle `takeover` needs. Structural — the host owns the concrete type. */
interface AgentLike {
  ctx: ScopeLike
}

/** The slice of the cordis context this plugin touches (services arrive via inject). */
interface ForgeHostContext extends ForgeFsEvents {
  fs?: ForgeFileSystem
  /**
   * The only safe way to reach a service that is *not* in {@link inject} — see
   * {@link optionalService}. Deliberately the sole accessor: adding an
   * `agents?:` field here is what made a missing `agents` service throw a proxy
   * error instead of reading as absent.
   */
  get?(name: string): unknown
  systemPrompt?: ForgeSystemPromptService
  logger?: { warn(message: string): void }
  on?(event: string, listener: (payload: never) => void): (() => void) | void
  tools: {
    register(definition: unknown): (() => void) | void
    get?(name: string, scope?: unknown): unknown
  }
  commands: {
    register(definition: unknown): (() => void) | void
  }
}

/**
 * Read an optional service without going through the context proxy.
 *
 * A property read is *not* a way to test whether an optional service exists.
 * cordis resolves `ctx.someService` through the inject graph, and when the name
 * is neither injected nor provided the proxy throws
 * (`cannot get property "agents" without inject`) rather than yielding
 * `undefined` — so `host.agents === undefined` never gets to be true on the
 * host it was written to guard. `ctx.get(name)` is the accessor documented for
 * exactly this ("read a service from the store without the inject requirement",
 * cordis `ReflectService#get`), which is also how `sandboxPolicy` is read.
 *
 * @param host - the plugin context (or a structural stand-in in tests).
 * @param name - service name.
 * @returns the service, or `undefined` when this host does not offer it.
 */
function optionalService<T>(host: ForgeHostContext, name: string): T | undefined {
  return (typeof host.get === 'function' ? host.get(name) : undefined) as T | undefined
}

export function* apply(ctx: Context, rawConfig?: unknown): Generator<unknown, void, unknown> {
  const config = resolveConfig(rawConfig)
  const host = ctx as unknown as ForgeHostContext
  const pool = new FinderPool()
  const workers = new AstWorkerPool()
  const guard = createExecutionGuard(host.fs, host, optionalService<ForgePolicyService>(host, 'sandboxPolicy'))
  const integration = { fs: host.fs, events: host }
  // The registry read that both the guidance section and the per-call fallback
  // need. `get` without a scope is the global view — the only one that still
  // resolves to the built-in a scoped registration shadows.
  const toolLookup: ScopedToolLookup | undefined =
    typeof host.tools.get === 'function' ? { get: (toolName, scope) => host.tools.get?.(toolName, scope) } : undefined
  const delegation = createNativeDelegate(toolLookup)
  // The tool table, in registration order. `native` names the built-in a row
  // may replace, and `build(as)` is the only place that decision is applied:
  // the audit label stays forge's own name (`registerAs` in ./host.ts), so
  // history reads the same in either mode.
  const rows: ForgeRow[] = [
    {
      forge: 'ffgrep',
      native: 'grep',
      build: (as) =>
        defineForgeTool(
          {
            ...createGrepTool(pool, as === 'grep' ? 'grep' : undefined, as === 'grep' ? delegation : undefined),
            ...(as === undefined ? {} : { registerAs: as }),
          },
          guard,
          integration,
        ),
    },
    {
      forge: 'fffind',
      native: 'glob',
      build: (as) =>
        defineForgeTool(
          { ...createFindTool(pool, as === 'glob' ? 'glob' : undefined), ...(as === undefined ? {} : { registerAs: as }) },
          guard,
          integration,
        ),
    },
    { forge: 'ffedit', build: () => defineForgeTool(createEditTool(pool), guard, integration) },
    { forge: 'ffhistory', build: () => defineForgeTool(createHistoryTool(), guard, integration) },
    { forge: 'ffrollback', build: () => defineForgeTool(createRollbackTool(pool), guard, integration) },
    { forge: 'ff_file', build: () => defineForgeTool(createFileTool(), guard, integration) },
    {
      forge: 'ff_read',
      native: 'read',
      build: (as) =>
        defineForgeTool(
          { ...createReadTool(workers, as), ...(as === undefined ? {} : { registerAs: as }) },
          guard,
          integration,
        ),
    },
    { forge: 'fftrace', build: () => defineForgeTool(createTraceTool(workers), guard, integration) },
    { forge: 'ff_cards', build: () => defineForgeTool(createCardsTool(config.cards), guard, integration) },
  ]

  const plan = planRegistration(config, rows)
  const surface = surfaceFor(plan, ADDITIVE_SURFACE)

  for (const row of plan.global) {
    yield host.tools.register(row.build())
  }

  if (plan.scoped.length > 0) {
    yield* mountScoped(host, plan.scoped)
  }

  yield host.commands.register(createStatusCommand(pool, {
    mode: config.registration,
    takenOver: config.takeover,
    ...(delegation === undefined ? {} : { delegate: delegation }),
  }))

  // Index the workspace before anything asks for it. The plugin is lazy by
  // design ("nothing at session start"), and that is right for a profile that
  // never searches — but it makes the *first* real query pay for everything
  // (measured 2.9 s cold, ~2.0 s on a second session even with the index on
  // disk, against 4 ms once a background pre-warm had finished the same work).
  if (config.prewarm) {
    yield schedulePrewarm(
      {
        on: (event, listener) => host.on?.(event, listener as (payload: never) => void),
        agents: optionalService<PrewarmHost['agents']>(host, 'agents'),
      },
      (cwd) => { void pool.warm(cwd) },
    )
  }

  // Registering these tools makes them callable, not known: without this the
  // assembled prompt names no forge tool at all, and a session falls back to the
  // built-in surface it already has habits for (measured — see src/guidance.ts
  // for the section's placement and visibility contract). The names in the text
  // come from `surface`, so a taken-over `read` is announced as `read`.
  if (host.systemPrompt !== undefined) {
    yield host.systemPrompt.section({
      name: FORGE_GUIDANCE_SECTION,
      order: FORGE_GUIDANCE_ORDER,
      text: visibleForgeText(toolLookup, surface),
    })
  }

  yield () => { pool.disposeAll(); void workers.dispose() }
}

/**
 * Delay before a background index build starts.
 *
 * Long enough for the session's first frame and cordis's own startup to get out
 * of the way; short enough that a user who types a question immediately still
 * finds the index already building. The build blocks the JS thread once
 * (measured p99 531 ms on a 5k-file tree), so starting it inline would put that
 * stall in front of the UI instead of behind it.
 */
const PREWARM_DELAY_MS = 1_500

/** The agent slice pre-warming needs: a workspace to index. */
interface PrewarmAgent {
  session?: { header?: { cwd?: unknown } }
}

/** The host slice pre-warming needs. Both members are optional by design. */
interface PrewarmHost {
  on?(event: string, listener: (payload: { agent?: PrewarmAgent }) => void): (() => void) | void
  agents?: { list(): PrewarmAgent[] }
}

/**
 * Warm the index for every live and future agent workspace, once per workspace.
 *
 * Kept free of the finder pool so the policy — one build per cwd, delayed,
 * cancelled on unload — is testable without standing up a native index.
 *
 * @param host - agent registry and event source; missing members disable the
 *   corresponding path (a host without `agents` simply pre-warms nothing).
 * @param warm - called once per distinct workspace root.
 * @param options - delay and scheduler overrides, for tests.
 * @returns an idempotent disposer that cancels pending builds and stops listening.
 */
export function schedulePrewarm(
  host: PrewarmHost,
  warm: (cwd: string) => void,
  options: { delayMs?: number; schedule?: (run: () => void, delayMs: number) => () => void } = {},
): () => void {
  const delay = options.delayMs ?? PREWARM_DELAY_MS
  const schedule = options.schedule ?? ((run: () => void, ms: number) => {
    const timer = setTimeout(run, ms) as { unref?: () => void }
    // A pre-warm must never be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer as unknown as ReturnType<typeof setTimeout>)
  })
  const seen = new Set<string>()
  const pending = new Set<() => void>()
  const detachers: Array<() => void> = []
  let disposed = false

  const consider = (agent: PrewarmAgent | undefined): void => {
    if (disposed) return
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '' || seen.has(cwd)) return
    // Marked before the build, not after: two agents sharing one workspace must
    // not queue two identical scans.
    seen.add(cwd)
    const cancel = schedule(() => {
      pending.delete(cancel)
      if (!disposed) warm(cwd)
    }, delay)
    pending.add(cancel)
  }

  const off = host.on?.('agent/created', (payload) => consider(payload?.agent))
  if (typeof off === 'function') detachers.push(off)
  // Agents that already exist when this row activates (HMR, a reload, a plugin
  // mounted after the first session) get the same treatment.
  for (const agent of host.agents?.list() ?? []) consider(agent)

  return () => {
    disposed = true
    for (const cancel of pending) cancel()
    pending.clear()
    for (const detach of detachers) detach()
  }
}

/**
 * Install the taken-over tools into every live agent scope, and into every agent
 * created or disposed from now on.
 *
 * Deliberately a sub-generator so the disposers it yields belong to the plugin's
 * own effect list: plugin unload must tear these down even though each of them
 * also lives on an `agent.ctx` that outlives the plugin.
 *
 * A failing registration warns instead of rejecting the `agent/created`
 * listener. Rejecting would roll the agent's whole creation back — a plugin
 * setting would be able to stop a session from starting — while the built-in
 * tool the scope failed to shadow is still there, so the agent keeps a working
 * `read` and only loses the takeover.
 */
function* mountScoped(host: ForgeHostContext, rows: ForgeRow[]): Generator<unknown, void, unknown> {
  const install = createScopeInstaller(rows)
  const disposers = new Map<AgentLike, () => void>()
  const registry = optionalService<{ list(): AgentLike[] }>(host, 'agents')

  const attach = (agent: AgentLike | undefined): void => {
    if (agent === undefined || disposers.has(agent)) return
    try {
      disposers.set(agent, install(agent.ctx))
    } catch (cause) {
      host.logger?.warn(
        `dsh-forge: takeover registration failed, the built-in tool stays in place: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }
  const detach = (agent: AgentLike | undefined): void => {
    if (agent === undefined) return
    const dispose = disposers.get(agent)
    if (dispose === undefined) return
    disposers.delete(agent)
    dispose()
  }

  if (host.on === undefined || registry === undefined) {
    throw new Error(
      'dsh-forge: config.registration "takeover" needs the host agent registry to scope its tools — ' +
        'this host serves no `agents` service. Use "additive", or mount this plugin in a profile that hosts agents.',
    )
  }

  yield host.on('agent/created', ((payload: { agent?: AgentLike }) => attach(payload?.agent)) as (payload: never) => void)
  yield host.on('agent/disposed', ((payload: { agent?: AgentLike }) => detach(payload?.agent)) as (payload: never) => void)
  // Agents that already exist when this row activates (HMR, a reload, a plugin
  // mounted later than the first session) get the surface too, or takeover
  // would apply to new sessions only and look intermittent.
  for (const agent of registry.list()) attach(agent)

  yield () => {
    for (const agent of [...disposers.keys()]) detach(agent)
  }
}
