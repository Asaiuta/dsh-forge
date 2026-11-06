/** Fresh processes through the calling agent's host services, never child_process. */
import type { ForgeExec } from './core.ts'
import type { ForgePolicyService, ForgeSandboxPolicy } from './execution.ts'
import type { SubprocessLike } from './git-subprocess.ts'

export interface EvalSandbox {
  confine(argv: string[], policy: ForgeSandboxPolicy, signal: AbortSignal): Promise<{ argv: string[]; enforcement?: string;
    denialSignatures?: string[]; runnerFailureRules?: Array<{ allowedExitCodes?: number[]; informationalLines?: string[]; fatalSignatures: string[] }> }>
}
export interface EvalServices { get(name: string): unknown }
export interface EvalProcessResult { exitCode: number | null; stdout: string; stderr: string; stdoutLossy: boolean; stderrLossy: boolean;
  sandbox: { mode: string; enforcement?: string; denied: boolean; runnerFailure?: string } }
export class EvalProcesses {
  readonly shutdown = new AbortController()
  constructor(private readonly host: EvalServices) {}
  dispose(): void { this.shutdown.abort(new Error('forge disposed')) }
  context(exec?: ForgeExec) {
    const services = exec?.agent?.ctx ?? this.host
    const subprocess = services.get('subprocess') as SubprocessLike | undefined
    const policies = services.get('sandboxPolicy') as ForgePolicyService | undefined
    if (!subprocess?.spawn || !policies?.resolve) throw new Error('ff_edit action=eval requires host subprocess and sandboxPolicy services')
    const policy = policies.resolve({ session: exec?.agent?.session })
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode) || !policy.workspaceRoot) throw new Error('invalid host execution policy')
    const sandbox = services.get('sandbox') as EvalSandbox | undefined
    if (policy.mode !== 'danger-full-access' && !sandbox?.confine) throw new Error('ff_edit action=eval requires host process confinement for this sandbox mode')
    return { subprocess, policy, sandbox }
  }
  async run(argv: string[], cwd: string, input: string, exec: ForgeExec | undefined, signal: AbortSignal): Promise<EvalProcessResult> {
    const { subprocess, policy, sandbox } = this.context(exec)
    const combined = AbortSignal.any([signal, this.shutdown.signal, ...(exec?.signal ? [exec.signal] : [])])
    combined.throwIfAborted()
    const confined: Awaited<ReturnType<EvalSandbox['confine']>> = policy.mode === 'danger-full-access' ? { argv } : await sandbox!.confine(argv, policy, combined)
    combined.throwIfAborted()
    const handle = subprocess.spawn({ argv: confined.argv, cwd, signal: combined, graceMs: 1000,
      env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', CARGO_NET_OFFLINE: 'true', CARGO_TERM_COLOR: 'never', RUST_BACKTRACE: '0' },
      stdio: { stdin: { data: input }, stdout: { maxBytes: 1024 * 1024 + 65536 }, stderr: { maxBytes: 65536 } },
    })
    try {
      const done = await handle.done
      await (handle as typeof handle & { waitForExit?: () => Promise<unknown> }).waitForExit?.()
      combined.throwIfAborted()
      const stdout = handle.collected.stdout?.readFrom(0), stderr = handle.collected.stderr?.readFrom(0)
      const errorText = stderr?.text ?? ''
      const runnerFailure = done.exitCode && confined.runnerFailureRules?.flatMap(rule => {
        if (rule.allowedExitCodes && !rule.allowedExitCodes.includes(done.exitCode!)) return []
        const ignored = new Set(rule.informationalLines?.map(line => line.toLowerCase()))
        return errorText.split(/\r?\n/).filter(line => !ignored.has(line.toLowerCase()) && rule.fatalSignatures.some(s => s.trim() && line.toLowerCase().includes(s.toLowerCase())))
      })[0]
      return { exitCode: done.exitCode, stdout: stdout?.text ?? '', stderr: errorText, stdoutLossy: stdout?.lossy ?? false, stderrLossy: stderr?.lossy ?? false,
        sandbox: { mode: policy.mode, ...(confined.enforcement ? { enforcement: confined.enforcement } : {}),
          denied: done.exitCode !== null && done.exitCode !== 0 && Boolean(confined.denialSignatures?.some(s => errorText.toLowerCase().includes(s.toLowerCase()))),
          ...(runnerFailure ? { runnerFailure } : {}) } }
    } finally {
      // Current DSH separates foreground completion from process-tree settlement.
      await (handle as typeof handle & { waitForExit?: () => Promise<unknown> }).waitForExit?.()
    }
  }
}
