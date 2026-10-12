/** Shared-local provider adapter: policy checks precede byte transactions. */
import path from 'node:path'
import { canonicalTarget } from './projects.ts'
import { workdirOf, type ForgeExec } from './core.ts'

interface FsTarget { targetKey: unknown; displayPath: string }
export interface ForgeSandboxPolicy { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }
export interface ForgePolicyService {
  resolve(request: { session?: NonNullable<ForgeExec['agent']>['session'] }): ForgeSandboxPolicy
}
export interface ForgeFileSystem {
  sandboxMode?: unknown
  resolve(file: string, options: { cwd: string; signal?: AbortSignal }): Promise<FsTarget>
  processPath(target: FsTarget): string
  processPathFromHostPath(file: string): string | undefined
  stat?(target: FsTarget, signal?: AbortSignal): Promise<{ version: unknown; type: string; size: number } | undefined>
  /** DSH SandboxedFileSystem's canonical per-call mutation fence. */
  checkedTarget?(target: FsTarget, policy: ForgeSandboxPolicy): Promise<FsTarget>
  withLock?<T>(targetKey: unknown, operation: () => Promise<T> | T): Promise<T>
}
export interface ForgeFsEvents {
  waterfall?(event: 'fs/write-intent', target: FsTarget, actor: unknown, next: () => undefined): Promise<unknown>
  emit?(event: 'fs/observed', target: FsTarget, observation: unknown, actor: unknown): unknown
}
export function createExecutionGuard(provider: ForgeFileSystem | undefined, events: ForgeFsEvents = {}, policyService?: ForgePolicyService) {
  return async (exec: ForgeExec | undefined, args: Record<string, unknown>, tool: string): Promise<ForgeExec> => {
    exec?.signal?.throwIfAborted()
    if (!provider) throw new Error('forge host requires the DSH filesystem service')
    if (typeof provider.resolve !== 'function' || typeof provider.processPath !== 'function' || typeof provider.processPathFromHostPath !== 'function') {
      throw new Error('forge requires a shared-local DSH filesystem provider with native path mapping')
    }
    const cwd = path.resolve(workdirOf(exec))
    const policy = provider.sandboxMode === undefined ? undefined : policyService?.resolve({ session: exec?.agent?.session })
    const authorizeNativePaths = async (files: readonly string[]) => {
      for (const file of files) {
        exec?.signal?.throwIfAborted()
        const absolute = path.resolve(file)
        const mapped = provider.processPathFromHostPath(absolute)
        const target = await provider.resolve(absolute, { cwd, signal: exec?.signal })
        if (!mapped || canonicalTarget(path.resolve(mapped)) !== canonicalTarget(absolute)
          || canonicalTarget(path.resolve(provider.processPath(target))) !== canonicalTarget(absolute)) {
          throw new Error('forge native target is not shared with this DSH execution world; use provider-backed DSH file tools')
        }
      }
    }
    await authorizeNativePaths([cwd])
    for (const key of ['path', 'destination', 'root']) {
      if (typeof args[key] !== 'string' || !String(args[key]).trim()) continue
      const raw = tool === 'ff_read' && key === 'path' ? String(args[key]).split('#')[0] : String(args[key])
      // A glob queries its static directory prefix; never feed wildcards to fs.
      const wildcard = raw.search(/[?*{[]/)
      const prefix = wildcard < 0 ? raw : raw.slice(0, wildcard).replace(/[^\\/]*$/, '') || '.'
      await authorizeNativePaths([path.resolve(cwd, prefix)])
    }
    const prepareNativeWrite = async (files: readonly string[]) => {
      await authorizeNativePaths(files)
      for (const file of [...new Set(files)]) {
        exec?.signal?.throwIfAborted()
        const target = await provider.resolve(file, { cwd, signal: exec?.signal })
        if (provider.sandboxMode !== undefined) {
          if (!policy || !provider.checkedTarget) throw new Error('forge requires the DSH sandbox policy and canonical mutation fence for this provider')
          const checked = await provider.checkedTarget(target, policy)
          if (canonicalTarget(provider.processPath(checked)) !== canonicalTarget(file)) throw new Error('DSH sandbox target changed while preparing the write')
        }
        if (!events.waterfall) continue
        if (!provider.stat) throw new Error('DSH write-intent requires provider.stat')
        const intent = await events.waterfall('fs/write-intent', target, exec, () => undefined)
        if (intent === undefined) continue
        const state = await provider.stat(target, exec?.signal)
        const guard = intent as { kind?: string; version?: unknown }
        if (guard.kind === 'createIfAbsent' ? state !== undefined : guard.kind === 'replaceIfVersion' ? !state || state.version !== guard.version : true) {
          throw new Error(`DSH write-intent refused ${file}; read the current file through DSH/forge before editing`)
        }
      }
    }
    const withNativeWrite = async <T>(files: readonly string[], operation: () => Promise<T> | T): Promise<T> => {
      await authorizeNativePaths(files)
      if (provider.sandboxMode !== undefined && !provider.withLock) throw new Error('forge requires the DSH shared-local provider transaction lock')
      const targets = await Promise.all(files.map(file => provider.resolve(file, { cwd, signal: exec?.signal })))
      const keys = [...new Set(targets.map(target => target.targetKey))].sort((a, b) => String(a).localeCompare(String(b)))
      const lock = async (index: number): Promise<T> => {
        if (index < keys.length && provider.withLock) return provider.withLock(keys[index], () => lock(index + 1))
        const current = await Promise.all(files.map(file => provider.resolve(file, { cwd, signal: exec?.signal })))
        if (current.some((target, i) => target.targetKey !== targets[i].targetKey)) throw new Error('native target changed while waiting for the DSH provider lock')
        await prepareNativeWrite(files)
        exec?.signal?.throwIfAborted()
        return operation()
      }
      return lock(0)
    }
    const beginNativeRead = async (file: string) => {
      await authorizeNativePaths([file])
      const target = await provider.resolve(file, { cwd, signal: exec?.signal })
      const before = await provider.stat?.(target, exec?.signal)
      const finish = async () => {
        exec?.signal?.throwIfAborted()
        if (!provider.stat || !events.emit) return
        const current = await provider.resolve(file, { cwd, signal: exec?.signal })
        if (current.targetKey !== target.targetKey) return
        const after = await provider.stat(current, exec?.signal)
        if (before && after && before.version === after.version) events.emit!('fs/observed', target, { kind: 'present', version: after.version }, exec)
        else if (!before && !after) events.emit('fs/observed', target, { kind: 'absent' }, exec)
      }
      // Read this resolved path, rather than an alias which can retarget and
      // return before the finish check (ABA). DSH's readText uses it too.
      return { path: provider.processPath(target), finish }
    }
    return { ...exec, authorizeNativePaths, prepareNativeWrite, withNativeWrite, beginNativeRead }
  }
}
