/**
 * The plugin's own settings surface.
 *
 * Two things live here and nowhere else, because a tunable read anywhere but
 * `apply(ctx, config)` drifts from what the user wrote in `cordis.patch.yml`:
 *
 *   registration  'additive' (default) — forge's tools register globally
 *                 under their own `ff*` names, next to the built-in
 *                 `read`/`grep`/`glob`/`edit`. Nothing existing changes.
 *
 *                 'takeover' — a listed tool registers **once**, into each live
 *                 agent's scope, under the built-in name it replaces (`read`),
 *                 so the model sees one tool for that job instead of two. Every
 *                 other forge tool stays additive. What the built-in answers
 *                 when the index cannot is delegated back to it per call
 *                 (`./delegate.ts`).
 *
 *   takeover      which native names to take over. Only names forge can serve
 *                 in the *native shape* are accepted — see
 *                 {@link TAKE_OVER_CAPABLE}. A name that would silently change
 *                 the contract (`edit`) is rejected at activation rather than
 *                 served wrong.
 *
 * Why a config field and not a build variant: the user's patch layer survives
 * plugin upgrades — `practices.md`: "Put tunable values in the plugin's
 * `Config` so users change them in `cordis.patch.yml`" — so the switch costs
 * one line to flip and survives the next release. The schema is exported (not
 * just read in `apply`) so `Config.listConfigs` can project it and Plugin
 * Manager can show the row; `schemastery` validates it before activation, which
 * is what turns a typo into an error next to the plugin row instead of a
 * silently ignored setting.
 *
 * @module dsh-forge/config
 */

import z from '@deepseek-ai/schemastery'

/** How forge's tool surface is layered onto the host's. */
export type RegistrationMode = 'additive' | 'takeover'

/**
 * Native names forge can serve without changing their argument contract.
 *
 * `read` qualifies because {@link normalizeNativeReadArgs} accepts the built-in
 * `file_path`/`offset`/`limit` triple *and* forge's own `path`/`lines`, so a
 * model that learned the built-in contract keeps working — and the built-in
 * `TOOL_READ` prompt section, which stays visible whenever a tool called `read`
 * exists, keeps describing the truth.
 *
 * `glob` qualifies because the built-in takes exactly `{pattern, path}` and
 * answers with a path list — no mode, no page, no limit:
 *
 *   built-in  glob(pattern, path)          ripgrep `--files`, --no-ignore --hidden
 *   forge     glob(pattern, path)          the workspace index, .gitignore-aware
 *
 * The residual difference is *scope*, not syntax, and it is stated in the tool
 * description: the index does not hold .gitignore'd paths or `node_modules`,
 * while the built-in walks the disk and does. Both are legitimate answers to
 * "what files match", which is why this is a takeover rather than a rename: the
 * caller is told which one it is getting.
 *
 * `grep` qualifies since {@link createNativeDelegate} exists. Its own contract —
 * `pattern` is a ripgrep regular expression, matched case-**sensitively** — is
 * expressible in the engine (`mode: 'regex'`, `smartCase: false`), and every
 * remaining place where the index would answer differently from the disk is
 * handed back to the built-in at call time: a scan still running, a finder that
 * cannot start, and **a page with no match at all** (the index is a snapshot, so
 * "0 matches" from it is probable, not certain). The note names which one
 * answered, so the caller is never left inferring it.
 *
 * `edit` stays out, and no delegation can fix that. The built-in requires
 * `old_string` to be unique unless `replace_all`; ffedit's anchored engine
 * resolves an ambiguous match by rule. Handing the call back would not help —
 * by the time the ambiguity exists the built-in has nothing to offer except an
 * error, and an error the model did not ask for is a worse answer than the
 * refusal it can act on. So `edit` keeps its own name and its own semantics.
 */
export const TAKE_OVER_CAPABLE = ['read', 'glob', 'grep'] as const

export type TakeOverName = (typeof TAKE_OVER_CAPABLE)[number]

/** Resolved settings: every field present, every value already validated. */
export interface ForgeConfig {
  registration: RegistrationMode
  takeover: readonly TakeOverName[]
  /**
   * Build the workspace index in the background when an agent appears, instead
   * of on the first tool call.
   *
   * On by default because the lazy path costs the *first real query* everything
   * — measured 2.9 s cold and ~2.0 s on a second session even with the index
   * already on disk — while the same work done in the background makes the first
   * query 4 ms. It is not free: the native scan blocks the JS thread for up to
   * ~0.5 s once (measured p99 531 ms on a 5k-file tree), which is why it runs
   * delayed and unawaited. Turn it off in a profile that exists for chat only, or
   * where a session-start IO burst is unwanted.
   */
  prewarm: boolean
  /** Knowledge-card distillation (sedimentation stage 2). See {@link CardsConfig}. */
  cards: CardsConfig
}

/** How a card may be polished beyond the deterministic skeleton. */
export type DistillMode = 'session' | 'endpoint' | 'off'

/**
 * Knowledge-card distillation settings — this block is what DSH's Plugin
 * Manager renders as the plugin's settings page.
 *
 * `session` (default) polishes a skeleton card with the *current session
 * model* through a tool roundtrip: ff_cards returns the skeleton plus a
 * directive, the model calls back with `polish` + `content`, and the plugin
 * validates the draft against the ledger before storing it. No credentials
 * exist on the tool path, so this is the only honest way to "use the current
 * model" — and it spends conversation tokens, never background money.
 *
 * `endpoint` polishes unattended through a user-supplied OpenAI-compatible
 * chat endpoint (blackhole's endpoint shape). It runs inline on the ff_cards
 * call that finds an unpolished skeleton — never in a background timer — and
 * falls back to the skeleton on any failure.
 */
export interface CardsConfig {
  distill: DistillMode
  endpoint?: {
    baseUrl: string
    model: string
    apiKeyEnv: string
    apiKey?: string
    timeoutMs: number
  }
}

const MODES = ['additive', 'takeover'] as const

/**
 * What the loader validates the row against and what `apply` is handed.
 *
 * `takeover` stays a plain string list rather than an enum of supported names
 * so an unsupported name reaches {@link resolveConfig} and produces the error
 * that explains *why* it cannot be served, instead of a generic "not in union".
 *
 * The annotation is not decoration: the inferred type of a schemastery schema
 * names its own install path (`.pnpm/…`), which `tsc --emitDeclarationOnly`
 * refuses to write into a `.d.ts`. Naming it through the imported binding keeps
 * the declaration portable.
 */
export const Config: ReturnType<typeof z.object> = z.object({
  registration: z.union(MODES).default('additive'),
  takeover: z.array(z.string()).default([]),
  prewarm: z.boolean().default(true),
  cards: z.object({
    distill: z.union(['session', 'endpoint', 'off'] as const).default('session'),
    // Bare optional objects are materialized as {} by schemastery; their
    // required children would prevent the entire plugin from activating.
    endpoint: z.union([z.object({
      baseUrl: z.string().required(),
      model: z.string().required(),
      apiKeyEnv: z.string().default('OPENAI_API_KEY'),
      apiKey: z.string(),
      timeoutMs: z.number().default(120_000),
    }), z.const(null)]).default(null),
  }),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize the row's `config` after schema validation.
 *
 * Runs on top of `Config` because the schema can only say "a list of strings":
 * whether a *particular* name is servable is a property of the tool table, not
 * of the type. Every message names the alternative, because the failure lands
 * in a loader diagnostic where the user cannot experiment.
 *
 * @param raw - the row's `config`, already coerced by {@link Config}, or `undefined`.
 * @returns the resolved settings.
 */
export function resolveConfig(raw?: unknown): ForgeConfig {
  if (raw === undefined || raw === null) return { registration: 'additive', takeover: [], prewarm: true, cards: { distill: 'session' } }
  if (!isRecord(raw)) throw new TypeError('dsh-forge: config must be a mapping')

  const modeRaw = raw.registration
  const registration = (modeRaw === undefined || modeRaw === null ? 'additive' : String(modeRaw).trim()) as RegistrationMode
  if (!(MODES as readonly string[]).includes(registration)) {
    throw new TypeError(
      `dsh-forge: config.registration must be one of ${MODES.map((m) => `"${m}"`).join(', ')} — got: ${JSON.stringify(modeRaw)}`,
    )
  }

  const listRaw = raw.takeover
  const takeover: TakeOverName[] = []
  if (listRaw !== undefined && listRaw !== null) {
    if (!Array.isArray(listRaw)) {
      throw new TypeError('dsh-forge: config.takeover must be a list of native tool names')
    }
    const seen = new Set<string>()
    for (const entry of listRaw) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new TypeError(`dsh-forge: config.takeover entries must be non-empty strings — got: ${JSON.stringify(entry)}`)
      }
      const trimmed = entry.trim()
      if (seen.has(trimmed)) throw new TypeError(`dsh-forge: config.takeover lists "${trimmed}" twice`)
      seen.add(trimmed)
      if (!(TAKE_OVER_CAPABLE as readonly string[]).includes(trimmed)) {
        throw new TypeError(
          `dsh-forge: config.takeover cannot serve "${trimmed}" in its native shape — supported: ` +
            `${TAKE_OVER_CAPABLE.map((n) => `"${n}"`).join(', ')}. ` +
            'The other built-in names take different arguments; leaving them additive is the working default.',
        )
      }
      takeover.push(trimmed as TakeOverName)
    }
  }

  const prewarmRaw = raw.prewarm
  if (prewarmRaw !== undefined && prewarmRaw !== null && typeof prewarmRaw !== 'boolean') {
    throw new TypeError(`dsh-forge: config.prewarm must be true or false — got: ${JSON.stringify(prewarmRaw)}`)
  }

  const cards = resolveCards(raw.cards)

  // `takeover` with an empty list means "everything this plugin can serve": the
  // mode is the user's decision, the capability table is the implementation's.
  const resolved = registration === 'takeover' && takeover.length === 0 ? [...TAKE_OVER_CAPABLE] : takeover
  return { registration, takeover: resolved, prewarm: prewarmRaw ?? true, cards }
}

const DISTILL_MODES: readonly DistillMode[] = ['session', 'endpoint', 'off']

/** Validate the `cards` block on top of the schema, with the same
 *  name-the-alternative discipline as `registration` above. */
function resolveCards(raw: unknown): CardsConfig {
  if (raw === undefined || raw === null) return { distill: 'session' }
  if (!isRecord(raw)) throw new TypeError('dsh-forge: config.cards must be a mapping')

  const modeRaw = raw.distill
  const distill = (modeRaw === undefined || modeRaw === null ? 'session' : String(modeRaw).trim()) as DistillMode
  if (!(DISTILL_MODES as readonly string[]).includes(distill)) {
    throw new TypeError(
      `dsh-forge: config.cards.distill must be one of ${DISTILL_MODES.map((m) => `"${m}"`).join(', ')} — got: ${JSON.stringify(modeRaw)}`,
    )
  }

  let endpoint: CardsConfig['endpoint']
  const endpointRaw = raw.endpoint
  if (endpointRaw !== undefined && endpointRaw !== null) {
    if (!isRecord(endpointRaw)) throw new TypeError('dsh-forge: config.cards.endpoint must be a mapping')
    const baseUrl = typeof endpointRaw.baseUrl === 'string' ? endpointRaw.baseUrl.trim() : ''
    const model = typeof endpointRaw.model === 'string' ? endpointRaw.model.trim() : ''
    if (baseUrl === '' || model === '') {
      throw new TypeError('dsh-forge: config.cards.endpoint needs both baseUrl and model — ' +
        'the endpoint receives POST {baseUrl}/chat/completions with {model, messages}')
    }
    const apiKeyEnv = typeof endpointRaw.apiKeyEnv === 'string' && endpointRaw.apiKeyEnv.trim() !== ''
      ? endpointRaw.apiKeyEnv.trim()
      : 'OPENAI_API_KEY'
    const apiKey = typeof endpointRaw.apiKey === 'string' && endpointRaw.apiKey.trim() !== '' ? endpointRaw.apiKey : undefined
    if (apiKey === undefined && (process.env[apiKeyEnv] ?? '').trim() === '') {
      throw new TypeError(
        `dsh-forge: config.cards.endpoint has no key — set config.cards.endpoint.apiKey or the "${apiKeyEnv}" environment variable`,
      )
    }
    const timeoutRaw = endpointRaw.timeoutMs
    const timeoutMs = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw >= 0 ? timeoutRaw : 120_000
    endpoint = { baseUrl: baseUrl.replace(/\/+$/, ''), model, apiKeyEnv, ...(apiKey === undefined ? {} : { apiKey }), timeoutMs }
  }

  if (distill === 'endpoint' && endpoint === undefined) {
    throw new TypeError(
      'dsh-forge: config.cards.distill "endpoint" needs config.cards.endpoint {baseUrl, model} — ' +
        'or drop the field to polish with the current session model ("session", the default)',
    )
  }

  return { distill, ...(endpoint === undefined ? {} : { endpoint }) }
}
