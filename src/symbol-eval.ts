/** Bounded symbol execution receipts, with session-scoped full evidence retrieval. */
import path from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { workdirOf, type ForgeExec } from './core.ts'
import { sourceRead, sourceSymbol } from './source-read.ts'
import { boundedOutput, jsonBytes, outputFragment, outputPreview, OUTPUT_CONTENT_BYTES } from './output-budget.ts'
import { EvalProcesses, type EvalServices } from './eval-process.ts'
import { evalRust } from './eval-rust.ts'

interface RecordEntry { scope: string; text: string; expires: number }
function jsonInput(raw: unknown, fallback: unknown, array: boolean) {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) throw new Error('args/kwargs must be JSON strings at most 64 KiB')
  const parsed: unknown = JSON.parse(raw)
  if (array ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(array ? 'args must encode an array' : 'kwargs must encode an object')
  return parsed
}
const scopeOf = (exec?: ForgeExec) => JSON.stringify([path.resolve(workdirOf(exec)), exec?.agent?.session?.header?.id ?? null])
export function createSymbolEvaluator(host: EvalServices) {
  const processes = new EvalProcesses(host)
  const records = new Map<string, RecordEntry>()
  let retainedBytes = 0
  const remove = (id: string) => { const entry = records.get(id); if (entry) retainedBytes -= Buffer.byteLength(entry.text); records.delete(id) }
  const prune = () => { for (const [id, entry] of records) if (entry.expires < Date.now()) remove(id) }
  return {
    description: 'Execute one exact source symbol in a fresh host-confined process: exported JS callable, Python function, or existing Rust Cargo test (offline). Imports/setup may have side effects under session policy. returned is not test success. Small results/logs return inline; resultComplete=false requires resultId + offset for full evidence, without re-execution.',
    parameters: {
      path: { type: 'string', description: 'Source file in the session workspace. Native JS, Python or Rust; no TS transpilation.' },
      symbol: { type: 'string', description: 'Exact qualified declaration, including Rust module path.' },
      line: { type: 'integer', description: 'Optional declaration start line to resolve duplicate symbols.' },
      args: { type: 'string', description: 'JSON argument array for JS/Python; default [].' },
      kwargs: { type: 'string', description: 'Python JSON keyword object; default {}.' },
      setup: { type: 'string', description: 'Optional async function body returning an argument array/list; exclusive with args. Uses its own scope.' },
      runtime: { type: 'string', description: 'Optional absolute executable. Defaults to node, workspace .venv Python then python, or cargo.' },
      timeoutMs: { type: 'integer', description: 'Total deadline: default 5000 (Rust 100000), max 110000.' },
      testTarget: { type: 'string', description: 'Rust: disambiguate Cargo target name.' },
      resultId: { type: 'string', description: 'Read stored evidence instead of running. Session-scoped; expires after 30 minutes or eviction (16 runs / 16 MiB).' },
      offset: { type: 'integer', description: 'Evidence UTF-16 offset, default 0; use returned nextOffset.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_: unknown, value: Record<string, unknown>) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    hygiene: { keepEmpty: ['args', 'kwargs', 'setup'] },
    isConcurrencySafe: () => false,
    dispose() { processes.dispose(); records.clear(); retainedBytes = 0 },
    async execute(args: Record<string, unknown>, exec?: ForgeExec): Promise<Record<string, unknown>> {
      if (Object.keys(args).some(k => !['path', 'symbol', 'line', 'args', 'kwargs', 'setup', 'runtime', 'timeoutMs', 'testTarget', 'resultId', 'offset'].includes(k))) throw new Error('unrelated parameter for action=eval')
      exec?.signal?.throwIfAborted(); prune()
      const scope = scopeOf(exec)
      if (args.resultId !== undefined) {
        if (Object.keys(args).some(k => !['resultId', 'offset'].includes(k))) throw new Error('evidence reads accept only resultId and offset')
        const entry = records.get(String(args.resultId))
        if (!entry || entry.scope !== scope) throw new Error('unknown/expired evaluation result; evidence cannot be recovered without re-execution')
        const offset = args.offset ?? 0
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(entry.text[offset]))) throw new Error('invalid evidence offset')
        const fragment = outputFragment(entry.text, offset)
        return boundedOutput({ resultId: args.resultId, offset, text: fragment.text, total: entry.text.length, complete: fragment.end === entry.text.length,
          ...(fragment.end < entry.text.length ? { nextOffset: fragment.end } : {}) }, 'read evidence fragments')
      }
      if (args.offset !== undefined) throw new Error('offset requires resultId')
      if (typeof args.path !== 'string' || args.path.length > 2048 || typeof args.symbol !== 'string' || !args.symbol.trim() || args.symbol.length > 512) throw new Error('path (max 2048 characters) and symbol (max 512) are required')
      if (args.line !== undefined && (typeof args.line !== 'number' || !Number.isSafeInteger(args.line) || args.line < 1)) throw new Error('line must be a positive declaration line')
      const cwd = realpathSync(workdirOf(exec)), file = realpathSync(path.resolve(cwd, args.path))
      const relative = path.relative(cwd, file)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('evaluation target must be inside the session workspace')
      const source = await sourceRead(file, exec)
      const { parsed, symbol } = await sourceSymbol(source, args.symbol, args.line as number | undefined)
      if (!['javascript', 'python', 'rust'].includes(parsed.lang)) throw new Error('evaluation supports native JavaScript, Python and existing Rust tests')
      if (!['function', 'method', 'variable', 'field'].includes(symbol.kind)) throw new Error('selected symbol is not a callable declaration')
      if (args.setup !== undefined && (typeof args.setup !== 'string' || Buffer.byteLength(args.setup) > 65536 || args.args !== undefined)) throw new Error('setup must be a body <=64 KiB and cannot accompany args')
      if (parsed.lang !== 'python' && args.kwargs !== undefined) throw new Error('kwargs is Python-only')
      if (parsed.lang !== 'rust' && args.testTarget !== undefined) throw new Error('testTarget is Rust-only')
      if (parsed.lang === 'rust' && ['args', 'kwargs', 'setup'].some(k => args[k] !== undefined)) throw new Error('Rust supports existing tests only, without args/setup')
      const arguments_ = jsonInput(args.args, [], true), kwargs = jsonInput(args.kwargs, {}, false)
      const timeoutMs = args.timeoutMs ?? (parsed.lang === 'rust' ? 100000 : 5000)
      if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 110000) throw new Error('timeoutMs must be 1–110000')
      const venv = path.join(cwd, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      const runtime = args.runtime ?? (parsed.lang === 'python' ? existsSync(venv) ? venv : 'python' : parsed.lang === 'rust' ? 'cargo' : 'node')
      if (typeof runtime !== 'string' || !runtime || (args.runtime !== undefined && !path.isAbsolute(runtime))) throw new Error('runtime override must be an absolute executable path')
      const context = processes.context(exec)
      const signal = AbortSignal.timeout(timeoutMs)
      const started = Date.now()
      let details: Record<string, unknown>
      try {
        if (parsed.lang === 'rust') details = await evalRust(processes, file, symbol.qualifiedName, runtime, cwd, exec, signal, args.testTarget as string | undefined)
        else {
          const marker = `FORGE_${randomBytes(18).toString('hex')}:`
          const worker = fileURLToPath(new URL(parsed.lang === 'python' ? './eval-worker.py' : './eval-worker.cjs', import.meta.url))
          const input = { file, symbol: symbol.qualifiedName, snapshot: source.snapshot, declaration: parsed.text.slice(symbol.startOffset, symbol.endOffset),
            firstLine: symbol.startLine, lastLine: symbol.endLine, args: arguments_, kwargs, setup: args.setup, marker }
          const result = await processes.run([runtime, worker], cwd, JSON.stringify(input), exec, signal)
          const position = result.stdout.lastIndexOf(`\n${marker}`)
          let payload: Record<string, unknown> | undefined
          let logs = result.stdout
          if (position >= 0) {
            const start = position + 1 + marker.length, end = result.stdout.indexOf('\n', start)
            try { payload = JSON.parse(result.stdout.slice(start, end < 0 ? undefined : end)) } catch { /* protocol failure below */ }
            logs = result.stdout.slice(0, position) + (end < 0 ? '' : result.stdout.slice(end + 1))
          }
          details = { ...payload, status: result.sandbox.runnerFailure ? 'sandbox_unavailable' : result.exitCode === 0 && payload ? payload.status : 'process_failed', exitCode: result.exitCode, sandbox: result.sandbox,
            stdout: logs, stderr: result.stderr, stdoutLossy: result.stdoutLossy, stderrLossy: result.stderrLossy }
        }
        const after = await sourceRead(file, exec)
        if (after.snapshot !== source.snapshot) details = { ...details, status: 'source_changed', afterSnapshot: after.snapshot }
      } catch (error) {
        if (exec?.signal?.aborted || processes.shutdown.signal.aborted) throw error
        details = { status: signal.aborted ? 'timeout' : 'process_failed', message: error instanceof Error ? error.message : String(error) }
      }
      const resultId = randomBytes(18).toString('base64url'), expires = Date.now() + 30 * 60_000
      const record = { path: file, symbol: symbol.qualifiedName, snapshot: source.snapshot, language: parsed.lang, runtime, policy: context.policy,
        elapsedMs: Date.now() - started, ...details }
      const text = JSON.stringify(record)
      records.set(resultId, { scope, text, expires }); retainedBytes += Buffer.byteLength(text)
      while (records.size > 16 || retainedBytes > 16 * 1024 * 1024) remove(records.keys().next().value!)
      const identity = { resultId, status: details.status, evidenceBytes: Buffer.byteLength(text),
        evidenceComplete: details.status !== 'timeout' && !JSON.stringify(details).includes('"stdoutLossy":true') && !JSON.stringify(details).includes('"stderrLossy":true'),
        expiresAt: new Date(expires).toISOString() }
      // The full stored record is the inline payload too: no second read is
      // needed for a small value, its logs, or its error. Capture loss remains
      // distinct from paging; an inline record can still contain lossy output.
      const inline = { ...identity, resultComplete: true, result: record }
      if (jsonBytes(inline) <= OUTPUT_CONTENT_BYTES) return inline
      return boundedOutput({ ...identity, resultComplete: false, path: file, symbol: symbol.qualifiedName, snapshot: source.snapshot,
        elapsedMs: record.elapsedMs, preview: outputPreview(JSON.stringify(details.value ?? details.message ?? details.test ?? details.status), 320),
        details: { resultId, offset: 0 } }, 'read evaluation details')
    },
  } as const
}
