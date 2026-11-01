import React, { useEffect, useRef, useState } from 'react';
import { ProjectPanel, jsonRequest } from './project-panel';
interface CheckRow {
    recorded: string;
    effective: string;
    applicable: boolean;
}
interface BatchRow {
    id: number;
    ts: number;
    kind: string;
    reason: string;
    actor: string;
    reverted?: number;
    files: {
        file: string;
        op: string;
        bytes: number;
    }[];
    check?: CheckRow;
}
interface DetailNode {
    node: string;
    file: string;
    op: string;
    diff: string;
    binary: boolean;
    truncated: boolean;
    unreadable?: boolean;
}
interface DetailPayload {
    batch: BatchRow;
    nodes: DetailNode[];
}
interface ListPayload {
    workspace: string;
    batches: BatchRow[];
    total: number;
    nextCursor?: string | null;
}
interface Filters {
    keyword: string;
    pathContains: string;
    actor: string;
    kind: string;
}
interface Selection {
    batch?: number;
    throughBatch?: number;
    node?: string;
    pathContains?: string;
}
interface Preview {
    token: string;
    expiresAt: string;
    preview: {
        status: string;
        items: {
            file: string;
            action: string;
            detail: string;
        }[];
        note?: string;
    };
}
export interface LedgerTabProps {
    scope: {
        cwd?: string;
    };
    visible?: boolean;
}
const emptyFilters: Filters = {
    keyword: '', pathContains: '', actor: '', kind: ''
};
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
function stamp(ts: number) { return new Date(ts).toLocaleString(); }
function DiffLine({ line }: {
    line: string;
}) { return <div className={line.startsWith('+') ? 'dfg-add' : line.startsWith('-') ? 'dfg-del' : line.startsWith('@@') ? 'dfg-hunk' : undefined}>{line || ' '}</div>; }
export function LedgerTab(props: LedgerTabProps): React.ReactElement {
    const cwd = props.scope.cwd ?? '';
    const [override, setOverride] = useState<string | null>(null), [workspaceInput, setWorkspaceInput] = useState(cwd), [projectId, setProjectId] = useState<string | undefined>(undefined);
    const workspace = override ?? cwd;
    const [draft, setDraft] = useState<Filters>({
        ...emptyFilters
    }), [filters, setFilters] = useState<Filters>({
        ...emptyFilters
    });
    const [cursor, setCursor] = useState(''), [previous, setPrevious] = useState<string[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
    const [rows, setRows] = useState<BatchRow[]>([]), [total, setTotal] = useState(0), [listBusy, setListBusy] = useState(false), [error, setError] = useState('');
    const [openId, setOpenId] = useState<number | null>(null), [detail, setDetail] = useState<DetailPayload | null>(null), [detailBusy, setDetailBusy] = useState(false), [detailError, setDetailError] = useState('');
    const [selection, setSelection] = useState<Selection | null>(null), [reason, setReason] = useState(''), [preview, setPreview] = useState<Preview | null>(null), [rollbackError, setRollbackError] = useState(''), [rollbackBusy, setRollbackBusy] = useState(false), [result, setResult] = useState(''), [expired, setExpired] = useState(false);
    const listSequence = useRef(0), detailSequence = useRef(0), rollbackSequence = useRef(0), rollbackController = useRef<AbortController | null>(null), rollbackLock = useRef(false);
    useEffect(() => { setOverride(null); setWorkspaceInput(cwd); setProjectId(undefined); }, [cwd]);
    useEffect(() => { setWorkspaceInput(workspace); setOpenId(null); setDetail(null); setSelection(null); setPreview(null); setRollbackError(''); setDetailError(''); setResult(''); setRows([]); setTotal(0); setCursor(''); setPrevious([]); setNextCursor(null); rollbackSequence.current++; rollbackController.current?.abort(); rollbackLock.current = false; setRollbackBusy(false); }, [workspace]);
    useEffect(() => {
        if (props.visible === false)
            return;
        const controller = new AbortController(), sequence = ++listSequence.current;
        if (!workspace) {
            setRows([]);
            setTotal(0);
            setListBusy(false);
            return;
        }
        setListBusy(true);
        setError('');
        const query = new URLSearchParams({
            workspace, limit: '50', ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
        });
        if (cursor)
            query.set('cursor', cursor);
        void jsonRequest<ListPayload>('/forge-ledger', query.toString(), undefined, controller.signal).then(payload => {
            if (!controller.signal.aborted && sequence === listSequence.current) {
                setRows(payload.batches);
                setTotal(payload.total);
                setNextCursor(payload.nextCursor ?? null);
            }
        }).catch(e => {
            if (!controller.signal.aborted && sequence === listSequence.current)
                setError(message(e));
        }).finally(() => {
            if (!controller.signal.aborted && sequence === listSequence.current)
                setListBusy(false);
        });
        return () => controller.abort();
    }, [workspace, filters, cursor, refresh, props.visible]);
    useEffect(() => {
        const controller = new AbortController(), sequence = ++detailSequence.current;
        setDetail(null);
        setDetailError('');
        setDetailBusy(false);
        if (openId === null || !workspace)
            return;
        setDetailBusy(true);
        void jsonRequest<DetailPayload>('/forge-ledger', new URLSearchParams({
            workspace, batch: String(openId)
        }).toString(), undefined, controller.signal).then(payload => {
            if (!controller.signal.aborted && sequence === detailSequence.current)
                setDetail(payload);
        }).catch(e => {
            if (!controller.signal.aborted && sequence === detailSequence.current)
                setDetailError(message(e));
        }).finally(() => {
            if (!controller.signal.aborted && sequence === detailSequence.current)
                setDetailBusy(false);
        });
        return () => controller.abort();
    }, [workspace, openId, refresh]);
    useEffect(() => {
        setExpired(false);
        if (!preview)
            return;
        const remaining = Date.parse(preview.expiresAt) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) {
            setExpired(true);
            return;
        }
        const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2147483647));
        return () => clearTimeout(timer);
    }, [preview]);
    useEffect(() => () => { rollbackSequence.current++; rollbackController.current?.abort(); }, []);
    function resetPage() { setCursor(''); setPrevious([]); setNextCursor(null); }
    function changeWorkspace(value: string, selectedProjectId?: string) { setProjectId(selectedProjectId); setOverride(value); setWorkspaceInput(value); }
    function chooseRollback(value: Selection) { rollbackSequence.current++; rollbackController.current?.abort(); rollbackLock.current = false; setRollbackBusy(false); setSelection(value); setPreview(null); setRollbackError(''); setResult(''); }
    async function rollback(confirm: boolean) {
        if (!selection || !reason.trim() || rollbackLock.current || confirm && (!preview || expired))
            return;
        const controller = new AbortController();
        rollbackController.current?.abort();
        rollbackController.current = controller;
        const sequence = ++rollbackSequence.current;
        rollbackLock.current = true;
        setRollbackBusy(true);
        setRollbackError('');
        setResult('');
        if (!confirm)
            setPreview(null);
        try {
            const payload = await jsonRequest<any>('/forge-ledger', '', confirm ? {
                action: 'confirm', workspace, token: preview!.token, reason
            } : {
                action: 'preview', workspace, selection, reason
            }, controller.signal);
            if (controller.signal.aborted || sequence !== rollbackSequence.current)
                return;
            if (confirm) {
                setPreview(null);
                if (payload.result?.status === 'applied' && payload.result?.dryRun === false) {
                    setResult(`已应用回退 · 新批次 #${payload.result.newBatch}`);
                    resetPage();
                    setRefresh(v => v + 1);
                }
                else
                    setRollbackError('服务未返回已应用凭证；请刷新台账核查并重新预览。');
            }
            else
                setPreview(payload);
        }
        catch (e) {
            if (!controller.signal.aborted && sequence === rollbackSequence.current) {
                setPreview(null);
                setRollbackError(`${message(e)} · 请重新预览后再确认`);
            }
        }
        finally {
            if (sequence === rollbackSequence.current) {
                rollbackLock.current = false;
                setRollbackBusy(false);
            }
        }
    }
    const rollbackView = selection ? <section className="dfg-rollback" aria-label="回退预览与确认">
    <h3>回退{selection.node ? `节点 ${selection.node}` : selection.throughBatch !== undefined ? `至 #${selection.throughBatch}` : `批次 #${selection.batch}`}</h3>
    <p className="dfg-status">快照回退会覆盖文件的当前内容。先检查预览，再明确确认。</p>
    <label>必填理由<textarea aria-label="回退理由" value={reason} disabled={rollbackBusy} onChange={e => { setReason(e.target.value); setPreview(null); setRollbackError(''); }}/>
    </label>
    <div className="dfg-actions">
    <button type="button" disabled={rollbackBusy || !reason.trim()} onClick={() => void rollback(false)}>预览回退</button>
    <button type="button" disabled={rollbackBusy || !preview || expired || !reason.trim()} onClick={() => void rollback(true)}>确认回退</button>
    <button type="button" disabled={rollbackBusy} onClick={() => { setSelection(null); setPreview(null); }}>取消回退</button>
    </div>{rollbackBusy ? <p role="status">回退请求中…</p> : null}{preview ? <>
        <p className="dfg-status">预览有效至 {preview.expiresAt}{expired ? ' · 已过期，请重新预览' : ''}</p>
        <ul>{preview.preview.items?.map((item, i) => <li key={i} className="dfg-break">{item.action} · {item.file} · {item.detail}</li>)}</ul>{preview.preview.note ? <p>{preview.preview.note}</p> : null}</> : null}{rollbackError ? <p role="alert" className="dfg-error">{rollbackError}</p> : null}{result ? <p role="status">{result}</p> : null}</section> : null;
    return <div className="dfg-ledger">
    <form aria-label="工作区切换" className="dfg-actions" onSubmit={e => { e.preventDefault(); changeWorkspace(workspaceInput.trim()); }}>
    <input aria-label="台账工作区" value={workspaceInput} onChange={e => setWorkspaceInput(e.target.value)}/>
    <button type="submit" disabled={!workspaceInput.trim()}>切换工作区</button>
    </form>
    <details className="dfg-project-disclosure">
    <summary>工程与验收</summary>
    <ProjectPanel key={workspace} workspace={workspace} initialProjectId={projectId} onWorkspace={changeWorkspace}/>
    </details>
    {openId !== null ? <>
        <div className="dfg-ledger-head">
        <button type="button" className="dfg-link" onClick={() => { setOpenId(null); setSelection(null); setPreview(null); }}>← 返回台账</button>
        <span>#{openId}</span>
        </div>{detailError ? <p role="alert" className="dfg-error">{detailError}</p> : null}{detailBusy ? <p role="status">读取详情中…</p> : null}{rollbackView}{detail ? <>
            <p className="dfg-break">{detail.batch.reason}</p>
            <p className="dfg-status">{detail.batch.actor} · {stamp(detail.batch.ts)}</p>
            <div className="dfg-actions">
            <button type="button" onClick={() => chooseRollback({
                batch: openId
            })}>回退整个批次</button>
            <button type="button" onClick={() => chooseRollback({
                throughBatch: openId
            })}>恢复至此批次之后</button>
            </div>{detail.nodes.map(node => <section key={node.node} className="dfg-node">
                <div className="dfg-node-head">
                <span className="dfg-node-file" title={node.file}>{node.file}</span>
                <span className="dfg-ledger-meta">{node.op}{node.truncated ? ' · 截断' : ''}</span>
                </div>
                <button className="dfg-link" type="button" aria-label={`回退节点 ${node.node}`} onClick={() => chooseRollback({
                    batch: openId, node: node.node
                })}>预览回退此节点</button>{node.unreadable ? <p className="dfg-error">{node.diff}</p> : node.binary ? <p>{node.diff}</p> : <pre className="dfg-diff">{node.diff.split('\n').map((line, i) => <DiffLine key={i} line={line}/>)}</pre>}</section>)}</> : null}</> : <>
      <form aria-label="台账筛选" className="dfg-filters" onSubmit={e => { e.preventDefault(); resetPage(); setFilters({
            ...draft
        }); setRefresh(v => v + 1); }}>{([['keyword', '关键词'], ['pathContains', '文件路径包含'], ['actor', '贡献者'], ['kind', '批次类型']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} value={draft[key]} onChange={e => setDraft(d => ({
                ...d, [key]: e.target.value
            }))}/>
            </label>)}<div className="dfg-actions">
        <button type="submit" aria-label="应用筛选">应用筛选</button>
        <button type="button" onClick={() => { setDraft({
            ...emptyFilters
        }); setFilters({
            ...emptyFilters
        }); resetPage(); }}>清空筛选</button>
        <button type="button" disabled={listBusy} onClick={() => { resetPage(); setRefresh(v => v + 1); }}>刷新</button>
        </div>
        </form>
      <div className="dfg-ledger-head">
        <span>{total} 批 · 当前页 {rows.length} 批</span>{listBusy ? <span role="status">读取中…</span> : null}</div>
        <p className="dfg-ledger-path" title={workspace}>{workspace || '当前会话没有工作区'}</p>{error ? <p role="alert" className="dfg-error">{error} <button type="button" onClick={() => { resetPage(); setRefresh(v => v + 1); }}>从首页重试</button>
            </p> : null}{!listBusy && !error && rows.length === 0 ? <p className="dfg-status">没有匹配记录。可清空筛选或检查工作区。</p> : null}
      {rows.map(row => <button key={row.id} type="button" aria-label={`查看批次 #${row.id}`} className="dfg-batch" onClick={() => setOpenId(row.id)}>
            <span className="dfg-batch-line">
            <span className="dfg-batch-id">#{row.id}</span>
            <span>{row.kind}</span>
            <span className="dfg-ledger-meta">{stamp(row.ts)}</span>
            </span>
            <span className="dfg-batch-reason">{row.reason}</span>
            <span className="dfg-ledger-meta">{row.actor} · {row.files.length} 个文件{row.reverted !== undefined ? ` · 已回退 #${row.reverted}` : ''}</span>{row.check ? <span className="dfg-badge">机器检查 · 记录 {row.check.recorded} · 当前 {row.check.effective}{row.check.applicable ? '' : ' · 已失效'}</span> : null}</button>)}
      <nav aria-label="台账分页" className="dfg-actions">
        <button type="button" disabled={listBusy || previous.length === 0} onClick={() => { setCursor(previous[previous.length - 1]); setPrevious(p => p.slice(0, -1)); }}>上一页</button>
        <button type="button" disabled={listBusy || !nextCursor} onClick={() => {
                if (nextCursor) {
                    setPrevious(p => [...p, cursor]);
                    setCursor(nextCursor);
                }
            }}>下一页</button>
        </nav>
    </>}
  </div>;
}
