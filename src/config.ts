/** The small configuration surface for dsh-forge. */
import z from '@deepseek-ai/schemastery'

export type ForgeSurface = 'retrieval' | 'full'

export interface ForgeConfig {
  surface: ForgeSurface
}

export const Config: ReturnType<typeof z.object> = z.object({
  surface: z.union(['retrieval', 'full']).default('retrieval'),
})

export function resolveConfig(raw?: unknown): ForgeConfig {
  if (raw === undefined || raw === null) return { surface: 'retrieval' }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('dsh-forge: config must be a mapping')
  const value = (raw as { surface?: unknown }).surface
  if (value === undefined || value === null || value === '') return { surface: 'retrieval' }
  if (value !== 'retrieval' && value !== 'full') {
    throw new TypeError(`dsh-forge: config.surface must be "retrieval" or "full" — got: ${JSON.stringify(value)}`)
  }
  return { surface: value }
}
