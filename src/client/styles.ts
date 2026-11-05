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
.dfg-ledger{font-family:inherit;line-height:1.5;container-type:inline-size;gap:8px;flex:1 1 0%;width:100%;height:100%;min-height:0;min-width:0;max-height:100%;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;scrollbar-gutter:stable}
.dfg-ledger>*{flex-shrink:0}
.dfg-workspace-tools{min-width:0}
.dfg-workspace-tools>summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfg-ledger h3{font:inherit;font-size:13px;font-weight:600;margin:0}
.dfg-ledger label{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--dsw-alias-label-secondary)}
.dfg-ledger input,.dfg-ledger textarea,.dfg-ledger select,.dfg-ledger button{font:inherit;box-sizing:border-box}
.dfg-ledger textarea,.dfg-ledger select{width:100%;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--radius-sm,4px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dfg-ledger textarea{min-height:64px;resize:vertical}
.dfg-workbench{display:flex;flex-direction:column;gap:12px;min-width:0}
.dfg-project-index{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:4px 8px;min-width:0;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dfg-project-tools[open]{grid-column:1/-1}
.dfg-project-toolbar{display:flex;align-items:center;gap:8px;min-width:0}
.dfg-project-toolbar .dfg-project-picker{display:block;flex:1;min-width:0;width:0;height:30px;padding-block:2px}
.dfg-project-toolbar>button{flex-shrink:0}
.dfg-project-main{display:flex;flex-direction:column;gap:12px;min-width:0}
.dfg-project-tools[open]>:not(summary),.dfg-report-details[open]>:not(summary){margin-block:8px}
.dfg-project-heading{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
.dfg-project-heading h3{font-size:14px;font-weight:600}
.dfg-view-panel{display:flex;flex-direction:column;gap:12px;min-width:0}
.dfg-plan-preview{display:flex;flex-direction:column;gap:8px;min-width:0}
.dfg-plan-tasks{display:flex;flex-direction:column;gap:4px;list-style:none;margin:0;padding:0}
.dfg-plan-task{display:flex;align-items:baseline;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-width:0}
.dfg-plan-task>.dfg-break{flex:1 1 auto}
.dfg-plan-task.dfg-task-done{opacity:.75}
.dfg-git{display:flex;flex-direction:column;gap:8px;min-width:0}
.dfg-git-head{display:flex;align-items:center;gap:8px;min-width:0;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dfg-git-branch{font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dfg-git-upstream{font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}
.dfg-git-head-spacer{flex:1 1 auto}
.dfg-git-group{display:flex;flex-direction:column;gap:1px;min-width:0}
.dfg-git-group-head{display:flex;align-items:center;gap:6px;min-height:26px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dfg-git-count-pill{flex:none;min-width:18px;height:18px;line-height:18px;text-align:center;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-strong-11);padding:0 4px}
/* A file row: one monospaced status letter, the name prominent, the directory receding, counts pinned right. */
.dfg-ledger .dfg-git-row{display:flex;align-items:center;gap:6px;width:100%;height:24px;padding:0 4px;text-align:left;white-space:nowrap;border-radius:var(--dsw-radius-sm,4px)}
.dfg-ledger .dfg-git-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dfg-git-letter{flex:none;width:12px;text-align:center;font:var(--dsw-font-xxxs-strong-11);font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary)}
.dfg-git-letter[data-tone=modified]{color:var(--dsw-alias-state-warn-primary,#e0a84a)}
.dfg-git-letter[data-tone=added],.dfg-git-letter[data-tone=untracked]{color:var(--dsw-alias-state-success-primary,#4caf7d)}
.dfg-git-letter[data-tone=deleted]{color:var(--dsw-alias-state-error-primary,#e57373)}
.dfg-git-letter[data-tone=renamed]{color:var(--dsw-alias-state-business-primary,#6ba6ff)}
.dfg-git-name{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--dsw-alias-label-primary)}
.dfg-git-dir{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dfg-git-counts{flex:none;display:flex;gap:4px;font:var(--dsw-font-xxxs-strong-11);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dfg-git-add{color:var(--dsw-alias-state-success-primary,#4caf7d)}
.dfg-git-del{color:var(--dsw-alias-state-error-primary,#e57373)}
/* A directory row: a rotating chevron, the compressed chain, its file count. */
.dfg-ledger .dfg-git-dirrow{display:flex;align-items:center;gap:6px;width:100%;height:24px;padding:0 4px;text-align:left;white-space:nowrap;border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-secondary)}
.dfg-ledger .dfg-git-dirrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dfg-chevron{flex:none;width:12px;text-align:center;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform 120ms ease-out}
.dfg-chevron[data-open=true]{transform:rotate(90deg)}
.dfg-git-dirname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--dsw-alias-label-primary)}
/* Aligned diff rows: two gutters, a sign, then the text. */
.dfg-dl{display:flex;flex-direction:column;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:auto;max-height:min(52vh,520px);background:var(--dsw-alias-bg-layer-1)}
.dfg-dl-row{display:flex;align-items:flex-start;gap:6px;padding:0 8px;min-width:0}
.dfg-dl-no{flex:none;width:3em;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:10px;user-select:none;font-variant-numeric:tabular-nums}
.dfg-dl-sign{flex:none;width:1em;text-align:center;font-weight:700;user-select:none;color:var(--dsw-alias-label-tertiary)}
.dfg-dl-text{flex:1 1 auto;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);padding-right:4px}
.dfg-dl-row[data-kind=add]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#4caf7d) 8%,transparent)}
.dfg-dl-row[data-kind=del]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e57373) 8%,transparent)}
.dfg-dl-row[data-kind=mod]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#6ba6ff) 8%,transparent)}
.dfg-dl-row[data-kind=add] .dfg-dl-text,.dfg-dl-row[data-kind=add] .dfg-dl-sign{color:var(--dsw-alias-state-success-primary,#4caf7d)}
.dfg-dl-row[data-kind=del] .dfg-dl-text,.dfg-dl-row[data-kind=del] .dfg-dl-sign{color:var(--dsw-alias-state-error-primary,#e57373)}
.dfg-dl-row[data-kind=mod] .dfg-dl-text,.dfg-dl-row[data-kind=mod] .dfg-dl-sign{color:var(--dsw-alias-state-business-primary,#6ba6ff)}
.dfg-dl-mark{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#6ba6ff) 26%,transparent);border-radius:2px;color:inherit}
.dfg-ledger .dfg-dl-gap{display:flex;width:100%;justify-content:flex-start;height:auto;padding:2px 8px;border:0;border-radius:0;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}
.dfg-ledger .dfg-dl-gap:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dfg-dl-gap-text{padding-left:calc((3em + 1em) * 2)}
.dfg-ledger [hidden]{display:none!important}
.dfg-view-tabs{min-width:0;overflow-x:auto}
.dfg-view-tabs [role=tab]{white-space:nowrap}
.dfg-project-summary>span{display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-secondary)}
.dfg-project-summary strong{font-size:16px;color:var(--dsw-alias-label-primary)}
.dfg-ledger .dfg-file-row{display:flex;justify-content:space-between;align-items:center;gap:12px;height:auto;text-align:left;padding:8px;white-space:normal;border-bottom:1px solid var(--dsw-alias-border-l2)}
@container (max-width:440px){.dfg-view-tabs [role=tab]{font-size:11px;padding-inline:6px}.dfg-project-toolbar{gap:4px}}
.dfg-ledger button:disabled{opacity:.5;cursor:not-allowed}
.dfg-ledger :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}
.dfg-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dfg-actions>input:not([type=checkbox]){flex:1 1 120px}
.dfg-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dfg-filters>.dfg-actions{grid-column:1/-1}
.dfg-project,.dfg-task,.dfg-rollback,.dfg-project details{display:flex;flex-direction:column;gap:8px}
.dfg-project,.dfg-rollback{padding-block:12px;border-block:1px solid var(--dsw-alias-border-l2)}
.dfg-task{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;gap:6px}
.dfg-task-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dfg-task-blocked{opacity:.85}
.dfg-task-done .dfg-task-head{color:var(--dfg-ok)}
.dfg-section-title{font-weight:600;padding-top:8px}
.dfg-ledger .dfg-inline{display:flex;flex-direction:row;align-items:center;gap:8px}
.dfg-ledger summary{cursor:pointer;color:var(--dsw-alias-label-secondary);padding-block:4px}
.dfg-ledger p{margin:0}
.dfg-ledger ul{margin:0;padding-left:20px}
.dfg-break{overflow-wrap:anywhere;max-width:75ch}
.dfg-node{gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.dfg-add{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.dfg-del{text-decoration:line-through}
.dfg-scope{display:flex;flex-direction:column;gap:8px;padding-block:8px;border-block:1px solid var(--dsw-alias-border-l2)}
.dfg-snapshot,.dfg-snapshot-side{display:flex;flex-direction:column;gap:8px;min-width:0}
.dfg-snapshot-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.dfg-snapshot-side .dfg-diff{min-height:160px;max-height:480px}
.dfg-diff.dfg-wrap{white-space:pre-wrap;overflow-wrap:anywhere}
@container (max-width:440px){.dfg-snapshot-columns{grid-template-columns:minmax(0,1fr)}}
@container (max-width:260px){.dfg-filters{grid-template-columns:minmax(0,1fr)}.dfg-node-head{align-items:flex-start;flex-direction:column}.dfg-actions>button{flex-grow:1}}

/* ---------- 视觉语言：语义色与结构性装饰 ---------- */
/* 绿/橙/红/紫与参考实现同一组，明暗背景下均可读；本体沿用宿主字体与间距。 */
.dfg-ledger{--dfg-ok:#4caf7d;--dfg-warn:#e0a84a;--dfg-danger:#e57373;--dfg-info:#b388ff;--dfg-accent:var(--dsw-alias-button-primary-fill,#4a90e2);--dfg-hover:var(--dsw-alias-interactive-bg-hover,#8882);--dfg-surface:var(--dsw-alias-bg-layer-2,#8881)}

/* 施工线：左侧细线与圆点，圆点颜色只表达批次种类，不是装饰。 */
.dfg-timeline{position:relative;display:flex;flex-direction:column;gap:8px;min-width:0;padding-left:18px}
.dfg-timeline::before{content:'';position:absolute;left:5px;top:6px;bottom:6px;width:2px;border-radius:1px;background:var(--dsw-alias-border-l2)}
.dfg-timeline>.dfg-batch{position:relative}
.dfg-timeline>.dfg-batch::before{content:'';position:absolute;left:-17px;top:12px;width:10px;height:10px;border-radius:50%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:2px solid var(--dfg-accent)}
.dfg-timeline>.dfg-batch.dfg-kind-rollback::before{border-color:var(--dfg-warn)}
.dfg-timeline>.dfg-batch.dfg-kind-external::before{border-color:var(--dfg-info)}
.dfg-timeline>.dfg-batch.dfg-kind-delete::before,.dfg-timeline>.dfg-batch.dfg-kind-remove::before{border-color:var(--dfg-danger)}
.dfg-timeline>.dfg-batch.dfg-kind-create::before{border-color:var(--dfg-ok)}

/* 批次卡片：细边圆角，悬停只提亮背景，不加侧边色条。 */
.dfg-ledger .dfg-batch{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;gap:3px;background:transparent;transition:background 120ms ease-out}
.dfg-ledger .dfg-batch:hover{background:var(--dfg-hover)}
.dfg-ledger .dfg-batch[aria-current=true]{box-shadow:inset 0 0 0 1px var(--dfg-accent)}

/* 胶囊徽标：只给状态与种类着色，不给装饰。 */
.dfg-badge.dfg-ok{color:var(--dfg-ok);border-color:color-mix(in srgb,var(--dfg-ok) 55%,transparent)}
.dfg-badge.dfg-warn{color:var(--dfg-warn);border-color:color-mix(in srgb,var(--dfg-warn) 55%,transparent)}
.dfg-badge.dfg-danger{color:var(--dfg-danger);border-color:color-mix(in srgb,var(--dfg-danger) 55%,transparent)}
.dfg-badge.dfg-info{color:var(--dfg-info);border-color:color-mix(in srgb,var(--dfg-info) 55%,transparent)}
.dfg-kind-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--dfg-accent)}
.dfg-kind-dot.rollback{background:var(--dfg-warn)}.dfg-kind-dot.external{background:var(--dfg-info)}.dfg-kind-dot.delete,.dfg-kind-dot.remove{background:var(--dfg-danger)}.dfg-kind-dot.create{background:var(--dfg-ok)}

/* 指标网格：按容器宽度自动换列，窄侧栏自然堆叠。 */
.dfg-project-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px;padding-block:10px;border-block:1px solid var(--dsw-alias-border-l2)}
.dfg-project-summary>span{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);min-width:0}
.dfg-project-summary strong{font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}

.dfg-report-details{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px}

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
