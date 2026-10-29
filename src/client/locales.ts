/**
 * Copy for the settings page.
 *
 * Two rules, both learned the hard way on other plugin pages:
 *
 *  - A control gets a label and nothing else. No rationale, no measured numbers,
 *    no sentence explaining why the setting exists — that belongs in the README,
 *    where it can be rewritten without a rebuild.
 *  - A failure gets the shortest sentence that names what to fix. The host's own
 *    messages are already that shape, so they are shown verbatim rather than
 *    wrapped in an apology.
 *
 * @module dsh-forge/client/locales
 */

/** Dictionary namespace owned by this page. */
export const NS = 'settings.forge'

const zh = {
  // The page's name, used verbatim for the settings-section entry, the page
  // heading and the plugin row (the same string in all three, which is what
  // `dsh-blackhole` does — a slot label that differs from the heading it opens
  // reads as two different pages). `summary` is the row's one-liner, not a name.
  title: 'DSH-Forge',
  summary: '工具接管与索引预热',
  registration: '接管方式',
  modeAdditive: '并存',
  modeTakeover: '接管',
  scope: '接管范围',
  prewarm: '启动预热',
  save: '保存',
  discard: '放弃',
  saved: '已保存',
  loading: '读取中…',
  empty: '无',
}

const en = {
  title: 'DSH-Forge',
  summary: 'Tool takeover and index prewarm',
  registration: 'Takeover',
  modeAdditive: 'Side by side',
  modeTakeover: 'Replace',
  scope: 'Replace which tools',
  prewarm: 'Prewarm on start',
  save: 'Save',
  discard: 'Discard',
  saved: 'Saved',
  loading: 'Loading…',
  empty: 'None',
}

export type ForgeKey = keyof typeof zh

export { zh, en }
