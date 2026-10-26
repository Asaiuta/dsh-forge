/** Bounded persistent AST workers shared by symbol searches and Trace extraction. */
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import type { TraceFileOutcome } from './trace-facts.ts'

interface Hit { qualifiedName: string; kind: string; startLine: number; endLine: number; occurrence: number; commentStartLine?: number; signature: string }
interface WorkerResult { index: number; file: string; parsed: boolean; items: Hit[] }
interface TraceResult extends TraceFileOutcome { index: number }
interface WorkFile { file: string; index: number }
interface Reply { id: number; results?: WorkerResult[]; traceResults?: TraceResult[]; timedOut?: boolean; cancelled?: boolean; error?: string }
interface Slot { worker: Worker; pending: Map<number, { resolve(reply: Reply): void; reject(cause: Error): void; cleanup(): void }> }
/** True when DSH_FORGE_AST_WORKERS is unset/empty — parallelism is then the
 *  default and is gated only by corpus size, not by an explicit 0. */
export function astWorkerAuto(): boolean {
  const raw = process.env.DSH_FORGE_AST_WORKERS
  return raw === undefined || raw.trim() === ''
}

/** Effective worker count: auto (min of core count and 8) by default, or the
 *  explicit 0..8 value. 0 means sequential. */
export function astWorkerCount(): number {
  const raw = process.env.DSH_FORGE_AST_WORKERS
  if (raw === undefined || raw.trim() === '') return Math.min(availableParallelism(), 8)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 8) throw new Error('DSH_FORGE_AST_WORKERS must be an integer from 0 to 8')
  return Math.min(value, availableParallelism())
}
export class AstWorkerPool {
  private readonly slots: Slot[] = []
  private nextId = 1
  private closed = false
  private getSlot(index: number): Slot {
    const slots = this.slots
    if (slots[index]) return slots[index]
    const worker = new Worker(new URL('./ast-worker.js', import.meta.url), { execArgv: [] })
    const slot: Slot = { worker, pending: new Map() }
    slots[index] = slot
    const failed = (cause: Error) => {
      if (slots[index] === slot) delete slots[index]
      for (const pending of slot.pending.values()) { pending.cleanup(); pending.reject(cause) }
      slot.pending.clear()
    }
    worker.on('message', (reply: Reply) => {
      const pending = slot.pending.get(reply.id)
      if (!pending) return
      slot.pending.delete(reply.id); pending.cleanup()
      if (!slot.pending.size) worker.unref()
      if (reply.error) pending.reject(new Error(reply.error))
      else pending.resolve(reply)
    })
    worker.on('error', failed)
    worker.on('exit', code => failed(new Error(`AST worker exited (${code})`)))
    worker.unref()
    return slot
  }
  async find(files: string[], name: string, kinds: string[] | null, deadline: number, signal?: AbortSignal): Promise<{ results: WorkerResult[]; timedOut: boolean }> {
    if (this.closed) throw new Error('AST worker pool was disposed')
    signal?.throwIfAborted()
    const count = astWorkerCount()
    if (count === 0) throw new Error('parallel AST is disabled')
    const groups: Array<Array<{ file: string; index: number }>> = Array.from({ length: count }, () => [])
    files.forEach((file, index) => {
      let hash = 0
      for (const char of file) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
      groups[hash % count].push({ file, index })
    })
    const replies = await this.run(groups, { name, kinds, deadline }, signal)
    return { results: replies.flatMap(reply => reply.results ?? []).sort((a, b) => a.index - b.index), timedOut: replies.some(reply => reply.timedOut) }
  }
  async facts(files: Array<{ file: string; bytes: number }>, signal?: AbortSignal): Promise<TraceFileOutcome[]> {
    const count = Math.min(astWorkerCount(), files.length)
    if (count === 0) throw new Error('parallel AST is disabled')
    const groups: WorkFile[][] = Array.from({ length: count }, () => [])
    const loads = Array<number>(count).fill(0)
    // Large bundles dominate extraction. Balance by bytes instead of leaving
    // several large files on one worker through a path hash.
    files.map((item, index) => ({ ...item, index })).sort((a, b) => b.bytes - a.bytes).forEach(item => {
      const slot = loads.indexOf(Math.min(...loads))
      loads[slot] += Math.max(item.bytes, 1024)
      groups[slot].push({ file: item.file, index: item.index })
    })
    const replies = await this.run(groups, { kind: 'trace', deadline: Date.now() + 5 * 60_000 }, signal)
    const results = replies.flatMap(reply => reply.traceResults ?? []).sort((a, b) => a.index - b.index)
    if (replies.some(reply => reply.timedOut) || results.length !== files.length) throw new Error('Trace worker scan did not complete')
    return results.map(({ index: _index, ...outcome }) => outcome)
  }
  private async run(groups: WorkFile[][], payload: { kind?: 'trace'; name?: string; kinds?: string[] | null; deadline: number }, signal?: AbortSignal): Promise<Reply[]> {
    if (this.closed) throw new Error('AST worker pool was disposed')
    signal?.throwIfAborted()
    const groupController = new AbortController()
    const combined = signal ? AbortSignal.any([signal, groupController.signal]) : groupController.signal
    const replies = await Promise.allSettled(groups.map((group, index) => {
      if (!group.length) return Promise.resolve({ id: 0, results: [], timedOut: false })
      const slot = this.getSlot(index), id = this.nextId++
      return new Promise<Reply>((resolve, reject) => {
        const cancellation = new Int32Array(new SharedArrayBuffer(4))
        let settled = false
        let aborted: Error | undefined
        const abort = () => {
          aborted = combined.reason instanceof Error ? combined.reason : new Error('AST query aborted')
          Atomics.store(cancellation, 0, 1)
          // Wait for the worker acknowledgement: cancellation owns no background work.
        }
        const timeout = () => {
          aborted = new Error('AST worker request timed out')
          Atomics.store(cancellation, 0, 1)
          // A file parse is synchronous inside the worker. Termination is the
          // hard bound only when no unrelated request shares the slot. Otherwise
          // await acknowledgement so an expired queued call cannot kill its peer.
          if (slot.pending.size === 1) {
            if (this.slots[index] === slot) delete this.slots[index]
            void slot.worker.terminate()
          }
        }
        const timer = setTimeout(timeout, Math.max(1, payload.deadline - Date.now() + 1000))
        const cleanup = () => { clearTimeout(timer); combined.removeEventListener('abort', abort) }
        slot.pending.set(id, {
          resolve: reply => { if (!settled) { settled = true; cleanup(); if (aborted || reply.cancelled) reject(aborted ?? new Error('AST query cancelled')); else resolve(reply) } },
          reject: cause => { if (!settled) { settled = true; cleanup(); reject(aborted ?? cause) } },
          cleanup,
        })
        combined.addEventListener('abort', abort, { once: true })
        if (combined.aborted) abort()
        slot.worker.ref()
        slot.worker.postMessage({ id, files: group, ...payload, cancellation })
      }).catch(cause => { groupController.abort(cause); throw cause })
    }))
    signal?.throwIfAborted()
    const failed = replies.find(reply => reply.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    return replies.map(reply => (reply as PromiseFulfilledResult<Reply>).value)
  }
  async dispose(): Promise<void> {
    this.closed = true
    const live = this.slots.splice(0).filter(Boolean)
    await Promise.all(live.map(slot => slot.worker.terminate()))
  }
}
let defaultPool = new AstWorkerPool()
export const parallelFind = (files: string[], name: string, kinds: string[] | null, deadline: number, signal?: AbortSignal) => defaultPool.find(files, name, kinds, deadline, signal)
export const parallelTrace = (files: Array<{ file: string; bytes: number }>, signal?: AbortSignal) => defaultPool.facts(files, signal)
export async function disposeAstWorkers(): Promise<void> {
  const previous = defaultPool
  defaultPool = new AstWorkerPool()
  await previous.dispose()
}
