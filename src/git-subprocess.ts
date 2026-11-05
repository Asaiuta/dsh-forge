/**
 * Execute `git` through the host's subprocess capability.
 *
 * The environment is scrubbed the way the harness spawns every child: ambient
 * `GIT_CONFIG_*` entries are dropped (`GIT_CONFIG_COUNT=0`, because credential
 * cleaning removes the indexed keys), prompting is disabled, `GIT_OPTIONAL_LOCKS=0`
 * keeps a read-only status from taking `index.lock` while the user works, and the
 * message locale is pinned so the parsers see the spellings they expect.
 *
 * There is deliberately no `node:child_process` fallback: when the host offers no
 * subprocess capability the Git page says so instead of spawning outside the sandbox.
 *
 * @module dsh-forge/git-subprocess
 */

import { readFile } from 'node:fs/promises'
import type { GitRun, GitRunResult, ReadWorktree } from './git-reader.ts'

/** Milliseconds one git child may run before it is abandoned. */
const TIMEOUT_MS = 30_000
/** Bytes of stdout kept for one command; larger output is reported as truncated. */
const OUTPUT_MAX_BYTES = 8 * 1024 * 1024
/** Bytes of stderr kept for diagnostics. */
const STDERR_MAX_BYTES = 16 * 1024
/** Milliseconds a git child gets after termination starts. */
const TERMINATE_GRACE_MS = 2_000
/** One side of a diff is refused above this size rather than truncated. */
export const DIFF_SIDE_MAX_BYTES = 1024 * 1024

/** The slice of `ctx.subprocess` this module needs. */
export interface SubprocessLike {
  spawn(spec: {
    argv: string[]
    cwd?: string
    stdio?: { stdin?: 'ignore' | { data: string }; stdout?: { maxBytes: number } | 'inherit'; stderr?: { maxBytes: number } | 'inherit' }
    graceMs?: number
    signal?: AbortSignal
    env?: Record<string, string>
  }): {
    done: Promise<{ exitCode: number | null; signal?: string | null }>
    collected: { stdout?: { readFrom(offset: number): { text: string; lossy: boolean } }; stderr?: { readFrom(offset: number): { text: string; lossy: boolean } } }
  }
}

/** The scrubbed, git-specific child environment. */
export function gitEnvironment(): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_MESSAGES: 'C',
  }
}

/**
 * Build a {@link GitRun} over the host subprocess service.
 *
 * @param service - `ctx.subprocess`, read through the host accessor.
 * @param options - timeout override, for one slow repository.
 * @returns a runner that never throws for a non-zero exit; the reader classifies.
 */
export function createGitRun(service: SubprocessLike, options: { timeoutMs?: number } = {}): GitRun {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  return async (args: string[], runOptions: { cwd?: string } = {}): Promise<GitRunResult> => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const handle = service.spawn({
      argv: ['git', ...args],
      ...(runOptions.cwd === undefined ? {} : { cwd: runOptions.cwd }),
      stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
      graceMs: TERMINATE_GRACE_MS,
      signal: timeout,
      env: gitEnvironment(),
    })
    let outcome: { exitCode: number | null }
    try { outcome = await handle.done }
    catch (error) {
      // A spawn rejection (git missing) and an abort are both facts the page must show.
      if (timeout.aborted) throw new Error(`git ${args[0] ?? ''} 在 ${timeoutMs}ms 后超时`)
      throw new Error(`无法运行 git：${error instanceof Error ? error.message : String(error)}`)
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    if (stdout.lossy) throw new Error(`git ${args[0] ?? ''} 输出超过 ${OUTPUT_MAX_BYTES} 字节，已放弃本次读取`)
    return { exitCode: outcome.exitCode ?? -1, stdout: stdout.text, stderr }
  }
}

/**
 * Read a worktree file as text.
 *
 * @returns `null` for a missing or undecodable file; the diff then reports that
 *   side as absent instead of inventing content.
 */
export const readWorktreeText: ReadWorktree = async (absolute) => {
  try { return await readFile(absolute, 'utf8') }
  catch { return null }
}
