/**
 * Host verification adapter: prove the approval channel before offering to run
 * anything.
 *
 * M1.3 made `ffcheck action=static` able to say "nothing it can see is broken".
 * It cannot say a test passed, because a test needs a process, and a process
 * spawned by a plugin proves nothing about the harness's permission model. The
 * plan (§M1.4) therefore requires the opposite order: verify what the installed
 * host actually exposes, and stay `unavailable` when the evidence is missing —
 * never spawn directly and call it verification.
 *
 * Everything here is resolved by NAME at call time through `ctx.get`. That is
 * the only honest way to ask "does this deployment have it": a static `inject`
 * would hold the plugin hostage to a service the deployment may not compose,
 * and a hard import would make the plugin's own availability the proof.
 */
import { createHash } from 'node:crypto'
import { readBoundedFile } from './fs-paths.ts'

/**
 * What a deployment can actually do, as observed rather than assumed.
 *
 * `symbols` records the exact member names that were found, so a later reader
 * can tell "the seam exists but changed shape" from "the seam is absent".
 */
export interface HostCheckCapabilities {
  /** `ok` only when every seam the adapter needs is present with the expected shape. */
  status: 'ok' | 'unavailable'
  approval: { available: boolean; symbol?: string }
  subprocess: { available: boolean; symbol?: string }
  /** Why `status` is not `ok`; absent when it is. */
  reason?: string
  /** Node's runtime version, the one fact the adapter can read without guessing. */
  runtime: string
}

/**
 * One resolved check invocation.
 *
 * `raw` keeps OBJECT IDENTITY of the tool-run context: `dsh-tools` keys
 * per-execution bookkeeping (content finalizers, cancellation state) by that
 * object, and the approval request must carry the execution's own `agent`,
 * `callId` and `signal`. A copy — or anything serialized to disk and read back
 * — would be a different execution, so `run` takes the live object and refuses
 * a stand-in.
 */
export interface HostCheckRequest {
  /** Which saved recipe this execution belongs to; recorded, never re-derived. */
  recipeId: string
  program: string
  argv: readonly string[]
  cwd: string
  /** Why a human is being asked; shown verbatim in the approval prompt. */
  reason: string
  /** The live tool-run context. Never persisted, never cloned. */
  raw: HostCheckExecution
  /** Recheck the plan's frozen inputs after approval and before dispatch. */
  beforeSpawn?: () => string | undefined
}

/** The members the adapter reads off the live execution object. */
export interface HostCheckExecution {
  agent?: unknown
  callId?: string
  signal?: AbortSignal
}

/**
 * Where the output of a completed run can be found again.
 *
 * `spill` is the host's own complete-stream artifact; `digest` covers the tail
 * the adapter actually read, so a caller can tell truncation from completeness
 * without trusting a byte count alone.
 */
export interface HostStreamRef {
  sha256: string
  bytes: number
  truncated: boolean
  spillPath?: string
  detail?: string
}

export type HostOutputRef = {
  kind: 'spill'
  path: string
  bytes: number
  sha256: string
  truncated: boolean
  streams: { stdout: HostStreamRef; stderr: HostStreamRef }
} | {
  kind: 'digest'
  sha256: string
  bytes: number
  truncated: boolean
  streams: { stdout: HostStreamRef; stderr: HostStreamRef }
}

/**
 * The closed outcome vocabulary.
 *
 * `running` exists because a background launch receipt is not a result: a
 * deployment that cannot deliver a terminal outcome says `running` forever, and
 * a caller must not read that as success. This adapter never produces it — it
 * refuses background requests instead of inventing a terminal channel.
 */
export type HostCheckResult =
  | { status: 'unavailable'; reason: string; detail?: string }
  | { status: 'denied'; reason: string; approvalOutcome: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'interrupted'; reason: string; detail?: string }
  | { status: 'stale'; reason: string }
  | {
    status: 'completed'
    /** Registry-assigned identity of the call that was approved. */
    callId: string
    exitCode: number | null
    signal: string | null
    output: HostOutputRef
    /** Tail text, bounded. Absence of truncation is asserted by `output`. */
    text: string
    stdout: string
    stderr: string
  }

/** The minimum shape an approval seam must present to be used. */
interface ApprovalLike {
  request(req: {
    agent: unknown
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<string>
}

/** The minimum shape a subprocess seam must present to be used. */
interface SubprocessLike {
  spawn(spec: Record<string, unknown>): {
    done: Promise<{ exitCode: number | null; signal: string | null }>
    terminate?(): unknown
    waitForExit?(): Promise<unknown>
    collected?: { stdout?: { readFrom(offset: number): CollectedRead }; stderr?: { readFrom(offset: number): CollectedRead } }
  }
}

interface CollectedRead {
  text: string
  nextOffset: number
  lossy: boolean
  spillPath?: string
}

/** Service lookup, narrowed to what a plugin context offers. */
export interface HostCheckServices {
  get(name: string): unknown
}

/**
 * Read cancellation through an opaque call so the compiler does not narrow the
 * result across an `await`. The signal genuinely can become aborted while the
 * approval prompt is open, and a narrowed `false` would hide that.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function hasFunction(value: unknown, name: string): boolean {
  return typeof (value as Record<string, unknown> | undefined)?.[name] === 'function'
}

/**
 * Probe the deployment without changing anything.
 *
 * Read-only by construction: it looks up two services and inspects member
 * types. No spawn, no approval prompt, no ledger write — a capability query
 * that had side effects would make "is this available?" unsafe to ask.
 */
export function hostCheckCapabilities(services: HostCheckServices): HostCheckCapabilities {
  const approval = services.get('approval')
  const subprocess = services.get('subprocess')
  const approvalOk = hasFunction(approval, 'request')
  const subprocessOk = hasFunction(subprocess, 'spawn')
  const capabilities: HostCheckCapabilities = {
    status: approvalOk && subprocessOk ? 'ok' : 'unavailable',
    approval: approvalOk ? { available: true, symbol: 'ctx.approval.request' } : { available: false },
    subprocess: subprocessOk ? { available: true, symbol: 'ctx.subprocess.spawn' } : { available: false },
    runtime: process.versions.node,
  }
  if (!approvalOk && !subprocessOk) {
    return { ...capabilities, reason: 'this deployment composes neither an approval seam nor a subprocess seam' }
  }
  if (!approvalOk) {
    return { ...capabilities, reason: 'no approval seam (ctx.approval) — a run could not be authorised, so none is offered' }
  }
  if (!subprocessOk) {
    return { ...capabilities, reason: 'no subprocess seam (ctx.subprocess) — a check could be authorised but never started' }
  }
  return capabilities
}

/**
 * Turn the host's approval vocabulary into this adapter's.
 *
 * `allowed-once` is the only grant, matching `ApprovalOutcome`. Everything else
 * denies, and the distinction is preserved rather than flattened: "a human said
 * no", "nobody answered", and "the question was withdrawn" call for different
 * next steps, and collapsing them to one `denied` would make the adapter lie
 * about which one happened.
 */
function classifyApproval(outcome: string): HostCheckResult {
  switch (outcome) {
    case 'rejected': return { status: 'denied', reason: 'the user rejected this check', approvalOutcome: outcome }
    case 'cancelled': return { status: 'cancelled', reason: 'the approval request was withdrawn' }
    case 'unavailable': return { status: 'unavailable', reason: 'no approval channel is available in this deployment' }
    // A vocabulary the adapter does not know is not a grant. Fail closed: an
    // unrecognised outcome must never be read optimistically.
    default: return { status: 'unavailable', reason: `unrecognised approval outcome "${outcome}"`, detail: 'refusing to treat an unknown outcome as a grant' }
  }
}

/**
 * Authorise, then run, one check recipe in the foreground.
 *
 * Order is the point: approval first, spawn second. A rejected or unavailable
 * approval must leave no process behind, so the spawn is not attempted until a
 * grant is in hand — there is no "start it and kill it if denied" path.
 *
 * The abort signal is wired to both stages: a cancellation during approval
 * settles as `cancelled`, and one during execution terminates the managed range
 * and settles as `interrupted`. Neither reports `completed`.
 */
export async function runHostCheck(
  services: HostCheckServices,
  request: HostCheckRequest,
  options: { toolName: string; timeoutMs?: number; maxBytes?: number; graceMs?: number },
): Promise<HostCheckResult> {
  const capabilities = hostCheckCapabilities(services)
  if (capabilities.status !== 'ok') return { status: 'unavailable', reason: capabilities.reason ?? 'host verification seams are unavailable' }

  const { agent, callId, signal } = request.raw
  // Without an agent there is no session to audit the question to and no UI to
  // route it to; the host's own `serviceAsk` degrades the same way, and inherits
  // the same reason. Ask here rather than spending a turn on a prompt nobody can
  // answer.
  if (agent === undefined) {
    return { status: 'unavailable', reason: 'this call has no agent, so an approval prompt could not be routed or audited' }
  }
  // The callId is the identity the approval is filed against. Synthesising one
  // would make the audit trail point at a call that never happened.
  if (typeof callId !== 'string' || callId.length === 0) {
    return { status: 'unavailable', reason: 'this call has no registry callId, so the approval could not be attributed to it' }
  }
  // An already-cancelled call is a cancellation, not a throw: the closed
  // vocabulary exists so the caller never has to guess what an exception meant,
  // and `throwIfAborted` here would escape as an SDK failure instead.
  if (isAborted(signal)) return { status: 'cancelled', reason: 'the call was cancelled before approval was requested' }

  const approval = services.get('approval') as ApprovalLike
  let outcome: string
  try {
    outcome = await approval.request({
      agent,
      toolName: options.toolName,
      callId,
      reason: request.reason,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    // A throwing approval seam is not a grant and not a denial we can name.
    return { status: 'unavailable', reason: 'the approval request failed before producing an outcome', detail: errorMessage(error) }
  }
  if (outcome !== 'allowed-once') return classifyApproval(outcome)
  // Cancelled while the prompt was open: the grant arrived but the work no
  // longer matters, so nothing is started.
  if (isAborted(signal)) return { status: 'cancelled', reason: 'the call was cancelled while approval was pending' }
  const invalid = request.beforeSpawn?.()
  if (invalid !== undefined) return { status: 'stale', reason: invalid }

  const subprocess = services.get('subprocess') as SubprocessLike
  const maxBytes = options.maxBytes ?? 256 * 1024
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  let handle
  try {
    handle = subprocess.spawn({
      argv: [request.program, ...request.argv],
      cwd: request.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes, spill: maxBytes * 8 }, stderr: { maxBytes, spill: maxBytes * 8 } },
      graceMs: options.graceMs ?? 5_000,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    return { status: 'unavailable', reason: 'the host refused to start the check process', detail: errorMessage(error) }
  }

  // A deadline the adapter owns: the seam explicitly leaves deadlines to
  // consumers, and a check that hangs must not hold the turn open.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const cancelled = new Promise<'cancelled'>((resolve) => {
    const onAbort = (): void => { resolve('cancelled') }
    deadline.signal.addEventListener('abort', onAbort, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  // The losing branch of the race still settles on its own; swallow that so a
  // provider failure arriving after a cancellation is not an unhandled rejection.
  handle.done.catch(() => undefined)

  let exit: { exitCode: number | null; signal: string | null }
  try {
    const settled = await Promise.race([handle.done, cancelled])
    if (settled === 'cancelled') {
      // Terminate the managed range, then let the provider prove quiescence so a
      // descendant cannot outlive the answer we are about to give.
      try { handle.terminate?.() } catch { /* provider-owned teardown already failed; the report below stands */ }
      try { await handle.waitForExit?.() } catch { /* quiescence unprovable — still not a completion */ }
      const byCaller = isAborted(signal)
      return byCaller
        ? { status: 'interrupted', reason: 'the caller cancelled the check' }
        : { status: 'interrupted', reason: `the check exceeded its ${Math.round(timeoutMs / 1000)}s deadline and was terminated` }
    }
    exit = settled
  } catch (error) {
    return { status: 'interrupted', reason: 'the check process failed before reporting an exit', detail: errorMessage(error) }
  } finally {
    clearTimeout(timer)
  }

  const stdout = readStream(handle.collected?.stdout, maxBytes * 8)
  const stderr = readStream(handle.collected?.stderr, maxBytes * 8)
  const text = [stdout.text, stderr.text].filter(value => value.length > 0).join('\n')
  const streams = { stdout: stdout.ref, stderr: stderr.ref }
  const bytes = stdout.ref.bytes + stderr.ref.bytes
  // Hash both streams with explicit boundaries, so stdout and stderr cannot be
  // interchanged while retaining the same evidence identity.
  const sha256 = createHash('sha256').update(JSON.stringify(streams)).digest('hex')
  const truncated = stdout.ref.truncated || stderr.ref.truncated
  const spillPath = stdout.ref.spillPath ?? stderr.ref.spillPath
  const output: HostOutputRef = spillPath === undefined
    ? { kind: 'digest', sha256, bytes, truncated, streams }
    : { kind: 'spill', path: spillPath, sha256, bytes, truncated, streams }

  return {
    status: 'completed',
    callId,
    exitCode: exit.exitCode,
    signal: exit.signal,
    output,
    text,
    stdout: stdout.text,
    stderr: stderr.text,
  }
}

/** A spill path is a pointer, not a completeness assertion. Only a stable,
 * bounded artifact covering the host's entire byte range can recover loss. */
function readStream(stream: { readFrom(offset: number): CollectedRead } | undefined, maxBytes: number): { text: string; ref: HostStreamRef } {
  let text = '', truncated = true, spillPath: string | undefined, detail: string | undefined
  try {
    const read = stream?.readFrom(0)
    if (!read) detail = 'the host did not expose this output stream'
    else {
      text = read.text
      truncated = read.lossy !== false || !Number.isSafeInteger(read.nextOffset) || read.nextOffset !== Buffer.byteLength(text, 'utf8')
      if (read.spillPath !== undefined) {
        try {
          const raw = readBoundedFile(read.spillPath, maxBytes)
          if (raw.length !== read.nextOffset) throw new Error('spill size does not cover the complete host byte range')
          const recovered = new TextDecoder('utf-8', { fatal: true }).decode(raw)
          if (!truncated && recovered !== text) throw new Error('spill content does not match the collected stream')
          text = recovered
          truncated = false
          spillPath = read.spillPath
        } catch (error) {
          detail = `spill unavailable or incomplete: ${errorMessage(error)}`
        }
      }
    }
  } catch (error) {
    detail = `output stream could not be read: ${errorMessage(error)}`
  }
  return {
    text,
    ref: {
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'), bytes: Buffer.byteLength(text, 'utf8'), truncated,
      ...(spillPath === undefined ? {} : { spillPath }), ...(detail === undefined ? {} : { detail }),
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
