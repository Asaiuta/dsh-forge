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
.dfg-ledger{display:flex;flex-direction:column;gap:8px;padding:10px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dfg-ledger-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dfg-ledger-count{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dfg-ledger-path{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfg-ledger-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dfg-link{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:none;border:0;padding:0;cursor:pointer}
.dfg-link:disabled{opacity:.5;cursor:default}
.dfg-batch{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:8px 10px;border-radius:var(--radius-lg,10px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer}
.dfg-batch:hover{background:var(--dsw-alias-bg-layer-2)}
.dfg-batch-line{display:flex;align-items:center;gap:8px;min-width:0}
.dfg-batch-id{font-size:12px;font-weight:500;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.dfg-batch-kind{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dfg-batch-reason{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfg-badge{font-size:11px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dfg-node{display:flex;flex-direction:column;gap:4px}
.dfg-node-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.dfg-node-file{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfg-diff{margin:0;padding:8px;border-radius:var(--radius-lg,10px);background:var(--dsw-alias-bg-layer-2);font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:1.5;white-space:pre;overflow:auto;max-height:360px}
.dfg-add{color:var(--dsw-alias-label-primary)}
.dfg-del{color:var(--dsw-alias-label-tertiary)}
.dfg-hunk{color:var(--dsw-alias-label-tertiary)}
.dfg-ledger{font-family:inherit;line-height:1.5;container-type:inline-size;gap:12px}
.dfg-ledger h3{font:inherit;font-size:13px;font-weight:600;margin:0}
.dfg-ledger label{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--dsw-alias-label-secondary)}
.dfg-ledger input,.dfg-ledger textarea,.dfg-ledger select,.dfg-ledger button{font:inherit;box-sizing:border-box}
.dfg-ledger input:not([type=checkbox]),.dfg-ledger textarea,.dfg-ledger select{width:100%;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--radius-sm,4px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dfg-ledger textarea{min-height:64px;resize:vertical}
.dfg-ledger button:not(.dfg-batch):not(.dfg-link){padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--radius-sm,4px);color:inherit;background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.dfg-ledger button:disabled{opacity:.5;cursor:not-allowed}
.dfg-ledger :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}
.dfg-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dfg-actions>input:not([type=checkbox]){flex:1 1 120px}
.dfg-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dfg-filters>.dfg-actions{grid-column:1/-1}
.dfg-project,.dfg-task,.dfg-rollback,.dfg-project details{display:flex;flex-direction:column;gap:8px}
.dfg-project,.dfg-rollback{padding-block:12px;border-block:1px solid var(--dsw-alias-border-l2)}
.dfg-task{padding-block:8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dfg-section-title{font-weight:600;padding-top:8px}
.dfg-ledger .dfg-inline{display:flex;flex-direction:row;align-items:center;gap:8px}
.dfg-ledger summary{cursor:pointer;color:var(--dsw-alias-label-secondary);padding-block:4px}
.dfg-ledger p{margin:0}
.dfg-ledger ul{margin:0;padding-left:20px}
.dfg-break{overflow-wrap:anywhere;max-width:75ch}
.dfg-ledger .dfg-batch{border-radius:var(--radius-sm,4px);padding:8px;gap:4px}
.dfg-node{gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.dfg-add{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.dfg-del{text-decoration:line-through}
@container (max-width:260px){.dfg-filters{grid-template-columns:minmax(0,1fr)}.dfg-node-head{align-items:flex-start;flex-direction:column}.dfg-actions>button{flex-grow:1}}

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
