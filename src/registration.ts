/** Select the Forge rows exposed by the configured surface. */
import type { ForgeConfig, ForgeSurface } from './config.ts'

export interface ForgeRow {
  readonly forge: string
  readonly surface: ForgeSurface
  readonly build: () => unknown
}

export function planRegistration(config: ForgeConfig, rows: readonly ForgeRow[]): ForgeRow[] {
  return rows.filter((row) => config.surface === 'full' || row.surface === 'retrieval')
}
