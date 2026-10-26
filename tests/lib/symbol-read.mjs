// Test-only view adapter for the merged symbol read.
//
// `ff_read_symbol` was absorbed into `ff_read` (see src/tools-read.ts): the call
// shape is unchanged — `{ path, symbol, body, context, line, occurrence }` — but
// the result is now a batch read, so a definition comes back as `blocks[0]` and
// an unreadable/ambiguous target comes back through `skipped` instead of as a
// top-level `error`.
//
// This maps the real tool result onto the single-definition view the assertions
// were written against. It calls the real surface; only the presentation is
// normalised. New tests should assert on `blocks` directly.
export function singleSymbolView(result) {
  if (result === undefined || result === null) return { error: 'no result' }
  if (result.error !== undefined) return { error: result.error }
  const block = result.blocks?.[0]
  if (block === undefined) {
    const skipped = result.skipped?.[0]
    return { error: skipped ? skipped.reason : 'nothing read' }
  }
  const at = block.file.lastIndexOf('#')
  const range = /^L(\d+)-(\d+)$/.exec(block.lines ?? '')
  return {
    file: at < 0 ? block.file : block.file.slice(0, at),
    qualifiedName: at < 0 ? undefined : block.file.slice(at + 1),
    kind: block.kind,
    startLine: range ? Number(range[1]) : undefined,
    endLine: range ? Number(range[2]) : undefined,
    occurrence: block.occurrence,
    text: block.text,
  }
}

/**
 * Wrap a `createReadTool` factory into the single-definition view object the
 * symbol cases were written against, so a file only needs the factory name to
 * change when the merge lands.
 */
export function symbolReader(createReadTool) {
  const tool = createReadTool()
  return {
    tool,
    async execute(args, exec) { return singleSymbolView(await tool.execute(args, exec)) },
  }
}
