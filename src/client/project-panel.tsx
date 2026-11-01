import React, { useEffect, useRef, useState } from 'react';
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
interface Project {
    id: string;
    workspace: string;
    name: string;
    revision: number;
    status: string;
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
    return <section className="dfg-task">
    <label>任务<input aria-label={`任务标题 ${task.title}`} disabled={disabled} value={title} onChange={e => setTitle(e.target.value)}/>
    </label>
    <label>备注<textarea aria-label={`任务备注 ${task.title}`} disabled={disabled} value={note} onChange={e => setNote(e.target.value)}/>
    </label>
    <div className="dfg-actions">
    <select aria-label={`任务状态 ${task.title}`} value={task.status} disabled={disabled} onChange={e => save({
        status: e.target.value
    })}>{statuses.map(s => <option key={s} value={s}>{labels[s]}</option>)}</select>
    <button type="button" disabled={disabled || !title.trim()} onClick={() => save({
        title, note
    })}>保存任务</button>
    </div>
    </section>;
}
export function ProjectPanel({ workspace, onWorkspace, initialProjectId }: {
    workspace: string;
    onWorkspace: (workspace: string, projectId?: string) => void;
    initialProjectId?: string;
}) {
    const [projects, setProjects] = useState<Project[]>([]), [project, setProject] = useState<Project | null>(null), [overview, setOverview] = useState<Overview | null>(null);
    const [name, setName] = useState(''), [title, setTitle] = useState(''), [note, setNote] = useState(''), [batch, setBatch] = useState(''), [selected, setSelected] = useState<string[]>([]);
    const [conclusion, setConclusion] = useState(''), [issues, setIssues] = useState(''), [reportStatus, setReportStatus] = useState('draft');
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [all, setAll] = useState(false), [refresh, setRefresh] = useState(0);
    const [projectRefresh, setProjectRefresh] = useState(0);
    const epoch = useRef(0), mutation = useRef(false);
    useEffect(() => { epoch.current++; setProject(null); setOverview(null); setSelected([]); setError(''); setBusy(false); mutation.current = false; }, [workspace]);
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
    return <section className="dfg-project" aria-label="工程管理">
    <div className="dfg-ledger-head">
    <h3>工程</h3>
    <button type="button" disabled={busy} onClick={() => { setRefresh(x => x + 1); setProjectRefresh(x => x + 1); }}>刷新工程</button>
    </div>
    <label className="dfg-inline">
    <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)}/>跨工作区工程</label>
    <select aria-label="选择工程" disabled={busy} value={project?.id ?? ''} onChange={e => {
            const p = projects.find(p => p.id === e.target.value);
            setProject(p ?? null);
            if (p && p.workspace !== workspace)
                onWorkspace(p.workspace, p.id);
        }}>
    <option value="">选择工程</option>{projects.map(p => <option value={p.id} key={p.id}>{p.name} · {p.workspace}</option>)}</select>
    <div className="dfg-actions">
    <input aria-label="工程名称" placeholder="新工程名称" value={name} onChange={e => setName(e.target.value)}/>
    <button type="button" disabled={busy || !name.trim() || !workspace} onClick={() => void mutate('create', {
        name
    }, null)}>创建工程</button>
    </div>
    {busy ? <p role="status" className="dfg-status">工程请求中…</p> : null}{error ? <p role="alert" className="dfg-error">{error}</p> : null}
    {project ? <>
        <p className="dfg-status">{project.name} · r{project.revision} · 人工验收：{project.status}；不代表机器检查通过</p>
        <button type="button" disabled={busy} onClick={() => setProjectRefresh(x => x + 1)}>重新读取当前工程</button>
      <div className="dfg-section-title">任务与备注</div>{project.tasks.map(task => <TaskEditor key={task.id} task={task} disabled={busy} save={fields => void mutate('task_update', {
            taskId: task.id, ...fields
        })}/>)}
      <label>新增任务<input aria-label="新增任务标题" value={title} onChange={e => setTitle(e.target.value)}/>
        </label>
        <label>任务备注<textarea aria-label="新增任务备注" value={note} onChange={e => setNote(e.target.value)}/>
        </label>
        <button type="button" disabled={busy || !title.trim()} onClick={() => void mutate('task_add', {
            title, note
        })}>新增任务</button>
      <details>
        <summary>关联批次到多个任务</summary>
        <label>批次编号<input aria-label="关联批次编号" inputMode="numeric" value={batch} onChange={e => setBatch(e.target.value)}/>
        </label>{project.tasks.map(t => <label className="dfg-inline" key={t.id}>
            <input type="checkbox" aria-label={`关联任务 ${t.title}`} checked={selected.includes(t.id)} onChange={e => setSelected(s => e.target.checked ? [...s, t.id] : s.filter(id => id !== t.id))}/>{t.title}</label>)}<button type="button" disabled={busy || !selected.length || !Number.isSafeInteger(Number(batch)) || Number(batch) < 1} onClick={() => void linkTasks()}>关联选中任务</button>{project.links.map(l => <p className="dfg-status" key={`${l.taskId}:${l.batchId}`}>#{l.batchId} → {project.tasks.find(t => t.id === l.taskId)?.title ?? l.taskId}</p>)}</details>
      {overview ? <details>
            <summary>贡献者与文件热点 · {overview.batches} 批</summary>
            <p className="dfg-status">按唯一关联批次统计，不是个人贡献质量评分。</p>{overview.actors.map(a => <p key={a.actor}>{a.actor} · {a.batches} 批</p>)}{overview.files.map(f => <p key={f.file} className="dfg-break">{f.file} · {f.count} 次</p>)}<p className="dfg-status">+{overview.lineChanges.added} / −{overview.lineChanges.deleted} · 不可用 {overview.lineChanges.unavailable}</p>
            <p className="dfg-status">{overview.lineChanges.method}</p>
            </details> : null}
      <details>
        <summary>报告与人工验收</summary>
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
        <button type="button" disabled={busy || !conclusion.trim() || (reportStatus === 'accepted' && project.tasks.some(t => t.status !== 'done'))} onClick={() => void mutate('report', {
            conclusion, issues: issues.split('\n').map(s => s.trim()).filter(Boolean), status: reportStatus
        })}>提交报告</button>{project.reports.map(r => <section key={r.id}>
            <p>{r.status} · {r.conclusion}</p>
            <ul>{r.issues.map((i, n) => <li key={n}>{i}</li>)}</ul>
            </section>)}</details>
    </> : projects.length === 0 && !busy ? <p className="dfg-status">此工作区还没有工程。创建工程后可组织任务与验收证据。</p> : null}
  </section>;
}
