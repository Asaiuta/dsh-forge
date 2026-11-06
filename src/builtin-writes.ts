/** Reversible, per-agent masks over inherited write tools. Public SDK APIs only. */
import path from 'node:path'
import { canonicalTarget } from './fs-paths.ts'
import { workdirOf, type ForgeExec } from './core.ts'
import type { ForgeConfig } from './config.ts'
import type { ForgeFileSystem, ForgePolicyService } from './execution.ts'

type Agent = NonNullable<ForgeExec['agent']>
type Definition = { parameters?: { properties?: Record<string, unknown> } }
interface View {
  visible: Map<string, Definition>
  restrictableNames: Set<string>
  registrations: Map<string, { when?: unknown }>
}
interface Registry {
  view?(scope: unknown): View
  restrict?(filter: { deny: string[] }): () => void
}
export interface BuiltinWritesHost {
  get?(name: string): unknown
  tools: Registry
  on?(event: string, listener: (...args: any[]) => unknown, options?: { global?: boolean; prepend?: boolean }): (() => void) | void
}
const replacements = { edit: 'ff_edit', write: 'ff_file' } as const
type Name = keyof typeof replacements
interface Mask { lift: () => void }
interface Entry { masks: Map<Name, Mask>; reasons: Map<Name, string> }

/** Diagnostics share masking readiness; never create an index or write files. */
function providerReason(agent: Agent): string | undefined {
  if (!agent.ctx) return 'agent services unavailable'
  const fs = agent.ctx.get('fs') as ForgeFileSystem | undefined
  if (!fs || !['resolve', 'processPath', 'processPathFromHostPath', 'stat'].every(key => typeof fs[key as keyof ForgeFileSystem] === 'function')) return 'shared-local filesystem unavailable'
  const cwd = path.resolve(workdirOf({ agent }))
  const mapped = fs.processPathFromHostPath(cwd)
  if (!mapped || canonicalTarget(path.resolve(mapped)) !== canonicalTarget(cwd)) return 'filesystem is not shared-local'
  if (fs.sandboxMode !== undefined) {
    const policy = agent.ctx.get('sandboxPolicy') as ForgePolicyService | undefined
    if (!policy || !fs.checkedTarget || !fs.withLock) return 'sandbox mutation fence unavailable'
    // Forge honors the standing policy but does not yet request per-call grants.
    // Keep the host entry in confined sessions, so its approval path remains reachable.
    if (policy.resolve({ session: agent.session }).mode !== 'danger-full-access') return 'built-in sandbox escalation retained'
  }
  return undefined
}

export function installBuiltinWrites(host: BuiltinWritesHost, config: ForgeConfig, owned: ReadonlyMap<string, unknown>) {
  const entries = new Map<Agent, Entry>()
  const listeners: Array<() => void> = []
  let stopped = false, reconciling = false
  const enabled = config.hideBuiltinWrites && config.surface === 'full'
  const release = (entry: Entry, name: Name) => {
    const mask = entry.masks.get(name)
    if (mask) { mask.lift(); entry.masks.delete(name) }
  }
  const reconcile = (agent: Agent) => {
    if (!enabled || stopped || reconciling || !agent?.ctx) return
    reconciling = true
    const entry = entries.get(agent) ?? { masks: new Map<Name, Mask>(), reasons: new Map<Name, string>() }
    entries.set(agent, entry)
    try {
      const scoped = agent.ctx.get('tools') as Registry | undefined
      let common: string | undefined
      try { common = providerReason(agent) } catch { common = 'filesystem readiness unavailable' }
      for (const name of Object.keys(replacements) as Name[]) {
        let reason = common
        try {
          const view = host.tools.view?.(agent)
          const replacement = replacements[name]
          if (!view || !scoped?.restrict) reason = 'scoped restriction API unavailable'
          else if (!owned.has(replacement) || view.visible.get(replacement) !== owned.get(replacement)
            || view.registrations.get(replacement)?.when !== undefined) reason = `${replacement} unavailable or conditional`
          else if (!view.restrictableNames.has(name)) reason = view.visible.has(name) ? 'own-scope tool cannot be hidden' : 'built-in absent'
          if (reason) { release(entry, name); entry.reasons.set(name, reason); continue }
          // A visible shadow means the existing mask no longer hides this name.
          if (entry.masks.has(name) && !view!.visible.has(name)) { entry.reasons.set(name, 'hidden'); continue }
          release(entry, name)
          if (!host.tools.view!(agent).visible.has(name)) { entry.reasons.set(name, 'already hidden by another plugin'); continue }
          const lift = scoped!.restrict!({ deny: [name] })
          entry.masks.set(name, { lift })
          if (host.tools.view!(agent).visible.has(name)) {
            release(entry, name)
            entry.reasons.set(name, 'own-scope tool cannot be hidden')
          } else entry.reasons.set(name, 'hidden')
        } catch (error) {
          release(entry, name)
          entry.reasons.set(name, `restriction unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally { reconciling = false }
  }
  const reconcileAll = () => {
    const agents = host.get?.('agents') as { list?(): Agent[] } | undefined
    for (const agent of new Set([...(agents?.list?.() ?? []), ...entries.keys()])) reconcile(agent)
  }
  if (enabled && host.on) {
    // Scoped tools/change does not reach ordinary host-plane listeners. This
    // observer runs synchronously, including before a step collects schemas.
    const off = host.on('internal/dispatch', (_type: unknown, event: string, args: any[]) => {
      if (stopped || reconciling) return
      if (event === 'agent/disposed') {
        const agent = args[0]?.agent as Agent, entry = entries.get(agent)
        if (entry) {
          entries.delete(agent)
          reconciling = true
          try { for (const name of [...entry.masks.keys()]) release(entry, name) } finally { reconciling = false }
        }
      } else if (event === 'agent/created' || event === 'agent/status' || event === 'agent/inbox/claimed') {
        const agent = args[0]?.agent as Agent | undefined
        if (agent) reconcile(agent)
      } else if (event === 'tools/change' || event === 'session/event') reconcileAll()
    }, { global: true, prepend: true })
    if (typeof off === 'function') listeners.push(off)
    reconcileAll()
  }
  return {
    status(agent?: Agent): string {
      if (!config.hideBuiltinWrites) return '内置写工具隐藏：关闭'
      if (config.surface !== 'full') return '内置写工具隐藏：仅 full 工具面启用'
      if (!host.on) return '内置写工具隐藏：宿主缺少生命周期事件，保留内置工具'
      if (agent) reconcile(agent)
      const entry = agent && entries.get(agent)
      if (!entry) return '内置写工具隐藏：等待代理作用域'
      return `内置写工具隐藏：${(Object.keys(replacements) as Name[]).map(name => `${name}: ${entry.reasons.get(name) ?? 'retained'}`).join('；')}`
    },
    dispose() {
      stopped = true
      for (const off of listeners.splice(0)) off()
      for (const entry of entries.values()) for (const name of [...entry.masks.keys()]) release(entry, name)
      entries.clear()
    },
  }
}
