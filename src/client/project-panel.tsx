import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives';
import { GitPanel } from './git-panel';
export type ProjectView = 'plan' | 'timeline' | 'files' | 'detail' | 'git';
const views = [['plan', '计划'], ['timeline', '施工线'], ['files', '改动文件'], ['detail', '详情'], ['git', 'Git']].map(([value, label]) => ({ value, label, id: `forge-tab-${value}`, panelId: `forge-panel-${value}` }));
export function endpoint(path: string, query = ''): string {
    const relative = path.replace(/^\/+/, '');
    const base = typeof document === 'undefined' ? `/${relative}` : new URL(relative, document.baseURI).pathname;
    return query ? `${base}?${query}` : base;
}
export async function jsonRequest<T>(path: string, query = '', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(endpoint(path, query), {
        signal, headers: {
            accept: 'application/json', ...(body ? {
                'content-type': 'application/json'
            } : {})
        }, ...(body ? {
            method: 'POST', body: JSON.stringify(body)
        } : {})
    });
    let payload: any;
    try {
        payload = JSON.parse(await response.text());
    }
    catch {
        throw new Error(`HTTP ${response.status}`);
    }
    if (!response.ok || payload.ok !== true)
        throw new Error(payload.error ?? `HTTP ${response.status}`);
    return payload;
}
interface Task {
    id: string;
    title: string;
    note?: string;
    status: string;
    archived?: boolean;
}
export interface ProjectNavigation { projectId: string; taskId?: string; file?: string; actor?: string; batch?: number; label?: string }
interface Evidence {
    version: number; projectRevision: number;
    batches: { id: number; nodes: { node: string; file: string; before: string | null; after: string | null }[] }[];
    verification: { id: string; recorded: string; effective: string; applicable: boolean; drifted: string[] }[];
}
interface Project {
    id: string;
    workspace: string;
    name: string;
    revision: number;
    status: string;
    todoSource?: {sessionId: string; callId: string; capturedAt: number; turn?: number | null; callIds?: string[]; writes?: number; todos: {content: string; status: string}[]};
    tasks: Task[];
    links: {
        taskId: string;
        batchId: number;
    }[];
    reports: {
        id: string;
        status: string;
        conclusion: string;
        issues: string[];
        submittedBy?: string;
        evidence?: Evidence;
    }[];
}
interface Overview {
    batches: number;
    actors: {
        actor: string;
        batches: number;
    }[];
    files: {
        file: string;
        count: number;
    }[];
    lineChanges: {
        added: number;
        deleted: number;
        unavailable: number;
        method: string;
    };
}
const statuses = ['pending', 'doing', 'done', 'blocked'];
const labels: Record<string, string> = {
    pending: '待办', doing: '进行中', done: '完成', blocked: '阻塞'
};
function TaskEditor({ task, disabled, save }: {
    task: Task;
    disabled: boolean;
    save: (fields: Record<string, unknown>) => void;
}) {
    const [title, setTitle] = useState(task.title), [note, setNote] = useState(task.note ?? '');
    useEffect(() => { setTitle(task.title); setNote(task.note ?? ''); }, [task.id, task.title, task.note]);
    return <section className={`dfg-task dfg-task-${task.status}`}>
    <label><span className="dfg-task-head"><span className={`dfg-kind-dot ${task.status === 'done' ? 'create' : task.status === 'blocked' ? 'delete' : task.status === 'doing' ? 'rollback' : ''}`} aria-hidden="true"/>{labels[task.status] ?? task.status}</span><Input aria-label={`任务标题 ${task.title}`} disabled={disabled} value={title} onChange={e => setTitle(e.target.value)}/>
    </label>
    <label>备注<textarea aria-label={`任务备注 ${task.title}`} disabled={disabled} value={note} onChange={e => setNote(e.target.value)}/>
    </label>
    <div className="dfg-actions">
    <select aria-label={`任务状态 ${task.title}`} value={task.status} disabled={disabled} onChange={e => save({
        status: e.target.value
    })}>{statuses.map(s => <option key={s} value={s}>{labels[s]}</option>)}</select>
    <Button type="button" disabled={disabled || !title.trim()} onClick={() => save({
        title, note
    })}>保存任务</Button>
    </div>
    </section>;
}
export function ProjectPanel({ workspace, onWorkspace, initialProjectId, onNavigate, view: controlledView, onView, hasDetail = false, visible = false, openGitTab, children }: {
    workspace: string;
    onWorkspace: (workspace: string, projectId?: string) => void;
    initialProjectId?: string;
    onNavigate?: (value: ProjectNavigation | null) => void;
    view?: ProjectView;
    hasDetail?: boolean;
    visible?: boolean;
    openGitTab?: () => boolean;
    onView?: (value: ProjectView) => void;
    children?: React.ReactNode;
}) {
    const [localView, setLocalView] = useState<ProjectView>('plan'), [query, setQuery] = useState('');
    const view = controlledView ?? localView;
    function changeView(value: string) { setLocalView(value as ProjectView); onView?.(value as ProjectView); }
    function drill(value: ProjectNavigation) { changeView('timeline'); onNavigate?.(value); }
    function selectProject(p: Project | undefined) {
        setProject(p ?? null); changeView('plan');
        if (!p || p.workspace === workspace) onNavigate?.(p ? { projectId: p.id, label: p.name } : null);
        if (p && p.workspace !== workspace) onWorkspace(p.workspace, p.id);
    }
    const [projects, setProjects] = useState<Project[]>([]), [project, setProject] = useState<Project | null>(null), [overview, setOverview] = useState<Overview | null>(null);
    const [name, setName] = useState(''), [title, setTitle] = useState(''), [note, setNote] = useState(''), [batch, setBatch] = useState(''), [selected, setSelected] = useState<string[]>([]);
    const [conclusion, setConclusion] = useState(''), [issues, setIssues] = useState(''), [reportStatus, setReportStatus] = useState('draft');
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [all, setAll] = useState(false), [refresh, setRefresh] = useState(0);
    const [projectRefresh, setProjectRefresh] = useState(0);
    const epoch = useRef(0), mutation = useRef(false);
    useEffect(() => { epoch.current++; setProject(null); setOverview(null); setSelected([]); setError(''); setBusy(false); mutation.current = false; }, [workspace]);
    // Sidebar tabs stay mounted: reload whenever the tab is shown again so a Todo written meanwhile appears without a manual refresh.
    useEffect(() => { if (visible) setRefresh(x => x + 1); }, [visible]);
    useEffect(() => {
        const controller = new AbortController();
        const generation = epoch.current;
        setBusy(true);
        void jsonRequest<any>('/forge-projects', all ? '' : new URLSearchParams({
            workspace
        }).toString(), undefined, controller.signal).then(p => {
            if (!controller.signal.aborted && generation === epoch.current) {
                setProjects(p.projects);
                if (initialProjectId)
                    setProject(p.projects.find((candidate: Project) => candidate.id === initialProjectId) ?? null);
            }
        }).catch(e => {
            if (!controller.signal.aborted)
                setError(String(e.message));
        }).finally(() => {
            if (!controller.signal.aborted && generation === epoch.current)
                setBusy(false);
        });
        return () => controller.abort();
    }, [workspace, all, refresh, initialProjectId]);
    useEffect(() => {
        setOverview(null);
        if (!project)
            return;
        const controller = new AbortController();
        void jsonRequest<any>('/forge-projects', new URLSearchParams({
            workspace: project.workspace, projectId: project.id
        }).toString(), undefined, controller.signal).then(p => {
            if (!controller.signal.aborted) {
                setOverview(p.overview);
                setProject(p.project);
            }
        }).catch(e => {
            if (!controller.signal.aborted)
                setError(e.message);
        });
        return () => controller.abort();
    }, [project?.id, project?.revision, workspace, projectRefresh]);
    async function mutate(action: string, fields: Record<string, unknown>, base: Project | null = project): Promise<Project | null> {
        if (mutation.current)
            return null;
        mutation.current = true;
        setBusy(true);
        setError('');
        const generation = epoch.current;
        try {
            const payload = await jsonRequest<{
                project: Project;
            }>('/forge-projects', '', {
                action, workspace: base?.workspace ?? workspace, ...(base ? {
                    projectId: base.id, revision: base.revision
                } : {}), ...fields
            });
            if (generation !== epoch.current)
                return null;
            setProject(payload.project);
            if (action === 'create') onNavigate?.({ projectId: payload.project.id, label: payload.project.name });
            setProjects(old => [payload.project, ...old.filter(p => p.id !== payload.project.id)]);
            return payload.project;
        }
        catch (e) {
            if (generation === epoch.current)
                setError(`${e instanceof Error ? e.message : String(e)} · 刷新工程后重试`);
            return null;
        }
        finally {
            if (generation === epoch.current) {
                mutation.current = false;
                setBusy(false);
            }
        }
    }
    async function linkTasks() {
        if (!project)
            return;
        let current = project;
        for (const taskId of selected) {
            if (current.links.some(l => l.taskId === taskId && l.batchId === Number(batch)))
                continue;
            const next = await mutate('link', {
                taskId, batchId: Number(batch)
            }, current);
            if (!next)
                return;
            current = next;
        }
    }
    const todoPlans = projects.filter(p => p.todoSource).sort((a, b) => b.createdAt - a.createdAt);
    return <section className="dfg-workbench" aria-label="工程管理">
    <aside className="dfg-project-index" aria-label="工程索引">
      <div className="dfg-project-toolbar">
        <span className="dfg-status">工程</span>
        <select className="dfg-project-picker" aria-label="选择工程" disabled={busy} value={project?.id ?? ''} onChange={e => selectProject(projects.find(p => p.id === e.target.value))}>
          <option value="">工作区全部施工</option>{projects.filter(p => p.id === project?.id || `${p.name} ${p.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(p => <option value={p.id} key={p.id}>{p.name}</option>)}
        </select>
        <Button size="sm" type="button" disabled={busy} onClick={() => { setRefresh(x => x + 1); setProjectRefresh(x => x + 1); }}>刷新工程</Button>
      </div>
      <details className="dfg-project-tools"><summary>工程管理</summary>
        <label className="dfg-inline"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)}/>跨工作区工程</label>
        <Input type="search" aria-label="搜索工程" placeholder="搜索名称 / ID" value={query} onChange={e => setQuery(e.target.value)}/>
        <div className="dfg-actions">
          <Input aria-label="工程名称" placeholder="新工程名称" value={name} onChange={e => setName(e.target.value)}/>
          <Button size="sm" type="button" disabled={busy || !name.trim() || !workspace} onClick={() => void mutate('create', { name }, null)}>创建工程</Button>
        </div>
      </details>
    </aside>
    <div className="dfg-project-main">
    <header className="dfg-project-heading"><h3>{project?.name ?? '工作区施工'}</h3><p className="dfg-status">{project ? `${project.status} · 修订 ${project.revision}` : '选择工程，或浏览此工作区全部施工'}</p></header>
    <SegmentedTabs items={views} value={view} onChange={changeView} label="工程视图" className="dfg-view-tabs"/>
    {busy ? <p role="status" className="dfg-status">工程请求中…</p> : null}{error ? <p role="alert" className="dfg-error">{error}</p> : null}
    <section role="tabpanel" id="forge-panel-plan" aria-labelledby="forge-tab-plan" hidden={view !== 'plan'} className="dfg-view-panel">
    {project ? <>
        {project.todoSource ? <details className="dfg-todo-source" open><summary>引用 Todo · {project.todoSource.todos.length} 项</summary>
          <p className="dfg-status dfg-break">会话 {project.todoSource.sessionId}{project.todoSource.turn === null || project.todoSource.turn === undefined ? '' : ` · 第 ${project.todoSource.turn} 轮`}{project.todoSource.writes && project.todoSource.writes > 1 ? ` · 合并 ${project.todoSource.writes} 次写入` : ''}</p>
          <p className="dfg-status">同一轮内的多次写入是同一份计划，就近更新；标题完全换掉才算新计划。以下是最后一次快照，工程任务的后续修改不回写会话 Todo。</p>
          <ol aria-label="引用的 Todo 快照">{project.todoSource.todos.map((todo,index)=><li key={index}><span>{todo.status === 'completed' ? '已完成' : todo.status === 'in_progress' ? '进行中' : '待处理'}</span> · {todo.content}</li>)}</ol>
        </details> : null}
        <p className="dfg-status"><span className={`dfg-badge ${project.status === 'accepted' ? 'dfg-ok' : project.status === 'review' ? 'dfg-warn' : project.status === 'archived' ? 'dfg-danger' : ''}`}>{project.status}</span> {project.name} · r{project.revision} · 人工验收不代表机器检查通过</p>
        <Button type="button" disabled={busy} onClick={() => setProjectRefresh(x => x + 1)}>重新读取当前工程</Button>
      <Button type="button" className="dfg-link" onClick={() => drill({ projectId: project.id, label: project.name })}>查看工程全部施工</Button>
      <div className="dfg-project-summary"><span><strong>{overview?.batches ?? '—'}</strong>施工批次</span><span><strong>{project.tasks.filter(t => t.status === 'done').length}/{project.tasks.length}</strong>完成任务</span><span><strong>{overview?.files.length ?? '—'}</strong>改动文件</span></div>
      <div className="dfg-section-title">任务与备注</div>{project.tasks.map(task => <div key={task.id}>
          <TaskEditor task={task} disabled={busy} save={fields => void mutate('task_update', { taskId: task.id, ...fields })}/>
          <Button type="button" className="dfg-link" aria-label={`查看任务施工 ${task.title}`} onClick={() => drill({ projectId: project.id, taskId: task.id, label: task.title })}>查看任务施工</Button>
      </div>)}
      <label>新增任务<Input aria-label="新增任务标题" value={title} onChange={e => setTitle(e.target.value)}/>
        </label>
        <label>任务备注<textarea aria-label="新增任务备注" value={note} onChange={e => setNote(e.target.value)}/>
        </label>
        <Button type="button" disabled={busy || !title.trim()} onClick={() => void mutate('task_add', {
            title, note
        })}>新增任务</Button>
      <details>
        <summary>关联批次到多个任务</summary>
        <label>批次编号<Input aria-label="关联批次编号" inputMode="numeric" value={batch} onChange={e => setBatch(e.target.value)}/>
        </label>{project.tasks.map(t => <label className="dfg-inline" key={t.id}>
            <input type="checkbox" aria-label={`关联任务 ${t.title}`} checked={selected.includes(t.id)} onChange={e => setSelected(s => e.target.checked ? [...s, t.id] : s.filter(id => id !== t.id))}/>{t.title}</label>)}<Button type="button" disabled={busy || !selected.length || !Number.isSafeInteger(Number(batch)) || Number(batch) < 1} onClick={() => void linkTasks()}>关联选中任务</Button>{project.links.map(l => <Button type="button" className="dfg-link" key={`${l.taskId}:${l.batchId}`} aria-label={`查看关联批次 #${l.batchId}`} onClick={() => drill({ projectId: project.id, batch: l.batchId, label: project.name })}>#{l.batchId} → {project.tasks.find(t => t.id === l.taskId)?.title ?? l.taskId}</Button>)}</details>
      {overview ? <details>
            <summary>贡献者 · {overview.batches} 批</summary>
            <p className="dfg-status">按唯一关联批次统计，不是个人贡献质量评分。</p>{overview.actors.map(a => <Button type="button" className="dfg-link" key={a.actor} aria-label={`查看贡献者施工 ${a.actor}`} onClick={() => drill({ projectId: project.id, actor: a.actor, label: a.actor })}>{a.actor} · {a.batches} 批</Button>)}<p className="dfg-status">+{overview.lineChanges.added} / −{overview.lineChanges.deleted} · 不可用 {overview.lineChanges.unavailable}</p>
            <p className="dfg-status">{overview.lineChanges.method}</p>
            </details> : null}
    </> : todoPlans[0] ? <section className="dfg-plan-preview" aria-label="最新计划">
      <p className="dfg-status"><span className="dfg-badge">{todoPlans[0].tasks.filter(t => t.status === 'done').length}/{todoPlans[0].tasks.length} 完成</span></p>
      <h3 className="dfg-break">{todoPlans[0].name}</h3>
      <p className="dfg-status">这是本工作区最近的一次计划。从上方菜单选中它，就能修改任务与备注；菜单是唯一的入口。</p>
      <ol className="dfg-plan-tasks" aria-label="最新计划任务">{todoPlans[0].tasks.map(t => <li key={t.id} className={`dfg-plan-task dfg-task-${t.status}`}>
        <span className={`dfg-kind-dot ${t.status === 'done' ? 'create' : t.status === 'blocked' ? 'delete' : t.status === 'doing' ? 'rollback' : ''}`} aria-hidden="true"/>
        <span className="dfg-break">{t.title}</span>
        <span className="dfg-status">{t.status === 'done' ? '已完成' : t.status === 'doing' ? '进行中' : t.status === 'blocked' ? '阻塞' : '待处理'}</span>
      </li>)}</ol>
    </section> : <p className="dfg-status">{busy ? '正在读取计划…' : projects.length === 0 ? '此工作区还没有工程或 Todo 计划。AI 写入 Todo 后，计划会出现在这里。' : '此工作区还没有 Todo 计划；可以新建工程，或让 AI 先写一份 Todo。'}</p>}
    </section>
    <section role="tabpanel" id="forge-panel-files" aria-labelledby="forge-tab-files" hidden={view !== 'files'} className="dfg-view-panel">
        <h3>改动文件</h3><p className="dfg-status">工程内唯一施工批次覆盖的文件。选择文件查看历史。</p>
        {project && overview?.files.length ? overview.files.map(f => <Button key={f.file} className="dfg-file-row" aria-label={`查看文件历史 ${f.file}`} onClick={() => drill({ projectId: project.id, file: f.file, label: f.file })}><span className="dfg-break">{f.file}</span><span className="dfg-status">{f.count} 次</span></Button>) : <p className="dfg-status">{project ? '暂无改动文件。' : '先选择工程查看文件索引。'}</p>}
    </section>
    <section role="tabpanel" id="forge-panel-timeline" aria-labelledby="forge-tab-timeline" hidden={view !== 'timeline'} className="dfg-view-panel">{view === 'timeline' && !hasDetail ? children : null}{hasDetail ? <Button onClick={() => changeView('detail')}>返回已选批次详情</Button> : null}</section>
    <section role="tabpanel" id="forge-panel-git" aria-labelledby="forge-tab-git" hidden={view !== 'git'} className="dfg-view-panel">
        <GitPanel workspace={project?.workspace ?? workspace} active={view === 'git'} openGitTab={openGitTab} />
    </section>
    <section role="tabpanel" id="forge-panel-detail" aria-labelledby="forge-tab-detail" hidden={view !== 'detail'} className="dfg-view-panel">
      {view === 'detail' && hasDetail ? children : null}
      <details open={!hasDetail} className="dfg-report-details"><summary>工程信息与验收报告</summary>
      {project ? <>
        <p className="dfg-status">报告冻结提交时证据；人工接受不等于机器检查通过。</p>
        <label>结论<textarea aria-label="报告结论" value={conclusion} onChange={e => setConclusion(e.target.value)}/>
        </label>
        <label>问题（每行一条）<textarea aria-label="报告问题" value={issues} onChange={e => setIssues(e.target.value)}/>
        </label>
        <select aria-label="报告状态" value={reportStatus} onChange={e => setReportStatus(e.target.value)}>
        <option value="draft">draft · 草稿</option>
        <option value="review">review · 待审</option>
        <option value="accepted">accepted · 人工接受</option>
        </select>
        <p className="dfg-status">accepted 为人工验收；机器检查结果请在台账查看。未完成任务不能接受。</p>
        <Button type="button" disabled={busy || !conclusion.trim() || (reportStatus === 'accepted' && project.tasks.some(t => t.status !== 'done'))} onClick={() => void mutate('report', {
            conclusion, issues: issues.split('\n').map(s => s.trim()).filter(Boolean), status: reportStatus
        })}>提交报告</Button>{project.reports.map(r => <section key={r.id}>
            <p>{r.status} · {r.conclusion}</p>
            <ul>{r.issues.map((i, n) => <li key={n}>{i}</li>)}</ul>
            <p className="dfg-status">提交者：{r.submittedBy ?? '历史记录未署名'}</p>
            {r.evidence ? <details><summary>冻结证据 · 工程 r{r.evidence.projectRevision} · {r.evidence.batches.length} 批</summary>
                <p className="dfg-status">以下为提交时的证据，不随当前文件或任务变化更新。</p>
                {r.evidence.batches.map(b => <div key={b.id}>
                    <Button type="button" className="dfg-link" aria-label={`查看报告证据批次 #${b.id}`} onClick={() => drill({ projectId: project.id, batch: b.id, label: '报告证据' })}>批次 #{b.id}</Button>
                    {b.nodes.map(n => <p key={n.node} className="dfg-status dfg-break">{n.node} · {n.file} · {n.before ?? '不存在'} → {n.after ?? '不存在'}</p>)}
                </div>)}
                {r.evidence.verification.length ? r.evidence.verification.map(v => <p key={v.id} className="dfg-status dfg-break">验证 {v.id} · 记录 {v.recorded} · 提交时 {v.effective}{v.applicable ? '' : ` · 漂移 ${v.drifted.join('、')}`}</p>) : <p className="dfg-status">提交时没有关联的机器验证记录。</p>}
            </details> : <p className="dfg-status">旧报告未捕获证据清单，不补造历史证据。</p>}
            </section>)}</> : <p className="dfg-status">选择工程查看工程信息与验收报告；从施工线选择批次查看快照详情。</p>}
      </details>
    </section>
    </div>
  </section>;
}
