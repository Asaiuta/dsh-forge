import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { jsonRequest } from './project-panel';
interface Page {
    node: string; file: string; side: 'before' | 'after'; hash: string | null;
    status: 'text' | 'absent' | 'binary' | 'unreadable'; bytes: number; total: number;
    offset: number; nextOffset: number | null; text?: string;
}
function SnapshotSide({ workspace, node, side, wrap }: { workspace: string; node: string; side: 'before' | 'after'; wrap: boolean }) {
    const [offset, setOffset] = useState(0), [previous, setPrevious] = useState<number[]>([]);
    const [page, setPage] = useState<Page | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const identity = useRef('');
    const key = `${workspace}:${node}:${side}`;
    useEffect(() => { setOffset(0); setPrevious([]); setPage(null); }, [key]);
    useEffect(() => {
        const controller = new AbortController(); identity.current = key;
        setBusy(true); setError(''); setPage(null);
        void jsonRequest<{ snapshot: Page }>('/forge-ledger', new URLSearchParams({ workspace, node, side, offset: String(offset), limit: '32768' }).toString(), undefined, controller.signal)
            .then(p => { if (!controller.signal.aborted && identity.current === key) setPage(p.snapshot); })
            .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (!controller.signal.aborted) setBusy(false); });
        return () => controller.abort();
    }, [key, offset]);
    return <section className="dfg-snapshot-side" aria-label={`${side} 完整快照`}>
        <h3>{side === 'before' ? '改动前' : '改动后'}</h3>
        {busy ? <p role="status">加载快照页…</p> : null}
        {error ? <p role="alert" className="dfg-error">{error}</p> : null}
        {page ? <>
            <p className="dfg-status dfg-break">{page.bytes} 字节 · {page.hash ?? '不存在'}</p>
            {page.status === 'text' ? <>
                <p className="dfg-status">字符 {page.offset}–{page.offset + (page.text?.length ?? 0)} / {page.total} · 按页阅读，无静默截断</p>
                <pre className={`dfg-diff${wrap ? ' dfg-wrap' : ''}`}>{page.text || '（空文件）'}</pre>
            </> : <p className={page.status === 'unreadable' ? 'dfg-error' : 'dfg-status'}>{page.status === 'absent' ? '该版本文件不存在' : page.status === 'binary' ? '二进制或非 UTF-8 快照，不按文本显示' : '快照缺失或校验失败，无法读取'}</p>}
            <nav className="dfg-actions" aria-label={`${side} 快照分页`}>
                <Button type="button" aria-label={`${side} 快照上一页`} disabled={busy || !previous.length} onClick={() => { setOffset(previous[previous.length - 1]); setPrevious(p => p.slice(0, -1)); }}>上一页</Button>
                <Button type="button" aria-label={`${side} 快照下一页`} disabled={busy || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) { setPrevious(p => [...p, offset]); setOffset(page.nextOffset); } }}>下一页</Button>
            </nav>
        </> : null}
    </section>;
}
export function SnapshotCompare({ workspace, node }: { workspace: string; node: string }) {
    const [wrap, setWrap] = useState(false);
    return <section className="dfg-snapshot" aria-label={`节点 ${node} 完整快照对比`}>
        <label className="dfg-inline"><input type="checkbox" checked={wrap} onChange={e => setWrap(e.target.checked)} />自动换行</label>
        <p className="dfg-status">两栏为原始完整快照的分页视图，保留原换行与 BOM；不是增删行对齐视图。</p>
        <div className="dfg-snapshot-columns">
            <SnapshotSide workspace={workspace} node={node} side="before" wrap={wrap} />
            <SnapshotSide workspace={workspace} node={node} side="after" wrap={wrap} />
        </div>
    </section>;
}
