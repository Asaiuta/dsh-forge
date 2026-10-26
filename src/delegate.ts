/**
 * Delegation to the built-in a tool took over — "serve the built-in's answer
 * when serving our own could be wrong".
 *
 * A takeover replaces the built-in for an agent scope, and `dsh-tools` offers
 * no way to *call* the shadowed definition from inside the shadow. It does offer
 * {@link ToolRuntime.get}: "Look up a tool as one scope sees it (scoped shadows
 * global); omitted = the global view". The built-in fs tools register with
 * `ctx.tools.register` on the plugin's own (global) context — verified in
 * `dsh-tool-fs-search`'s `applyGrepTool`/`applyGlobTool` — so the global view
 * still resolves to the built-in after our scoped registration shadows it. That
 * is the handle this module hands out.
 *
 * Three rules, each of which exists because the alternative is a wrong answer:
 *
 * 1. **Never resolve to ourselves.** `get` is a registry read, and a scoped
 *    implementation that resolves its own name would recurse until the stack
 *    dies. Every forge definition carries {@link FORGE_DEFINITION_TAG}, and a
 *    tagged hit reads as "no built-in here".
 * 2. **Never cache.** The registry changes under us (a plugin unloading, an HMR
 *    reload, the fs tools mounting *after* this plugin in the cordis load
 *    order). One `get` per call is a map lookup; a stale handle is a tool that
 *    answers for a definition that no longer exists.
 * 3. **Never throw on absence.** A missing handle disables delegation for that
 *    call and the caller keeps its own answer. Delegation is an improvement,
 *    never a dependency — the plugin has to work on hosts that serve no fs
 *    tools at all.
 *
 * @module dsh-forge/delegate
 */

import type { ScopedToolLookup } from './guidance.ts'

/**
 * Marks a definition as forge's own. `defineForgeTool` stamps it, so the check
 * is a property read rather than an identity comparison against a list of
 * definitions that `dsh-tools` never publishes.
 */
export const FORGE_DEFINITION_TAG = 'dshForgeName'

/** A tool definition as the delegate needs to see it. Structural: no SDK import. */
interface DelegatableDefinition {
  execute?: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> | unknown
  [FORGE_DEFINITION_TAG]?: unknown
}

/** What one delegated call produced. Absence and failure are distinct. */
export type DelegateResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/**
 * The built-in a forge tool may fall back to.
 *
 * Deliberately two methods and no state: `available` answers "would `run` find
 * anything", `run` performs the call. A caller checks `available` once per
 * invocation to decide whether the fallback path exists at all, then calls
 * `run` at most twice (the disk check is idempotent and cheap only once).
 */
export interface NativeDelegate {
  /** Whether a built-in definition named `name` is resolvable right now. */
  available(name: string): boolean
  /**
   * Execute the built-in named `name`.
   *
   * @param name - the built-in's registry name (`grep`).
   * @param args - the **built-in's** argument shape, not forge's. The built-in
   *   validates its own schema, so forwarding forge's extra parameters would
   *   fail there instead of falling back where it was meant to.
   * @param exec - the raw tool-run context of the *current* call. Not a copy:
   *   `dsh-tools` keys per-execution bookkeeping (`deferContext`, the
   *   cancellation marker) by object identity.
   * @returns the built-in's value, or its error message.
   */
  run(name: string, args: Record<string, unknown>, exec: unknown): Promise<DelegateResult>
}

/**
 * Build the delegate over a tool registry.
 *
 * @param tools - the registry slice (`get(name, scope?)`). A host without it
 *   yields `undefined`, which every caller reads as "no fallback".
 * @returns a delegate, or `undefined` when the registry cannot be read.
 */
export function createNativeDelegate(tools: ScopedToolLookup | undefined): NativeDelegate | undefined {
  if (tools === undefined || typeof tools.get !== 'function') return undefined
  const resolve = (name: string): DelegatableDefinition | undefined => {
    let found: unknown
    try {
      // No scope on purpose — see the module comment: the global view is the
      // only one that still holds the definition our scoped registration
      // shadows. Passing the calling agent would resolve our own tool back.
      found = tools.get(name)
    } catch {
      // A refused read is not proof the tool is gone, but it *is* proof we
      // cannot call it this time. Both callers treat this as "no fallback".
      return undefined
    }
    if (typeof found !== 'object' || found === null) return undefined
    const definition = found as DelegatableDefinition
    if (definition[FORGE_DEFINITION_TAG] !== undefined) return undefined
    return typeof definition.execute === 'function' ? definition : undefined
  }

  return {
    available: (name) => resolve(name) !== undefined,
    async run(name, args, exec) {
      const definition = resolve(name)
      if (definition === undefined) return { ok: false, error: `${name} is not available on this host` }
      const execute = definition.execute
      if (execute === undefined) return { ok: false, error: `${name} is not available on this host` }
      try {
        return { ok: true, value: await execute.call(definition, args, exec) }
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
      }
    },
  }
}
