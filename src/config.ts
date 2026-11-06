/** The small configuration surface for dsh-forge. */
import z from '@deepseek-ai/schemastery'

export type ForgeSurface = 'retrieval' | 'full'

export interface ForgeConfig {
  surface: ForgeSurface
  /** Opt-in; only hide when the agent's replacement and provider are ready. */
  hideBuiltinWrites: boolean
}

export const Config: ReturnType<typeof z.object> = z.object({
  surface: z.union(['retrieval', 'full']).default('retrieval'),
  hideBuiltinWrites: z.boolean().default(false),
})

export function resolveConfig(raw?: unknown): ForgeConfig {
  if (raw === undefined || raw === null) return { surface: 'retrieval', hideBuiltinWrites: false }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('dsh-forge: config must be a mapping')
  const value = (raw as { surface?: unknown }).surface
  const hideBuiltinWrites = (raw as { hideBuiltinWrites?: unknown }).hideBuiltinWrites ?? false
  if (typeof hideBuiltinWrites !== 'boolean') throw new TypeError('dsh-forge: config.hideBuiltinWrites must be boolean')
  if (value === undefined || value === null || value === '') return { surface: 'retrieval', hideBuiltinWrites }
  if (value !== 'retrieval' && value !== 'full') {
    throw new TypeError(`dsh-forge: config.surface must be "retrieval" or "full" — got: ${JSON.stringify(value)}`)
  }
  return { surface: value, hideBuiltinWrites }
}
