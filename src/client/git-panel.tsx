import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { jsonRequest } from './project-panel';
import { buildChangeTree, flattenVisible, type ChangeDir } from './change-tree';
import { diffLines, foldContext, type DiffLine, type DiffRow } from './line-diff';

/**
 * 只读 Git 页：分支状态、改动清单、逐文件两侧文本。
 *
 * 这里没有任何暂存、提交、推送、丢弃的按钮 —— 后端也没有对应路由，
 * 因此误点也改不了仓库。施工快照与 Git 历史相互独立，页面上分开讲。
 */

interface Entry {
    path: string; origPath: string | null; status: string;
    added: number | null; removed: number | null; binary: boolean;
}
interface Repo {
    isRepo: boolean;
    toplevel?: string; prefix?: string;
    branch?: { head: string | null; upstream: string | null; ahead: number; behind: number; detached: boolean; initial: boolean };
    remotes?: string[];
    staged?: Entry[]; changes?: Entry[]; conflicts?: Entry[];
    total?: number;
}
interface Side { exists: boolean; binary: boolean; oversized: boolean; text: string | null; bytes: number }
interface Diff { path: string; before: Side; after: Side }

/** One letter, the way git and every editor abbreviate it. */
function statusLetter(entry: Entry): string {
    if (entry.status === 'U') return 'U';
    if (entry.status === 'R' || entry.origPath) return 'R';
    return entry.status || 'M';
}

/** The host's own semantic tones, not an invented palette. */
function statusTone(entry: Entry): string {
    if (entry.status === 'U') return 'untracked';
    if (entry.status === 'A') return 'added';
    if (entry.status === 'D') return 'deleted';
    if (entry.status === 'R' || entry.origPath) return 'renamed';
    return 'modified';
}

function DirRow({ node, depth, open, onToggle }: { node: ChangeDir; depth: number; open: boolean; onToggle: () => void }) {
    return <Button type="button" className="dfg-git-dirrow" aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}目录 ${node.path}`} onClick={onToggle}
        style={{ paddingInlineStart: `${4 + depth * 12}px` }}>
        <span className="dfg-chevron" data-open={open ? 'true' : undefined} aria-hidden="true">›</span>
        <span className="dfg-git-dirname">{node.name}</span>
        <span className="dfg-git-count-pill">{node.changes}</span>
    </Button>;
}

function statusWords(entry: Entry): string {
    if (entry.status === 'U') return '未跟踪';
    if (entry.status === 'R' || entry.origPath) return '重命名';
    if (entry.status === 'D') return '已删除';
    if (entry.status === 'A') return '新增';
    return '已修改';
}

/**
 * Why this diff cannot be shown as aligned text, or null when it can.
 *
 * Each reason is spelled out rather than folded into one generic notice: "new
 * file", "binary" and "too large" call for different reactions from the reader.
 */
function diffNote(diff: Diff | null): React.ReactElement | null {
    if (diff === null) return null;
    if (diff.before.exists === false) return <p className="dfg-status">这是新文件：索引侧没有版本，全部行为新增。</p>;
    if (diff.after.exists === false) return <p className="dfg-status">文件已从工作区删除，全部行为删除。</p>;
    if (diff.before.binary || diff.after.binary) return <p className="dfg-status">二进制内容，不按文本比较。</p>;
    if (diff.before.oversized || diff.after.oversized) return <p className="dfg-warn">一侧超过 1 MiB，未加载；不做截断以免给出错误印象。</p>;
    return null;
}

/** Split so the name stays scannable and the directory recedes. */
function splitPath(file: string): { dir: string; name: string } {
    const cut = file.lastIndexOf('/');
    return cut === -1 ? { dir: '', name: file } : { dir: file.slice(0, cut + 1), name: file.slice(cut + 1) };
}

const SIGNS: Record<DiffRow['kind'], string> = { same: '\u00a0', add: '+', del: '−', mod: '~' };

/** The text of one row, with the changed span marked when the row is a rewrite. */
function RowText({ row }: { row: DiffRow }) {
    if (row.change === undefined) return <span className="dfg-dl-text">{row.text || ' '}</span>;
    const [start, end] = row.change;
    return <span className="dfg-dl-text">{row.text.slice(0, start)}<mark className="dfg-dl-mark">{row.text.slice(start, end)}</mark>{row.text.slice(end) || ' '}</span>;
}

function DiffLines({ before, after, expand, onExpand }: {
    before: string; after: string; expand: Set<number>; onExpand: (index: number) => void;
}) {
    // Budget-capped alignment: a file too large to align says so instead of guessing.
    const result = useMemo(() => diffLines(before, after), [before, after]);
    const folded = useMemo(() => foldContext(result.rows), [result.rows]);
    return <>
        {result.coarse ? <p className="dfg-warn">文件差别过大，未能逐行对齐；下面按整文件替换列出，未做任何省略。</p> : null}
        <div className="dfg-dl" role="table" aria-label="逐行差异">
            {folded.map((line, index) => line.kind === 'gap'
                ? (expand.has(index)
                    ? null
                    : <Button key={index} type="button" className="dfg-dl-gap" aria-label={`展开 ${line.count} 行未变内容`} onClick={() => onExpand(index)}>
                        <span className="dfg-dl-gap-text">… {line.count} 行未变更</span></Button>)
                : <div key={index} className="dfg-dl-row" role="row" data-kind={line.kind}>
                    <span className="dfg-dl-no">{line.oldNo ?? ''}</span>
                    <span className="dfg-dl-no">{line.newNo ?? ''}</span>
                    <span className="dfg-dl-sign" aria-hidden="true">{SIGNS[line.kind]}</span>
                    <RowText row={line} />
                </div>)}
        </div>
    </>;
}

function EntryRow({ entry, depth, onOpen }: { entry: Entry; depth: number; onOpen: () => void }) {
    const { name } = splitPath(entry.path);
    return <Button type="button" className="dfg-git-row" aria-label={`查看差异 ${entry.path}`} onClick={onOpen}
        style={{ paddingInlineStart: `${4 + depth * 12}px` }}>
        <span className="dfg-git-letter" data-tone={statusTone(entry)} title={statusWords(entry)} aria-hidden="true">{statusLetter(entry)}</span>
        <span className="dfg-git-name">{name}</span>
        <span className="dfg-git-dir">{entry.origPath ? `← ${entry.origPath}` : ''}</span>
        {entry.binary ? <span className="dfg-git-counts">二进制</span>
            : entry.added !== null ? <span className="dfg-git-counts"><span className="dfg-git-add">+{entry.added}</span><span className="dfg-git-del">−{entry.removed ?? 0}</span></span>
                : null}
    </Button>;
}

/**
 * The Git page.
 *
 * better-sidebar ships a complete Git tab (stage, commit, push, branches, commit
 * graph, syntax-highlighted diff). Duplicating a weaker copy of it inside our own
 * five pages would be two Git UIs in one product, so this page's first job is the
 * door to that one: `openGitTab` activates it and the page reports what happened.
 *
 * The read-only view below stays as the fallback for a host whose Git tab is
 * disabled in settings or absent from this build — degradation, not duplication.
 */
export function GitPanel({ workspace, active, openGitTab }: { workspace: string; active: boolean; openGitTab?: () => boolean }) {
    const [delegated, setDelegated] = useState<'idle' | 'opened' | 'unavailable'>('idle');
    const [fallback, setFallback] = useState(openGitTab === undefined);
    // Opening on arrival is what "clicking Git goes there" means; the panel keeps a
    // manual button so a no-op (tab disabled) is not a dead end.
    //
    // Guarded by a ref, not by the callback's identity: better-sidebar's openTab
    // reduces its store SYNCHRONOUSLY, which re-renders this subtree. Re-running on
    // every pass would open, re-render, open again — the render loop that crashed.
    // One jump per entry is also the correct behaviour on its own terms.
    const jumped = useRef(false);
    useEffect(() => {
        if (!active || openGitTab === undefined) { jumped.current = false; return; }
        if (jumped.current) return;
        jumped.current = true;
        setDelegated(openGitTab() ? 'opened' : 'unavailable');
    }, [active, openGitTab]);
    if (!fallback) return <section className="dfg-git-delegated" aria-label="Git 委派">
        <h3>Git</h3>
        {delegated === 'opened'
            ? <p className="dfg-status">已切到 better-sidebar 的 Git 页。那边的状态、暂存、提交、推送、分支和提交图都在那里；本页不重复造一套。</p>
            : <>
                <p className="dfg-status">侧栏的 Git 页没有打开。它可能在设置里被禁用，或者这个版本没有内置 Git 分页。</p>
                <Button type="button" onClick={() => setDelegated(openGitTab() ? 'opened' : 'unavailable')}>再试一次</Button>
                <Button type="button" className="dfg-link" onClick={() => setFallback(true)}>改用插件的只读 Git 视图</Button>
            </>}
    </section>;
    return <ReadOnlyGit workspace={workspace} active={active} onDelegate={openGitTab === undefined ? undefined : () => setFallback(false)} />;
}

function ReadOnlyGit({ workspace, active, onDelegate }: { workspace: string; active: boolean; onDelegate?: () => void }) {
    const [repo, setRepo] = useState<Repo | null>(null);
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
    const [open, setOpen] = useState<string | null>(null), [diff, setDiff] = useState<Diff | null>(null);
    const [diffError, setDiffError] = useState(''), [diffBusy, setDiffBusy] = useState(false), [wrap, setWrap] = useState(false);
    // Directories start expanded: the point of the tree is the shape, not hidden work.
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [expandedGaps, setExpandedGaps] = useState<Set<number>>(() => new Set());
    const toggleGap = (index: number) => setExpandedGaps(old => {
        const next = new Set(old);
        if (next.has(index)) next.delete(index); else next.add(index);
        return next;
    });
    const toggle = (path: string) => setCollapsed(old => {
        const next = new Set(old);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
    });

    // 只在分页真正显示时读取：侧栏隐藏期间不做无用请求。
    useEffect(() => {
        if (!active || !workspace) return;
        const controller = new AbortController();
        setBusy(true); setError('');
        void jsonRequest<{ repo: Repo }>('/forge-git', new URLSearchParams({ workspace }).toString(), undefined, controller.signal)
            .then(p => { if (!controller.signal.aborted) { setRepo(p.repo); setOpen(null); setDiff(null); } })
            .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (!controller.signal.aborted) setBusy(false); });
        return () => controller.abort();
    }, [workspace, active, refresh]);

    useEffect(() => {
        if (open === null) { setDiff(null); return; }
        const controller = new AbortController();
        setDiffBusy(true); setDiffError(''); setDiff(null);
        void jsonRequest<{ diff: Diff }>('/forge-git', new URLSearchParams({ workspace, file: open }).toString(), undefined, controller.signal)
            .then(p => { if (!controller.signal.aborted) setDiff(p.diff); })
            .catch(e => { if (!controller.signal.aborted) setDiffError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (!controller.signal.aborted) setDiffBusy(false); });
        return () => controller.abort();
    }, [workspace, open]);

    if (!workspace) return <p className="dfg-status">还没有工作区；先在上方切换工作区。</p>;
    if (busy && !repo) return <p role="status" className="dfg-status">正在读取 Git 状态…</p>;
    if (error) return <>
        <p role="alert" className="dfg-error">{error}</p>
        <Button type="button" onClick={() => setRefresh(x => x + 1)}>重新读取</Button>
    </>;
    if (!repo) return <p className="dfg-status">尚未读取。</p>;
    if (!repo.isRepo) return <p className="dfg-status">此工作区不在 Git 仓库内。施工快照仍然可用，那里不依赖 Git。</p>;

    const note = diffNote(diff);
    if (open !== null) return <section className="dfg-git-diff" aria-label={`${open} 的 Git 差异`}>
        <div className="dfg-ledger-head">
            <Button type="button" className="dfg-link" onClick={() => setOpen(null)}>← 返回改动列表</Button>
            <span className="dfg-break">{open}</span>
        </div>
        <label className="dfg-inline"><input type="checkbox" checked={wrap} onChange={e => setWrap(e.target.checked)} />自动换行</label>
        {diffBusy ? <p role="status" className="dfg-status">正在读取两侧内容…</p> : null}
        {diffError ? <p role="alert" className="dfg-error">{diffError}</p> : null}
        {note}
        {diff !== null && note === null ? <>
            <p className="dfg-status">行号左为索引版本（上次提交/暂存），右为工作区；<span className="dfg-dl-sign" data-kind="add">+</span> 新增、<span className="dfg-dl-sign" data-kind="del">−</span> 删除、<span className="dfg-dl-sign" data-kind="mod">~</span> 改写（仅改写行标出行内变化）。</p>
            <DiffLines before={diff.before.text ?? ''} after={diff.after.text ?? ''} expand={expandedGaps} onExpand={toggleGap} />
        </> : null}
    </section>;

    const branch = repo.branch ?? { head: null, upstream: null, ahead: 0, behind: 0, detached: false, initial: false };
    const groups: Array<[string, Entry[]]> = [
        ['冲突', repo.conflicts ?? []],
        ['已暂存', repo.staged ?? []],
        ['工作区改动', repo.changes ?? []],
    ];
    const empty = groups.every(([, list]) => list.length === 0);
    return <section className="dfg-git" aria-label="Git 只读视图">
        <div className="dfg-git-head">
            <span className="dfg-git-branch" title={branch.upstream ?? undefined}>{branch.detached ? `游离 HEAD ${branch.head ?? ''}` : branch.head ?? '尚无提交'}</span>
            {branch.upstream ? <span className="dfg-git-upstream">↑{branch.ahead} ↓{branch.behind}</span> : null}
            <span className="dfg-git-head-spacer"/>
            <Button type="button" size="sm" disabled={busy} onClick={() => setRefresh(x => x + 1)}>刷新</Button>
        </div>
        {repo.remotes?.length ? <p className="dfg-status">远程：{repo.remotes.join('、')}</p> : null}
        {repo.prefix ? <p className="dfg-status">当前目录在仓库内为 {repo.prefix}；下方路径相对仓库根 {repo.toplevel}。</p> : null}
        <p className="dfg-status">只读视图：这里不暂存、不提交、不推送，也不改工作区文件。Git 历史与施工快照是两套独立记录。</p>
        {onDelegate ? <Button type="button" className="dfg-link" onClick={onDelegate}>改用 better-sidebar 的 Git 页</Button> : null}
        {empty ? <p className="dfg-status">工作区干净，没有未提交改动。</p> : groups.map(([label, list]) => list.length === 0 ? null : <div key={label} className="dfg-git-group">
            <div className="dfg-git-group-head"><span>{label}</span><span className="dfg-git-count-pill">{list.length}</span></div>
            {flattenVisible(buildChangeTree(list), path => !collapsed.has(path)).map(({ node, depth }) => node.kind === 'dir'
                ? <DirRow key={`${label}:dir:${node.path}`} node={node} depth={depth} open={!collapsed.has(node.path)} onToggle={() => toggle(node.path)} />
                : <EntryRow key={`${label}:${node.path}`} entry={node} depth={depth} onOpen={() => setOpen(node.path)} />)}
        </div>)}
        {!empty ? <p className="dfg-status">共 {repo.total ?? groups.reduce((n, [, list]) => n + list.length, 0)} 条改动记录；同一文件可能同时出现在已暂存与工作区。</p> : null}
    </section>;
}
