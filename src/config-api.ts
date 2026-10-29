/**
 * The three settings the configuration page owns, as pure functions.
 *
 * The page does not use `SettingsFormModel`. Two reasons, both structural:
 *
 *  1. That model is built on `dsh-settings`' volatile form — a namespace is only
 *     published for an entry whose schema has a volatile field, and a write to
 *     any other path is rejected. Marking `registration` volatile would be
 *     actively wrong: a volatile-only change is committed into the running fiber
 *     instead of remounting it, and this plugin decides its whole tool surface
 *     inside `apply()` (`planRegistration`). The tool surface would keep the old
 *     names while the page showed the new ones.
 *  2. Its field specs are `{ format, parse }` over a *string* — there is no enum,
 *     boolean or list control. Every one of these three settings is one of those
 *     shapes.
 *
 * So the page talks to `configEditor.edit()` instead (`./http-plugin.ts`), which
 * persists to the profile patch and lets the Loader run the row's normal
 * lifecycle. Saving `registration` therefore really does re-register the tool
 * surface. This module is the part of that path worth testing without a host:
 * what a saved body means, and what the written raw config looks like.
 *
 * Why not reuse {@link resolveConfig} from `./config.ts`: that function throws
 * for a *loader* diagnostic and expands an empty `takeover` list into all three
 * names. Expansion is right for `apply()` and wrong here — the page has to show
 * exactly what the user picked, or the first save would silently turn "none
 * selected" into "all selected".
 *
 * @module dsh-forge/config-api
 */

import { TAKE_OVER_CAPABLE, type RegistrationMode, type TakeOverName } from './config.ts'

/** The profile row this page configures (also the file's own bundle row id). */
export const FORGE_ROW_ID = 'dsh-forge'

/** Exact route the page reads and writes. */
export const CONFIG_PATH = '/forge-config'

/** Every native name the takeover control offers, in display order. */
export const CAPABILITY: readonly TakeOverName[] = TAKE_OVER_CAPABLE

const MODES: readonly RegistrationMode[] = ['additive', 'takeover']

/** What the page renders: the row's own values, already defaulted. */
export interface ForgeSettingsState {
  registration: RegistrationMode
  takeover: TakeOverName[]
  prewarm: boolean
}

/**
 * A rejected edit, with the sentence the page shows.
 *
 * Messages are Chinese because the only consumer is the settings page; the
 * engineering-facing diagnostics in `./config.ts` stay English for the loader
 * log.
 */
export class ConfigEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigEditError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the row's own values, applying the same defaults `apply()` would.
 *
 * Deliberately lenient: a row edited by hand can hold anything, and the page has
 * to stay readable so the user can repair it. A missing or malformed field falls
 * back to its default instead of failing the whole read.
 *
 * @param raw - `entry.options.config`, or `undefined` for a row with no config.
 * @returns the three settings as the page should show them.
 */
export function readSettings(raw: unknown): ForgeSettingsState {
  const config = isRecord(raw) ? raw : {}

  const mode = String(config.registration ?? '').trim()
  const registration: RegistrationMode = (MODES as readonly string[]).includes(mode)
    ? (mode as RegistrationMode)
    : 'additive'

  const listed = Array.isArray(config.takeover) ? config.takeover : []
  const takeover = [...new Set(
    listed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => (CAPABILITY as readonly string[]).includes(entry)),
  )] as TakeOverName[]

  return { registration, takeover, prewarm: config.prewarm !== false }
}

/**
 * Validate one saved body and produce the row's next raw config.
 *
 * `current` is copied, not mutated, and every key this page does not own
 * (`cards`, including its endpoint credentials) is carried through untouched —
 * `configEditor.edit()` replaces the whole `config` node in the profile patch, so
 * dropping a key here would delete it from the user's file.
 *
 * @param current - the row's current raw config.
 * @param body - the page's `{ registration, takeover, prewarm }`.
 * @returns the raw config to persist.
 * @throws {ConfigEditError} when a value is outside what the schema accepts.
 */
export function nextConfig(current: unknown, body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ConfigEditError('请求体必须是一个对象')
  const config = isRecord(current) ? current : {}

  const mode = String(body.registration ?? '').trim()
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new ConfigEditError('接管方式只能是「并存」或「接管」')
  }
  const registration = mode as RegistrationMode

  const listed = body.takeover
  if (!Array.isArray(listed)) throw new ConfigEditError('接管范围必须是一个列表')

  const takeover: TakeOverName[] = []
  for (const entry of listed) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigEditError('接管范围里有空项')
    }
    const name = entry.trim()
    if (!(CAPABILITY as readonly string[]).includes(name)) {
      throw new ConfigEditError(`forge 无法按原样接管「${name}」`)
    }
    if (takeover.includes(name as TakeOverName)) {
      throw new ConfigEditError(`接管范围里「${name}」重复了`)
    }
    takeover.push(name as TakeOverName)
  }

  // An empty list in takeover mode means "everything forge can serve"
  // (`config.ts`: `resolved`), which is the *opposite* of the empty selection the
  // user just made. Refusing is the only answer that does not lie.
  if (registration === 'takeover' && takeover.length === 0) {
    throw new ConfigEditError('接管模式下至少要选一个工具')
  }

  if (body.prewarm !== undefined && typeof body.prewarm !== 'boolean') {
    throw new ConfigEditError('启动预热只能是开或关')
  }
  const prewarm = body.prewarm === undefined ? config.prewarm !== false : body.prewarm

  return { ...config, registration, takeover, prewarm }
}
