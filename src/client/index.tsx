/**
 * dsh-forge — browser settings for tool surface and built-in write visibility.
 *
 * ## What this page is, and what it is not
 *
 * It edits `surface` and `hideBuiltinWrites`, leaving other row fields intact.
 *
 * ## Why the page owns its own form
 *
 * Every control here is a shape the shared form model cannot express — a two-value
 * enum. `SettingsFormModel` takes
 * `{ format, parse }` specs over a *string*, so a form built on it would ask the
 * user to type the value. The page therefore draws the host's own
 * `SegmentedControl` and stages the value itself,
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
import { Button, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS, en, zh, type ForgeKey } from './locales.ts'
import { mountStyles } from './styles.ts'
import { LedgerTab, type LedgerTabProps } from './ledger-tab.tsx'

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

/** `betterSidebar.registerTab` id; also the tab type the sidebar keys tabs by. */
const LEDGER_TAB_ID = 'forge:ledger'

/** better-sidebar's own Git tab id (its unified changes tab kept the old name). */
const BUILTIN_GIT_TAB = 'git'

/** Route served by `src/http-plugin.ts`. */
const CONFIG_PATH = '/forge-config'

interface Settings { surface: 'retrieval' | 'full'; hideBuiltinWrites: boolean }

type Translate = (key: ForgeKey) => string

/**
 * The slice of `dsh-better-sidebar`'s client service this plugin registers into.
 *
 * Restated structurally rather than imported: better-sidebar is an optional
 * neighbour, and importing its types would make this bundle unloadable — not
 * just unreachable — on every profile that does not have it installed.
 */
interface PluginSidebarService extends BetterSidebarService {
  /** Activates an open tab; a strict no-op for an unknown id. */
  activateTab?(tabId: string): void
  /** Opens (or reveals) a tab of a registered type in the active session. */
  openTab?(seed: { type: string; title?: string; path?: string }): void
}

/**
 * The door from our Git page to better-sidebar's own Git tab.
 *
 * Its id is `git` — kept from before that tab was widened into the unified
 * changes tab so persisted layouts survive. `openTab` is a silent no-op for a
 * type the user disabled and for a build that lacks it, so the presence and the
 * enabled flag are checked first and the result is reported instead of assumed.
 *
 * @returns a function that answers whether the tab was actually requested.
 */
function openBuiltinGitTab(sidebar: PluginSidebarService): () => boolean {
  return () => {
    try {
      // Only a DEFINITE absence refuses. A build too old to answer `getTab` is not
      // evidence that the tab is missing, and refusing there would strand the page
      // on the fallback forever.
      if (typeof sidebar.getTab === 'function' && sidebar.getTab(BUILTIN_GIT_TAB) === undefined) return false
      if (sidebar.isTabEnabled?.(BUILTIN_GIT_TAB) === false) return false
      if (typeof sidebar.openTab === 'function') { sidebar.openTab({ type: BUILTIN_GIT_TAB }); return true }
      if (typeof sidebar.activateTab === 'function') { sidebar.activateTab(BUILTIN_GIT_TAB); return true }
      return false
    } catch { return false }
  }
}

interface BetterSidebarService {
  registerTab(descriptor: {
    id: string
    title: () => string
    description: () => string
    order: number
    single: boolean
    component: (props: LedgerTabProps) => unknown
  }): () => void
}

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
    surface: settings.surface,
    hideBuiltinWrites: settings.hideBuiltinWrites,
  })
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
          surface: draft.surface,
          hideBuiltinWrites: draft.hideBuiltinWrites,
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

  return (
    <div className="dfg-root">
      {head}
      <section className="dfg-card">
        <div className="dfg-field">
          <span className="dfg-label">{t('surface')}</span>
          <SegmentedControl
            id="dfg-surface"
            label={t('surface')}
            value={draft.surface}
            options={[
              { value: 'retrieval', label: t('surfaceRetrieval') },
              { value: 'full', label: t('surfaceFull') },
            ]}
            disabled={busy}
            onChange={(next: string) => { patch({ surface: next as Settings['surface'] }) }}
          />
        </div>

        <div className="dfg-field">
          <label className="dfg-label" htmlFor="dfg-hide-writes">
            <input id="dfg-hide-writes" type="checkbox" checked={draft.hideBuiltinWrites}
              disabled={busy || draft.surface !== 'full'}
              onChange={(event) => { patch({ hideBuiltinWrites: event.target.checked }) }} />
            {t('hideBuiltinWrites')}
          </label>
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

  // The ledger tab belongs to better-sidebar, not to this plugin's own seat:
  // it appears only where that plugin is mounted, and a profile without it
  // loses nothing but the tab. `inject` waits for the service instead of
  // declaring it required, which would keep the settings page from mounting on
  // every profile that does not run a sidebar.
  ctx.inject(['betterSidebar'], (scoped) => {
    const sidebar = (scoped as unknown as { betterSidebar?: BetterSidebarService }).betterSidebar
    if (sidebar === undefined) return
    // Built once, outside the component factory: the tab factory runs on every
    // render of this row, and a fresh opener each time would retrigger any
    // consumer effect keyed on it.
    const openGit = openBuiltinGitTab(sidebar)
    scoped.effect(() => sidebar.registerTab({
      id: LEDGER_TAB_ID,
      title: () => t('ledgerTitle'),
      description: () => t('ledgerSummary'),
      // After the builtin explorer/editor/changes rows (100 is the default).
      order: 70,
      single: true,
      component: (props: LedgerTabProps) => <LedgerTab {...props} openGitTab={openGit} />,
    }), 'dsh-forge: ledger tab')
  })
}
