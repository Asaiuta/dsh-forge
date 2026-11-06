/** Pure config read/write helpers used by the settings route. */
import type { ForgeSurface } from './config.ts'

export const FORGE_ROW_ID = 'dsh-forge'
export const CONFIG_PATH = '/forge-config'
const SURFACES = ['retrieval', 'full'] as const

export interface ForgeSettingsState { surface: ForgeSurface; hideBuiltinWrites: boolean }

export class ConfigEditError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigEditError' }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function readSettings(raw: unknown): ForgeSettingsState {
  const surface = record(raw).surface
  return { surface: (SURFACES as readonly unknown[]).includes(surface) ? surface as ForgeSurface : 'retrieval', hideBuiltinWrites: record(raw).hideBuiltinWrites === true }
}

export function nextConfig(current: unknown, body: unknown): Record<string, unknown> {
  const input = record(body)
  const surface = input.surface
  if (!(SURFACES as readonly unknown[]).includes(surface)) {
    throw new ConfigEditError('surface 必须是 retrieval 或 full')
  }
  if (input.hideBuiltinWrites !== undefined && typeof input.hideBuiltinWrites !== 'boolean') throw new ConfigEditError('hideBuiltinWrites 必须是布尔值')
  return { ...record(current), surface, hideBuiltinWrites: input.hideBuiltinWrites ?? readSettings(current).hideBuiltinWrites }
}
