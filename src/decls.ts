/** Optional data-only IPC declarations. Trace never executes workspace code. */
import path from 'node:path'
import { readBoundedFile } from './fs-paths.ts'

export interface PreloadApi {
  name: string
  channel: string | null
  kind: string
  roles: string[]
  domain?: string
}
export interface PreloadDecls {
  status: 'ok' | 'absent' | 'failed'
  apis: PreloadApi[]
  roleGlobals: Record<string, string> | null
  error?: string
}
/** Role names belong to the analyzed application; DSH supplies no VCPChat defaults. */
export const DEFAULT_ROLE_GLOBALS: Readonly<Record<string, string>> = Object.freeze({})
export const COMPAT_GLOBAL = 'electronAPI'

export function bridgeGlobalsOf(decls: PreloadDecls): string[] {
  return [...new Set([...Object.values(decls.roleGlobals ?? DEFAULT_ROLE_GLOBALS), COMPAT_GLOBAL])]
}

export async function loadPreloadDecls(root: string, file?: string, signal?: AbortSignal): Promise<PreloadDecls> {
  signal?.throwIfAborted()
  if (!file) return { status: 'absent', apis: [], roleGlobals: null }
  try {
    const data = JSON.parse(readBoundedFile(path.resolve(root, file), 256 * 1024).toString('utf8'))
    if (!data || typeof data !== 'object' || !Array.isArray(data.apis)
      || data.apis.some((api: unknown) => {
        if (!api || typeof api !== 'object') return true
        const value = api as Record<string, unknown>
        return typeof value.name !== 'string' || !value.name || !(value.channel === null || typeof value.channel === 'string')
          || !['query', 'command', 'subscription'].includes(String(value.kind))
          || !Array.isArray(value.roles) || value.roles.some(role => typeof role !== 'string')
          || value.domain !== undefined && typeof value.domain !== 'string'
      })
      || data.roleGlobals !== undefined && data.roleGlobals !== null && (typeof data.roleGlobals !== 'object'
        || Array.isArray(data.roleGlobals) || Object.values(data.roleGlobals).some(value => typeof value !== 'string'))) {
      throw new Error('expected { apis: [{ name, channel, kind, roles }], roleGlobals?: { role: global } }')
    }
    signal?.throwIfAborted()
    return { status: 'ok', apis: data.apis, roleGlobals: data.roleGlobals ?? null }
  } catch (cause) {
    signal?.throwIfAborted()
    return { status: 'failed', apis: [], roleGlobals: null, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
