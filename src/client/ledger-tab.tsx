import React, { useEffect, useRef, useState } from 'react';
import { ProjectPanel, jsonRequest, type ProjectNavigation, type ProjectView } from './project-panel';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { SnapshotCompare } from './snapshot-compare';
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
    attribution?: { projectId: string; taskId?: string };
    membership?: 'direct' | 'linked';
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
    version?: 'before' | 'after';
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
    /** Activates better-sidebar's own Git tab; false when it could not be opened. */
    openGitTab?: () => boolean;
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
    const [view, setView] = useState<ProjectView>('timeline');
    const scrollRoot = useRef<HTMLDivElement | null>(null);
    useEffect(() => { scrollRoot.current?.scrollTo({ top: 0 }); }, [view, workspace]);
    const [navigation, setNavigation] = useState<ProjectNavigation | null>(null), [unassigned, setUnassigned] = useState(false), [snapshotNode, setSnapshotNode] = useState<string | null>(null);
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
    useEffect(() => { setOverride(null); setWorkspaceInput(cwd); setProjectId(undefined); setNavigation(null); setUnassigned(false); }, [cwd]);
    useEffect(() => { setView('timeline'); setWorkspaceInput(workspace); setOpenId(null); setDetail(null); setSelection(null); setPreview(null); setRollbackError(''); setDetailError(''); setResult(''); setRows([]); setTotal(0); setCursor(''); setPrevious([]); setNextCursor(null); rollbackSequence.current++; rollbackController.current?.abort(); rollbackLock.current = false; setRollbackBusy(false); }, [workspace]);
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
            workspace, limit: '50', ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
            ...(navigation ? { projectId: navigation.projectId, ...(navigation.taskId ? { taskId: navigation.taskId } : {}), ...(navigation.file ? { file: navigation.file } : {}), ...(navigation.actor ? { actor: navigation.actor } : {}) } : {}),
            ...(unassigned ? { unassigned: 'true' } : {})
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
    }, [workspace, filters, cursor, refresh, props.visible, navigation, unassigned]);
    useEffect(() => {
        const controller = new AbortController(), sequence = ++detailSequence.current;
        setDetail(null);
        setSnapshotNode(null);
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
    function changeWorkspace(value: string, selectedProjectId?: string) { setProjectId(selectedProjectId); setOverride(value); setWorkspaceInput(value); setNavigation(selectedProjectId ? { projectId: selectedProjectId } : null); setUnassigned(false); }
    function navigate(value: ProjectNavigation | null) { resetPage(); setNavigation(value); setUnassigned(false); setOpenId(value?.batch ?? null); if (value?.batch !== undefined) setView('detail'); setSelection(null); setPreview(null); setSnapshotNode(null); }
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
    <h3>回退{selection.node ? `节点 ${selection.node}${selection.version === 'after' ? ' · 完成后版本' : ' · 改动前版本'}` : selection.throughBatch !== undefined ? `至 #${selection.throughBatch}` : `批次 #${selection.batch}`}</h3>
    <p className="dfg-status">快照回退会覆盖文件的当前内容。先检查预览，再明确确认。</p>
    <label>必填理由<textarea aria-label="回退理由" value={reason} disabled={rollbackBusy} onChange={e => { setReason(e.target.value); setPreview(null); setRollbackError(''); }}/>
    </label>
    <div className="dfg-actions">
    <Button type="button" disabled={rollbackBusy || !reason.trim()} onClick={() => void rollback(false)}>预览回退</Button>
    <Button type="button" disabled={rollbackBusy || !preview || expired || !reason.trim()} onClick={() => void rollback(true)}>确认回退</Button>
    <Button type="button" disabled={rollbackBusy} onClick={() => { setSelection(null); setPreview(null); }}>取消回退</Button>
    </div>{rollbackBusy ? <p role="status">回退请求中…</p> : null}{preview ? <>
        <p className="dfg-status">预览有效至 {preview.expiresAt}{expired ? ' · 已过期，请重新预览' : ''}</p>
        <ul>{preview.preview.items?.map((item, i) => <li key={i} className="dfg-break">{item.action} · {item.file} · {item.detail}</li>)}</ul>{preview.preview.note ? <p>{preview.preview.note}</p> : null}</> : null}{rollbackError ? <p role="alert" className="dfg-error">{rollbackError}</p> : null}{result ? <p role="status">{result}</p> : null}</section> : null;
    return <div className="dfg-ledger" ref={scrollRoot} role="region" aria-label="台账滚动区" tabIndex={0}>
    <details className="dfg-workspace-tools"><summary title={workspace}>工作区 · {workspace || '未选择'}</summary>
    <form aria-label="工作区切换" className="dfg-actions" onSubmit={e => { e.preventDefault(); changeWorkspace(workspaceInput.trim()); }}>
    <Input aria-label="台账工作区" value={workspaceInput} onChange={e => setWorkspaceInput(e.target.value)}/>
    <Button type="submit" disabled={!workspaceInput.trim()}>切换工作区</Button>
    </form>
    </details>
    <ProjectPanel key={workspace} workspace={workspace} initialProjectId={projectId} onWorkspace={changeWorkspace} onNavigate={navigate} hasDetail={openId !== null} visible={props.visible === true} openGitTab={props.openGitTab} view={view} onView={value => { setView(value); if (value === 'timeline') { setOpenId(null); setSelection(null); setPreview(null); } }}>
    <section className="dfg-scope" aria-label="台账浏览范围">
        <p className="dfg-status">{unassigned ? '范围：未归属批次（无直接归属且无事后关联）' : navigation ? `工程范围：${navigation.label ?? navigation.projectId}` : '范围：工作区全部施工'}</p>
        <p className="dfg-status">浏览选择不会改变施工归属；工具须显式传工程/任务。</p>
        <label className="dfg-inline"><input type="checkbox" aria-label="仅看未归属批次" checked={unassigned} onChange={e => { resetPage(); setUnassigned(e.target.checked); setNavigation(null); setOpenId(null); setSelection(null); setPreview(null); }}/>仅看未归属批次</label>
        {navigation ? <Button type="button" className="dfg-link" onClick={() => navigate(null)}>返回工作区全部施工</Button> : null}
    </section>
    {openId !== null ? <>
        <div className="dfg-ledger-head">
        <Button type="button" className="dfg-link" onClick={() => { setOpenId(null); setView('timeline'); setSelection(null); setPreview(null); }}>← 返回台账</Button>
        <span>#{openId}</span>
        </div>{detailError ? <p role="alert" className="dfg-error">{detailError}</p> : null}{detailBusy ? <p role="status">读取详情中…</p> : null}{rollbackView}{detail ? <>
            <p className="dfg-break">{detail.batch.reason}</p>
            <p className="dfg-status">{detail.batch.actor} · {stamp(detail.batch.ts)}</p>
            <div className="dfg-actions">
            <Button type="button" onClick={() => chooseRollback({
                batch: openId
            })}>回退整个批次</Button>
            <Button type="button" onClick={() => chooseRollback({
                throughBatch: openId
            })}>恢复至此批次之后</Button>
            </div>{detail.nodes.map(node => <section key={node.node} className="dfg-node">
                <div className="dfg-node-head">
                <span className="dfg-node-file" title={node.file}>{node.file}</span>
                <span className="dfg-ledger-meta">{node.op}{node.truncated ? ' · 截断' : ''}</span>
                </div>
                <Button className="dfg-link" type="button" aria-label={`回退节点 ${node.node}`} onClick={() => chooseRollback({
                    batch: openId, node: node.node
                })}>预览回退此节点</Button>
                <div className="dfg-actions">
                    <Button type="button" aria-label={`恢复节点 ${node.node} 完成后版本`} onClick={() => chooseRollback({ batch: openId, node: node.node, version: 'after' })}>恢复完成后版本</Button>
                    <Button type="button" aria-label={`查看完整快照 ${node.node}`} onClick={() => setSnapshotNode(snapshotNode === node.node ? null : node.node)}>{snapshotNode === node.node ? '收起完整快照' : '查看完整快照'}</Button>
                </div>
                {snapshotNode === node.node ? <SnapshotCompare key={`${workspace}:${node.node}`} workspace={workspace} node={node.node}/> : null}
                {node.unreadable ? <p className="dfg-error">{node.diff}</p> : node.binary ? <p>{node.diff}</p> : <pre className="dfg-diff">{node.diff.split('\n').map((line, i) => <DiffLine key={i} line={line}/>)}</pre>}</section>)}</> : null}</> : <>
      <details className="dfg-history-tools"><summary>搜索施工记录</summary>
      <form aria-label="台账筛选" className="dfg-filters" onSubmit={e => { e.preventDefault(); resetPage(); setFilters({
            ...draft
        }); setRefresh(v => v + 1); }}>{([['keyword', '关键词'], ['pathContains', '文件路径包含'], ['actor', '贡献者'], ['kind', '批次类型']] as const).map(([key, label]) => <label key={key}>{label}<Input aria-label={label} value={draft[key]} onChange={e => setDraft(d => ({
                ...d, [key]: e.target.value
            }))}/>
            </label>)}<div className="dfg-actions">
        <Button type="submit" aria-label="应用筛选">应用筛选</Button>
        <Button type="button" onClick={() => { setDraft({
            ...emptyFilters
        }); setFilters({
            ...emptyFilters
        }); resetPage(); }}>清空筛选</Button>
        <Button type="button" disabled={listBusy} onClick={() => { resetPage(); setRefresh(v => v + 1); }}>刷新</Button>
        </div>
        </form>
      </details>
      <div className="dfg-ledger-head">
        <span>{total} 批 · 当前页 {rows.length} 批</span>{listBusy ? <span role="status">读取中…</span> : null}</div>
        <p className="dfg-ledger-path" title={workspace}>{workspace || '当前会话没有工作区'}</p>{error ? <p role="alert" className="dfg-error">{error} <Button type="button" onClick={() => { resetPage(); setRefresh(v => v + 1); }}>从首页重试</Button>
            </p> : null}{!listBusy && !error && rows.length === 0 ? <p className="dfg-status">没有匹配记录。可清空筛选或检查工作区。</p> : null}
      <div className="dfg-timeline" role="group" aria-label="施工时间线">
      {rows.map(row => <Button key={row.id} type="button" aria-label={`查看批次 #${row.id}`} className={`dfg-batch dfg-kind-${row.kind}`} onClick={() => { setOpenId(row.id); setView('detail'); }}>
            <span className="dfg-batch-line">
            <span className="dfg-batch-id">#{row.id}</span>
            <span className="dfg-batch-kind"><span className={`dfg-kind-dot ${row.kind}`} aria-hidden="true"/>{row.kind}</span>
            {row.membership ? <span className="dfg-badge">{row.membership === 'direct' ? '直接归属' : '事后关联'}</span> : row.attribution ? <span className="dfg-badge">工程已归属</span> : null}
            <span className="dfg-ledger-meta">{stamp(row.ts)}</span>
            </span>
            <span className="dfg-batch-reason">{row.reason}</span>
            <span className="dfg-ledger-meta">{row.actor} · {row.files.length} 个文件{row.reverted !== undefined ? ` · 已回退 #${row.reverted}` : ''}</span>{row.check ? <span className={`dfg-badge ${row.check.recorded === 'passed' && row.check.applicable ? 'dfg-ok' : row.check.recorded === 'failed' ? 'dfg-danger' : 'dfg-warn'}`}>机器检查 · 记录 {row.check.recorded} · 当前 {row.check.effective}{row.check.applicable ? '' : ' · 已失效'}</span> : null}</Button>)}
      </div>
      <nav aria-label="台账分页" className="dfg-actions">
        <Button type="button" disabled={listBusy || previous.length === 0} onClick={() => { setCursor(previous[previous.length - 1]); setPrevious(p => p.slice(0, -1)); }}>上一页</Button>
        <Button type="button" disabled={listBusy || !nextCursor} onClick={() => {
                if (nextCursor) {
                    setPrevious(p => [...p, cursor]);
                    setCursor(nextCursor);
                }
            }}>下一页</Button>
        </nav>
    </>}
    </ProjectPanel>
  </div>;
}
