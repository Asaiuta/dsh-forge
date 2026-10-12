/** Isolated WASM parser/cache; only matching metadata leaves this worker. */
import { parentPort } from 'node:worker_threads'
import { findSymbol, parseFile, symbolOccurrences } from './ast.ts'

if (!parentPort) throw new Error('AST worker requires a worker thread')
parentPort.on('message', async (request: { id: number; files: Array<{ file: string; index: number }>; name: string; kinds: string[] | null; deadline: number; cancellation: Int32Array }) => {
  try {
    const results = []
    let timedOut = false
    let cancelled = false
    for (const item of request.files) {
      if (Atomics.load(request.cancellation, 0) !== 0) { cancelled = true; break }
      if (Date.now() > request.deadline) { timedOut = true; break }
      const parsed = await parseFile(item.file)
      if (!parsed.value) { results.push({ index: item.index, file: item.file, parsed: false, items: [] }); continue }
      const lines = parsed.value.text.split('\n')
      const occurrences = symbolOccurrences(parsed.value.symbols)
      const items = findSymbol(parsed.value.symbols, request.name, false).filter(symbol => !request.kinds || request.kinds.includes(symbol.kind)).map(symbol => ({
        qualifiedName: symbol.qualifiedName, kind: symbol.kind, startLine: symbol.startLine, endLine: symbol.endLine,
        occurrence: occurrences.get(symbol)!,
        ...(symbol.commentStartLine === undefined ? {} : { commentStartLine: symbol.commentStartLine }),
        signature: (lines[symbol.startLine - 1] ?? '').slice(0, 500),
      }))
      results.push({ index: item.index, file: item.file, parsed: true, items })
    }
    parentPort!.postMessage({ id: request.id, results, timedOut, cancelled })
  } catch (cause) { parentPort!.postMessage({ id: request.id, error: cause instanceof Error ? cause.message : String(cause) }) }
})
