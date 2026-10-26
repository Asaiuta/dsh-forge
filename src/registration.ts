/**
 * Where forge's tools are registered — the mechanism behind the
 * `registration` setting in {@link module:dsh-forge/config}.
 *
 * Two layers exist in the host and they are not equivalent:
 *
 *   global   `ctx.tools.register()` from the plugin's own context. Visible to
 *            every agent, duplicate names throw
 *            (`dsh-tools`: `tool "x" is already registered`).
 *
 *   scoped   `agent.ctx.tools.register()` from an agent's context. **Shadows**
 *            a global of the same name for that agent only
 *            (`dsh-tools`: "Scoped registrations shadow globals"), which is the
 *            only supported way to replace the built-in `read`.
 *
 * So `takeover` is not a rename of the global registration: it has to move into
 * each agent's scope, one registration per live agent, owned by that agent's
 * lifetime. `practices.md` states the ownership rule this file implements:
 * "Register per-agent behavior on `agent.ctx`, obtained in an `agent/created`
 * listener, so it is removed when that agent is disposed. Wrap it in one
 * `agent.ctx.effect()` and also keep that disposer, keyed by agent, in your
 * plugin's own effect; unloading the plugin does not dispose `agent.ctx`
 * registrations by itself."
 *
 * Deliberately absent: any `ctx.tools.restrict()` call. A taken-over name does
 * not need the global hidden — the scoped registration already shadows it, and
 * a restriction would also mask the *other* forge tools for that agent.
 *
 * @module dsh-forge/registration
 */

import type { ForgeCapability, ForgeSurface } from './guidance.ts'
import type { ForgeConfig } from './config.ts'

/**
 * One forge tool, as the registration layer sees it.
 *
 * `build` is lazy on purpose: in `additive` mode every row is built during
 * activation, while in `takeover` mode the scoped rows are only built when an
 * agent appears — and a headless boot that never creates one pays nothing.
 */
export interface ForgeRow {
  /** Forge's own name, e.g. `ff_read`. Also the audit/presentation label. */
  readonly forge: string
  /** Built-in name this row can replace, when it has one. */
  readonly native?: string
  /**
   * Compile the tool definition.
   *
   * @param as - the registry name to serve under; omit for the forge name.
   *   The audit label is unaffected — see `registerAs` in `./host.ts`.
   */
  build(as?: string): unknown
}

/** Which rows go where. Both lists are disjoint by construction. */
export interface RegistrationPlan {
  global: ForgeRow[]
  scoped: ForgeRow[]
}

/**
 * Split the tool table according to the resolved settings.
 *
 * A row is taken over only when the user listed *its* native name: listing
 * `read` must not move `ffgrep` into a scope, and a row without a native name
 * has nowhere else to go.
 *
 * @param config - resolved plugin settings.
 * @param rows - the complete forge tool table, in registration order.
 * @returns the global and scoped subsets, each preserving table order.
 */
export function planRegistration(config: ForgeConfig, rows: readonly ForgeRow[]): RegistrationPlan {
  if (config.registration === 'additive') return { global: [...rows], scoped: [] }
  const taken = new Set<string>(config.takeover)
  const global: ForgeRow[] = []
  const scoped: ForgeRow[] = []
  for (const row of rows) {
    if (row.native !== undefined && taken.has(row.native)) scoped.push(row)
    else global.push(row)
  }
  return { global, scoped }
}

/**
 * The name surface a plan actually serves: which capability ends up under which
 * name once the taken-over rows move into agent scopes.
 *
 * The guidance section is generated from this, so the text can never announce a
 * name that the registry does not answer to.
 *
 * @param plan - the registration plan.
 * @param base - the additive surface, used for every capability not taken over.
 * @returns a surface with the taken-over capabilities renamed.
 */
export function surfaceFor(plan: RegistrationPlan, base: ForgeSurface): ForgeSurface {
  const takenOver = new Map(plan.scoped.map((row) => [row.forge, row.native ?? row.forge]))
  const surface = { ...base }
  for (const capability of Object.keys(base) as ForgeCapability[]) {
    const native = takenOver.get(base[capability])
    if (native !== undefined) surface[capability] = native
  }
  return surface
}

/**
 * The registry slice a scope exposes. Structural, so a scoped `agent.ctx` and a
 * test double satisfy it without importing the host's types.
 */
export interface ScopeLike {
  tools: { register(definition: unknown): (() => void) | void }
  effect?<T>(body: () => T | (() => void)): () => void
}

/**
 * Build one installer per plugin instance, so definitions are compiled once and
 * shared by every agent that mounts them.
 *
 * @param rows - rows to install into each scope.
 * @returns `install(scope)` → an idempotent disposer for that scope.
 */
export function createScopeInstaller(rows: readonly ForgeRow[]): (scope: ScopeLike) => () => void {
  let built: unknown[] | undefined
  // Built once with the native name: every scope serves the same name, and
  // recompiling the schema per agent would be pure waste.
  const definitions = (): unknown[] => {
    built ??= rows.map((row) => row.build(row.native))
    return built
  }
  return (scope: ScopeLike): (() => void) => {
    const register = (): (() => void) => {
      const disposers: Array<() => void> = []
      try {
        for (const definition of definitions()) {
          const dispose = scope.tools.register(definition)
          if (typeof dispose === 'function') disposers.push(dispose)
        }
      } catch (cause) {
        // A partially installed scope is worse than none: the agent would see
        // some taken-over tools and, for the rest, whichever global still
        // happens to match. Unwind before rethrowing so activation is atomic.
        for (const dispose of disposers.splice(0).reverse()) dispose()
        throw cause
      }
      return () => {
        for (const dispose of disposers.splice(0).reverse()) dispose()
      }
    }
    // `agent.ctx.effect` ties the registrations to the scope's own disposal, so
    // an agent going away cannot leave forge's tools behind. Hosts without the
    // effect helper (a fake registry in a test) still get the manual disposer.
    return typeof scope.effect === 'function' ? scope.effect(register) : register()
  }
}
