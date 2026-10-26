/**
 * View shims for the merged `ff_read` tool.
 *
 * `ff_outline` and `ff_find_symbol` became `view=outline` and
 * `view=definitions` on 2026-10-15 (the tool surface went 13 → 11). These
 * wrappers keep the historic call shape — `{ path }` for an outline,
 * `{ name }` for a definitions search — so the suites stay about behaviour
 * instead of about how many tools the surface happens to expose.
 *
 * @module dsh-forge/tests/lib/read-views
 */

/** `ff_read view=outline` with `ff_outline`'s argument shape. */
export function outlineView(read) {
  return { execute: (args, exec) => read.execute({ ...args, view: 'outline' }, exec) }
}

/** `ff_read view=definitions` with `ff_find_symbol`'s argument shape. */
export function definitionsView(read) {
  // `name` is this shim's spelling of `symbol`; drop it before the call so the
  // strict argument gate does not read it as an unknown parameter.
  return {
    execute: (args, exec) => {
      const { name, ...rest } = args
      return read.execute({ ...rest, view: 'definitions', symbol: name }, exec)
    },
  }
}
