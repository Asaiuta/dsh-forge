/** Isolated WASM parser/cache; only matching metadata leaves this worker. */
import { parentPort } from 'node:worker_threads'
import { findSymbol, parseFileSearch, symbolOccurrences } from './ast.ts'
import { extractTraceFile } from './trace-facts.ts'

if (!parentPort) throw new Error('AST worker requires a worker thread')
interface Request { id: number; files: Array<{ file: string; index: number }>; name: string; kinds: string[] | null; kind?: 'trace'; deadline: number; cancellation: Int32Array }
let queue = Promise.resolve()
parentPort.on('message', (request: Request) => { queue = queue.then(() => handle(request)) })
async function handle(request: Request): Promise<void> {
  try {
    const results = []
    const traceResults = []
    let timedOut = false
    let cancelled = false
    for (const item of request.files) {
      if (Atomics.load(request.cancellation, 0) !== 0) { cancelled = true; break }
      if (Date.now() > request.deadline) { timedOut = true; break }
      if (request.kind === 'trace') {
        traceResults.push({ index: item.index, ...await extractTraceFile(item.file) })
        continue
      }
      const parsed = await parseFileSearch(item.file)
      if (!parsed.value) { results.push({ index: item.index, file: item.file, parsed: false, items: [] }); continue }
      const value = parsed.value
      const occurrences = symbolOccurrences(value.symbols)
      const items = findSymbol(value.symbols, request.name, false).filter(symbol => !request.kinds || request.kinds.includes(symbol.kind)).map(symbol => ({
        qualifiedName: symbol.qualifiedName, kind: symbol.kind, startLine: symbol.startLine, endLine: symbol.endLine,
        occurrence: occurrences.get(symbol)!,
        ...(symbol.commentStartLine === undefined ? {} : { commentStartLine: symbol.commentStartLine }),
        signature: value.signatures.get(symbol.startLine) ?? '',
      }))
      results.push({ index: item.index, file: item.file, parsed: true, items })
    }
    parentPort!.postMessage({ id: request.id, results, traceResults, timedOut, cancelled })
  } catch (cause) { parentPort!.postMessage({ id: request.id, error: cause instanceof Error ? cause.message : String(cause) }) }
}
