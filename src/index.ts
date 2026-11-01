/**
 * dsh-forge cordis glue: registers the forge tools, the forge prompt-guidance
 * section and the /forge-status command on the host-plane registries, and
 * augments the built-in read/grep/glob in place. Mounted by
 * the bundle patch as a host-plane insert (dsh-ssh shape), NOT inside the
 * preset groups — dsh-blackhole's patch already full-restates
 * preset-standard's config, and a second full restatement would overwrite its
 * entries.
 *
 * The default `retrieval` surface registers only fffind, ffgrep and ff_read.
 * `full` adds the write, history, file and Trace tools. The FinderPool stays
 * lazy and built-in augmentations are always installed when supported.
 *
 * Lifecycle protocol: apply is a *generator function* (plain functions get
 * `new`-constructed and their return value dropped) and every yielded value is
 * collected as a disposable by the fork's `_execute` iterator branch.
 *
 * @module dsh-forge
 */

import { defineForgeTool } from './host.ts'
import type { Context } from '@deepseek-ai/cordis'
import { FinderPool } from './core.ts'
import { createFindTool, createGrepTool } from './tools.ts'
import { createStatusCommand } from './status.ts'
import { createEditTool, createHistoryTool, createRollbackTool } from './tools-edit.ts'
import { createExecutionGuard, type ForgeFileSystem, type ForgeFsEvents, type ForgePolicyService } from './execution.ts'
import { AUGMENTED_BUILTINS, installAugmentation, type AugmentHost } from './augment.ts'
import { createFileTool } from './tools-files.ts'
import { createReadTool } from './tools-read.ts'
import { createTraceTool } from './tools-trace.ts'
import { createVerifyTool } from './tools-verify.ts'
import { createProjectTool } from './tools-project.ts'
import { AstWorkerPool } from './ast-pool.ts'
import { Config, resolveConfig } from './config.ts'
import { planRegistration, type ForgeRow } from './registration.ts'
import {
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
 * `ctx.get()` — `sandboxPolicy`, `agents` and `workingDirectory` here, and
 * `spillStore` in the official search package.
 */
export const inject = ['tools', 'commands', 'fs', 'systemPrompt'] as const

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
  on?(event: string, listener: (...args: never[]) => unknown): (() => void) | void
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
  const toolLookup: ScopedToolLookup | undefined =
    typeof host.tools.get === 'function' ? { get: (toolName, scope) => host.tools.get?.(toolName, scope) } : undefined
  const augmentation = installAugmentation(host as unknown as AugmentHost, { names: AUGMENTED_BUILTINS })
  if (augmentation !== undefined) yield () => augmentation.dispose()
  const rows: ForgeRow[] = [
    { forge: 'ff_find', surface: 'retrieval', build: () => defineForgeTool(createFindTool(pool), guard, integration) },
    { forge: 'ff_grep', surface: 'retrieval', build: () => defineForgeTool(createGrepTool(pool), guard, integration) },
    { forge: 'ff_symbols', surface: 'retrieval', build: () => defineForgeTool(createReadTool(workers), guard, integration) },
    { forge: 'ff_edit', surface: 'full', build: () => defineForgeTool(createEditTool(pool), guard, integration) },
    { forge: 'ff_history', surface: 'full', build: () => defineForgeTool(createHistoryTool(), guard, integration) },
    { forge: 'ff_rollback', surface: 'full', build: () => defineForgeTool(createRollbackTool(pool), guard, integration) },
    { forge: 'ff_file', surface: 'full', build: () => defineForgeTool(createFileTool(), guard, integration) },
    // Full, not retrieval — measured both ways on 2026-11-01. `fftrace` answers
    // wiring questions grep cannot phrase at all, and it never failed once (27
    // calls / 188 sessions). But those 27 calls are 0.14 per session, while its
    // schema costs every session +2,782 B native / +5,390 B PTC and one more
    // guidance line. Entering the default mount would nearly double the
    // retrieval surface for a tool a session uses one time in seven. Move this
    // row to 'retrieval' when wiring questions become the common case.
    { forge: 'ff_trace', surface: 'full', build: () => defineForgeTool(createTraceTool(workers), guard, integration) },
    { forge: 'ff_verify', surface: 'full', build: () => defineForgeTool(createVerifyTool(), guard, integration) },
    { forge: 'ff_project', surface: 'full', build: () => defineForgeTool(createProjectTool(), guard, integration) },
  ]

  const registered = planRegistration(config, rows)
  const registeredNames = registered.map((row) => row.forge)
  for (const row of registered) {
    yield host.tools.register(row.build())
  }

  yield host.commands.register(createStatusCommand(pool, {
    surface: config.surface,
    ...(augmentation === undefined ? {} : { augmentation }),
  }))

  // Registering these tools makes them callable, not known: without this the
  // assembled prompt names no forge tool at all, and a session falls back to the
  // built-in surface it already has habits for (measured — see src/guidance.ts
  // for the section's placement and visibility contract).
  if (host.systemPrompt !== undefined) {
    yield host.systemPrompt.section({
      name: FORGE_GUIDANCE_SECTION,
      order: FORGE_GUIDANCE_ORDER,
      text: visibleForgeText(
        toolLookup,
        augmentation === undefined ? [] : [...AUGMENTED_BUILTINS],
        registeredNames,
      ),
    })
  }

  yield () => { pool.disposeAll(); void workers.dispose() }
}
