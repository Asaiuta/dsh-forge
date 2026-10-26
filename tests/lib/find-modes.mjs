/**
 * `ffglob` was folded into `fffind` as `mode=glob`. These shims keep the old
 * call sites readable and keep the renderer in sync with the call, so a test
 * that says "glob" still exercises the glob code path end to end.
 */

function shim(find, mode) {
  return {
    name: `fffind[${mode}]`,
    description: find.description,
    parameters: find.parameters,
    output: {
      schema: find.output.schema,
      render: (args, value) => find.output.render({ ...args, mode }, value),
    },
    execute: (args, exec) => find.execute({ ...args, mode }, exec),
  }
}

/** Behaves like the pre-merge `ffglob`. */
export function globMode(find) {
  return shim(find, 'glob')
}

/** Behaves like the pre-merge `fffind`. */
export function nameMode(find) {
  return shim(find, 'name')
}
