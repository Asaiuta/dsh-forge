/** Bounded persistent worker prototype. Content is still read/hashed on every query. */
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'

interface Hit { qualifiedName: string; kind: string; startLine: number; endLine: number; occurrence: number; commentStartLine?: number; signature: string }
interface WorkerResult { index: number; file: string; parsed: boolean; items: Hit[] }
interface Reply { id: number; results?: WorkerResult[]; timedOut?: boolean; cancelled?: boolean; error?: string }
interface Slot { worker: Worker; pending: Map<number, { resolve(reply: Reply): void; reject(cause: Error): void; cleanup(): void }> }
export function astWorkerCount(): number {
  const value = Number(process.env.DSH_FORGE_AST_WORKERS ?? 0)
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
    const replies = await Promise.all(groups.map((group, index) => {
      if (!group.length) return Promise.resolve({ id: 0, results: [], timedOut: false })
      const slot = this.getSlot(index), id = this.nextId++
      return new Promise<Reply>((resolve, reject) => {
        const cancellation = new Int32Array(new SharedArrayBuffer(4))
        let settled = false
        const finish = (cause?: Error) => {
          if (settled) return
          settled = true
          Atomics.store(cancellation, 0, 1)
          slot.pending.delete(id)
          cleanup()
          if (!slot.pending.size) slot.worker.unref()
          if (cause) reject(cause)
        }
        let aborted: Error | undefined
        const abort = () => {
          aborted = signal?.reason instanceof Error ? signal.reason : new Error('AST query aborted')
          Atomics.store(cancellation, 0, 1)
          // Wait for the worker acknowledgement: cancellation owns no background work.
        }
        const timeout = () => finish(new Error('AST worker request timed out'))
        const timer = setTimeout(timeout, Math.max(1, deadline - Date.now() + 1000))
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
        slot.pending.set(id, {
          resolve: reply => { if (!settled) { settled = true; cleanup(); if (aborted || reply.cancelled) reject(aborted ?? new Error('AST query cancelled')); else resolve(reply) } },
          reject: cause => { if (!settled) { settled = true; cleanup(); reject(cause) } },
          cleanup,
        })
        signal?.addEventListener('abort', abort, { once: true })
        slot.worker.ref()
        slot.worker.postMessage({ id, files: group, name, kinds, deadline, cancellation })
      })
    }))
    signal?.throwIfAborted()
    return { results: replies.flatMap(reply => reply.results ?? []).sort((a, b) => a.index - b.index), timedOut: replies.some(reply => reply.timedOut) }
  }
  async dispose(): Promise<void> {
    this.closed = true
    const live = this.slots.splice(0).filter(Boolean)
    await Promise.all(live.map(slot => slot.worker.terminate()))
  }
}
let defaultPool = new AstWorkerPool()
export const parallelFind = (files: string[], name: string, kinds: string[] | null, deadline: number, signal?: AbortSignal) => defaultPool.find(files, name, kinds, deadline, signal)
export async function disposeAstWorkers(): Promise<void> {
  const previous = defaultPool
  defaultPool = new AstWorkerPool()
  await previous.dispose()
}
