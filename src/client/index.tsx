/**
 * dsh-forge — browser half: the three settings the plugin actually has.
 *
 * ## What this page is, and what it is not
 *
 * It edits `registration`, `takeover` and `prewarm` — the fields whose change
 * alters which tools exist. It deliberately does **not** edit `cards`: that block
 * carries an endpoint URL and a credential, it changes behaviour nobody touches
 * twice, and keeping it in the profile patch is the honest home for a secret.
 *
 * ## Why the page owns its own form
 *
 * Every control here is a shape the shared form model cannot express — a two-value
 * enum, a set of native tool names, and a boolean. `SettingsFormModel` takes
 * `{ format, parse }` specs over a *string*, so a form built on it would ask the
 * user to type `takeover` and `true`. The page therefore draws the host's own
 * `SegmentedControl` / `Checkbox` / `Switch` and stages the three values itself,
 * and the host side (`src/http-plugin.ts`) persists them through
 * `configEditor.edit()`, which remounts the plugin row so the new tool surface
 * really is the registered one.
 *
 * ## Copy rule
 *
 * Label, current value, control, error. Nothing else — no rationale, no measured
 * numbers, no paragraph explaining why the switch exists.
 *
 * ## Two seats
 *
 * `settings.section` puts the page in the Settings panel's own navigation;
 * `plugins.row.config` (key `<package>#<row id>`) puts it behind the Plugins page's
 * **Configure** button for this bundle's row. Both render the same component: the
 * Shell passes `{ close }` for a section, and the row page passes
 * `view: 'summary'` for its one-liner or `view: 'page'` for the page itself.
 *
 * @module dsh-forge/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, Checkbox, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS, en, zh, type ForgeKey } from './locales.ts'
import { mountStyles } from './styles.ts'

/** Required services: the slot registry and the dictionary the labels live in. */
export const inject = ['slots', 'locale']

/** The Loader row this page configures; also its `plugins.row.config` key prefix. */
const ROW_ID = 'dsh-forge'

/**
 * `<package name>#<row id>` — the seat the plugin manager looks up.
 *
 * Spelled out rather than built from {@link ROW_ID}: this string is what the
 * host keys the registration by, and the build asserts it is present in the
 * emitted bundle, which a template literal would make impossible.
 */
const ROW_KEY = 'dsh-forge#dsh-forge'

/** `settings.section` id; a fresh id is added beside the shipped rows. */
const SECTION_ID = 'dsh-forge'

/** Nav position after dsh-market (40), dsh-custom-header (50) and dsh-blackhole (55). */
const SECTION_ORDER = 60

/** Native names the takeover control offers, in display order. */
const CAPABILITY = ['read', 'glob', 'grep'] as const

/** Route served by `src/http-plugin.ts`. */
const CONFIG_PATH = '/forge-config'

type Mode = 'additive' | 'takeover'

/** The three values, as both ends of the wire agree on them. */
interface Settings {
  registration: Mode
  takeover: string[]
  prewarm: boolean
}

type Translate = (key: ForgeKey) => string

/**
 * Resolve a route against the page's own base.
 *
 * The desktop shell serves the page from `dsh-app://` and the web shell from the
 * host's port; only a base-relative path works for both (same helper dsh-market
 * and dsh-blackhole use).
 */
const api = (path: string): string => {
  const relative = path.replace(/^\/+/, '')
  if (typeof document === 'undefined') return `/${relative}`
  return new URL(relative, document.baseURI).pathname
}

/** One round trip against the config route. */
async function request(init?: RequestInit): Promise<Settings> {
  const response = await fetch(api(CONFIG_PATH), {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
  const record = payload as { ok?: boolean; error?: string; state?: Settings }
  if (!response.ok || record.ok !== true || record.state === undefined) {
    throw new Error(record.error ?? `HTTP ${response.status}`)
  }
  return record.state
}

/** Compare only what this page writes; a reordered array is not an edit. */
function signature(settings: Settings): string {
  return JSON.stringify({
    registration: settings.registration,
    takeover: [...settings.takeover].sort(),
    prewarm: settings.prewarm,
  })
}

/** Keep the persisted order stable whatever order the boxes were ticked in. */
function ordered(names: string[]): string[] {
  return CAPABILITY.filter((name) => names.includes(name))
}

/**
 * The page. Hooks are declared before the `summary` early return because the
 * plugin manager asks the same component for a one-liner.
 */
function ForgeSettingsPage(props: { view?: string; t: Translate; close?: () => void }) {
  const { t } = props
  const [saved, setSaved] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const state = await request()
      setSaved(state)
      setDraft(state)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (props.view === 'summary') return
    void load()
  }, [load, props.view])

  const dirty = useMemo(
    () => saved !== null && draft !== null && signature(saved) !== signature(draft),
    [saved, draft],
  )

  const patch = useCallback((next: Partial<Settings>) => {
    setDraft((current) => (current === null ? current : { ...current, ...next }))
    setNotice(null)
  }, [])

  const save = useCallback(async () => {
    if (draft === null) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const state = await request({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          registration: draft.registration,
          takeover: ordered(draft.takeover),
          prewarm: draft.prewarm,
        }),
      })
      setSaved(state)
      setDraft(state)
      setNotice(t('saved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [draft, t])

  if (props.view === 'summary') return <>{t('summary')}</>

  const head = (
    <div className="dfg-head">
      <h2 className="dfg-title">{t('title')}</h2>
    </div>
  )

  if (draft === null || saved === null) {
    return (
      <div className="dfg-root">
        {head}
        {error === null ? <p className="dfg-status">{t('loading')}</p> : <p className="dfg-error">{error}</p>}
      </div>
    )
  }

  const takingOver = draft.registration === 'takeover'

  return (
    <div className="dfg-root">
      {head}
      <section className="dfg-card">
        <div className="dfg-field">
          <span className="dfg-label">{t('registration')}</span>
          <SegmentedControl
            id="dfg-registration"
            label={t('registration')}
            value={draft.registration}
            options={[
              { value: 'additive', label: t('modeAdditive') },
              { value: 'takeover', label: t('modeTakeover') },
            ]}
            disabled={busy}
            onChange={(next: string) => { patch({ registration: next as Mode }) }}
          />
        </div>

        <div className="dfg-field">
          <span className="dfg-label">{t('scope')}</span>
          <div className="dfg-checks">
            {CAPABILITY.map((name) => (
              <Checkbox
                key={name}
                label={name}
                checked={draft.takeover.includes(name)}
                disabled={busy || !takingOver}
                onChange={(next: boolean) => {
                  const rest = draft.takeover.filter((entry) => entry !== name)
                  patch({ takeover: next ? [...rest, name] : rest })
                }}
              />
            ))}
          </div>
        </div>

        <div className="dfg-field">
          <span className="dfg-label">{t('prewarm')}</span>
          <Switch
            checked={draft.prewarm}
            label={t('prewarm')}
            disabled={busy}
            onChange={(next: boolean) => { patch({ prewarm: next }) }}
          />
        </div>

        <div className="dfg-footer">
          <Button variant="primary" disabled={busy || !dirty} onClick={() => { void save() }}>
            {t('save')}
          </Button>
          <Button disabled={busy || !dirty} onClick={() => { setDraft(saved); setError(null); setNotice(null) }}>
            {t('discard')}
          </Button>
          {error !== null
            ? <p className="dfg-error">{error}</p>
            : notice !== null
              ? <p className="dfg-status">{notice}</p>
              : null}
        </div>
      </section>
    </div>
  )
}

/**
 * Mount the page in both of its seats.
 *
 * The section is registered outright: its data comes from the plugin's own row,
 * which always exists while this bundle is loaded, so a host that fails to serve
 * the route should show the page's error line rather than hide the entry — that
 * is the difference between a diagnosable failure and a silent one. The row page
 * additionally waits for the plugin manager, because that slot only exists while
 * `client-ui-plugin-manager` is mounted.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS) as Translate
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-forge: dictionaries')
  ctx.effect(() => mountStyles(), 'dsh-forge: page styles')

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => t('title'),
    locale: NS,
    inject: () => ({}),
  }, ForgeSettingsPage)), 'dsh-forge: settings section')

  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: ROW_KEY,
    locale: NS,
    inject: () => ({}),
  }, ForgeSettingsPage)), 'dsh-forge: row configuration page')
}
