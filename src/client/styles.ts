/**
 * Page styles, injected once.
 *
 * Every colour, radius and font comes from the shell's own theme variables, for
 * one reason: this page renders inside the shell's Settings panel and inside the
 * plugin manager's row page, so a self-invented grey reads as a foreign artifact
 * in one theme and as an unreadable one in the other.
 *
 * The tokens are **not** all in one namespace: semantic colours are
 * `--dsw-alias-*` (`bg-layer-1/2`, `border-l2`, `label-primary/secondary/tertiary`,
 * `state-error-primary`), while the scalars are unprefixed (`--radius-lg/xl/2xl`).
 * `--dsw-radius-*` has zero definitions — a `var()` on it silently resolves to
 * the property's initial value, which looks like a design decision.
 *
 * The card frame (18px padding, `radius-2xl`, `border-l2` hairline on
 * `bg-layer-1`) matches `dsh-custom-header` and `dsh-blackhole`, so plugin pages
 * in the same panel line up.
 *
 * @module dsh-forge/client/styles
 */

const STYLE_ID = 'dsh-forge-page'

const CSS = `
.dfg-root{display:flex;flex-direction:column;gap:18px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dfg-head{display:flex;flex-direction:column;gap:4px}
.dfg-title{margin:0;font-size:18px;font-weight:600;line-height:1.3}
.dfg-card{display:flex;flex-direction:column;gap:16px;padding:18px;border-radius:var(--radius-2xl,16px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dfg-field{display:flex;flex-direction:column;gap:8px}
.dfg-label{font-size:13px;font-weight:500;line-height:1.4}
.dfg-checks{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.dfg-mono{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dfg-footer{display:flex;align-items:center;gap:10px}
.dfg-status{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dfg-error{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
`

/** Mount the stylesheet once; returns a disposer that removes it. */
export function mountStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = CSS
  document.head.appendChild(element)
  return () => {
    element.remove()
  }
}
