/** Independent static verification. No source writes and no synthetic edit batches. */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { canonicalTarget, canonicalWorkspace, within } from './fs-paths.ts'
import { observedRead, workdirOf, type ForgeExec } from './core.ts'
import { normaliseChecks, runStaticCheck } from './check-static.ts'
import { detectLanguage, syntaxValid } from './ast.ts'
import { storeFor } from './ledger.ts'
import { persistRecord } from './check-record.ts'
import { aggregateChecks, sha256Bytes, type CheckResult } from './verification.ts'

export function createStaticVerifier() {
  return {
    description: 'Persist independent static verification without editing source files. Select an existing batch integer OR one workspace file path. Batch checks use recorded before/after evidence. Path checks support current syntax; bridge/ipc are not_run (no_baseline), never a fabricated comparison.',
    parameters: {
      batch: { type: 'integer', description: 'Existing positive ledger batch id; exclusive with path.' },
      path: { type: 'string', description: 'One existing workspace file; exclusive with batch. No directory or substring matching.' },
      checks: { type: 'array', items: { type: 'string', enum: ['bridge', 'ipc', 'syntax'] }, description: 'Nonempty static check list. Defaults: path -> syntax; batch -> bridge and syntax.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }] },
    // batch 补成 0 与「没选」同义，否则会和 path 撞成「二选一」冲突。
    hygiene: { zeroMeansAbsent: ['batch'] },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      try {
        for (const key of Object.keys(args)) if (!['batch', 'path', 'checks'].includes(key)) throw new Error(`${key} is not allowed for action=verify`)
        if ((args.batch === undefined) === (args.path === undefined)) throw new Error('provide exactly one of batch or path')
        if (args.checks !== undefined && !Array.isArray(args.checks)) throw new Error('checks must be a nonempty list')
        const normalized = normaliseChecks(args.checks ?? (args.path !== undefined ? ['syntax'] : undefined))
        if (!normalized.ok) throw new Error(normalized.detail)
        if (args.batch !== undefined) {
          if (!Number.isSafeInteger(args.batch) || Number(args.batch) < 1) throw new Error('batch must be a positive integer')
          const result = await runStaticCheck({ batches: [args.batch], checks: normalized.checks }, exec)
          return 'reason' in result && result.reason === 'no_batches' ? { error: result.detail } : result
        }
        if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('path must be a nonempty file path')
        const workspace = canonicalWorkspace(workdirOf(exec))
        const abs = canonicalTarget(path.resolve(workspace, args.path))
        if (!within(workspace, abs)) throw new Error('verify path must stay inside the workspace')
        await exec?.authorizeNativePaths?.([abs])
        if (!statSync(abs).isFile()) throw new Error('verify path must name a regular file')
        const startedAt = new Date().toISOString()
        const bytes = await observedRead(exec, abs, file => {
          if (statSync(file).size > 8 * 1024 * 1024) throw new Error('verify file exceeds 8MB cap')
          return readFileSync(file)
        })
        const hash = sha256Bytes(bytes), rel = path.relative(workspace, abs).split(path.sep).join('/')
        const checks: CheckResult[] = []
        for (const kind of normalized.checks) {
          exec?.signal?.throwIfAborted()
          if (kind !== 'syntax') {
            checks.push({ id: kind, kind, status: 'not_run', reason: 'no_baseline: path scope has no recorded before evidence; use batch for bridge/ipc comparison', coverage: { files: 0 }, findings: [] })
            continue
          }
          const language = detectLanguage(abs)
          let raw: string | undefined
          try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { /* Unsupported encoding is not a syntax verdict. */ }
          if (!language || raw === undefined || raw.includes('\0')) {
            checks.push({ id: kind, kind, status: 'not_run', reason: 'syntax parser unavailable for this language or encoding', coverage: { files: 0 }, findings: [] })
          } else {
            const valid = await syntaxValid(raw.replace(/^\uFEFF/, ''), language)
            checks.push({ id: kind, kind, status: valid ? 'passed' : 'failed', coverage: { files: 1 }, findings: valid ? [] : [{ code: 'syntax_error', message: 'tree-sitter reports syntax errors', source: { file: rel } }] })
          }
        }
        if (sha256Bytes(readFileSync(abs)) !== hash) return { status: 'stale', text: '[verify] stale: input changed during verification; no record persisted' }
        const required = normalized.checks
        const verdict = aggregateChecks(required, checks, 'internal-static')
        const verification = await persistRecord(workspace, storeFor(workspace), 'internal-static', [], required, checks, [{ file: rel, hash }], startedAt)
        return { status: verdict.status, checks, files: [rel], verification,
          text: `[verify] ${verdict.status}: ${checks.map(check => `${check.kind}=${check.status}${check.reason ? ` (${check.reason})` : ''}`).join('; ')}; ${verification.persisted ? `archived ${verification.id}` : `not persisted: ${verification.detail}`}` }
      } catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) } }
    },
  } as const
}

