import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppContext } from '@/lib/app-context';
import { useOrchestraSnapshot } from '../useOrchestraSnapshot';
import { normalizeOrchestraSnapshot } from './snapshotAdapter';
import { SystemMetricsView } from './SystemMetricsView';
import type { MetricEvent } from './systemMetrics';

type ReportState = { loading: boolean; content: string | null; error: boolean };
/** Exactly one existing shared snapshot hook is mounted by the route switch. */
export function SystemMetricsPage() {
    const { token, baseUrl } = useAppContext();
    const { snapshot, connection, refreshing, load } = useOrchestraSnapshot();
    const [report, setReport] = useState<ReportState>({ loading: false, content: null, error: false });
    const [probe, setProbe] = useState<MetricEvent | null>(null);
    // Evaluation time, never an inferred lifecycle event or first-token timestamp.
    const asOf = new Date().toISOString();
    const data = useMemo(() => {
        const normalized = normalizeOrchestraSnapshot(snapshot, { asOf, refreshFailed: connection === 'offline' });
        if (probe) normalized.events.push(probe);
        return normalized;
    }, [snapshot, asOf, connection, probe]);
    const [daily, setDaily] = useState<ReportState & { name: string | null }>({ loading: false, content: null, error: false, name: null });
    /** Daily report is registered T021 index 1; read in full with the same auth and no probe side effects. */
    async function openDailyReport() {
        if (daily.loading) return;
        setDaily({ loading: true, content: null, error: false, name: null });
        try {
            const path = '/api/orchestra/artifact?task=T021&index=1';
            const url = baseUrl ? new URL(path, baseUrl).toString() : path;
            const response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw Error('artifact unavailable');
            const value: unknown = await response.json();
            if (!value || typeof value !== 'object' || !('content' in value) || typeof value.content !== 'string' || value.content.trim() === '' || value.content.length > 262144) throw Error('artifact invalid');
            const name = 'name' in value && typeof value.name === 'string' ? value.name : null;
            setDaily({ loading: false, content: value.content, error: false, name });
        } catch { setDaily({ loading: false, content: null, error: true, name: null }); }
    }
    async function openReport() {
        if (report.loading) return;
        setReport({ loading: true, content: null, error: false });
        let accessible = false;
        try {
            const path = '/api/orchestra/artifact?task=T021&index=0';
            const url = baseUrl ? new URL(path, baseUrl).toString() : path;
            const response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(4000) });
            if (!response.ok) throw Error('artifact unavailable');
            const value: unknown = await response.json();
            if (!value || typeof value !== 'object' || !('content' in value) || typeof value.content !== 'string' || value.content.length > 262144) throw Error('artifact invalid');
            accessible = true;
            setReport({ loading: false, content: value.content, error: false });
        } catch { setReport({ loading: false, content: null, error: true }); }
        setProbe({ id: 'artifact-probe:T021:0', taskId: 'T021', goalId: 'T021', stageId: null, correlationId: null, kind: 'artifact_probe', artifactId: '0', accessible, at: new Date().toISOString(), clock: 'browser-artifact-response' });
    }
    return <div className="os-system-page">
        <section className="os-evidence" aria-label="系统页交付成果">
            <button type="button" className="sm-button" disabled={report.loading} onClick={() => void openReport()}>{report.loading ? '读取报告…' : '打开系统页交付报告'}</button>
            <span>使用当前登录读取已登记成果；访问结果计入本页探测，重复读取不累加。</span>
            {report.error && <p role="alert">报告暂不可访问，请重试。</p>}
            <button type="button" className="sm-button" disabled={daily.loading} onClick={() => void openDailyReport()}>{daily.loading ? '读取每日报告…' : '打开每日执行器报告'}</button>
            {daily.error && <p role="alert">每日执行器报告暂不可访问，请重试。</p>}
            {daily.content !== null && <details open><summary>每日执行器报告{daily.name ? ` · ${daily.name}` : ''}</summary><div className="os-report" data-testid="daily-report"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children }) => <span>{children}</span> }}>{daily.content}</ReactMarkdown></div></details>}
            {report.content !== null && <details open><summary>交付报告</summary><div className="os-report"><ReactMarkdown skipHtml components={{ a: ({ children }) => <span>{children}</span> }}>{report.content}</ReactMarkdown></div></details>}
        </section>
        {snapshot ? <SystemMetricsView data={data} executorDaily={(snapshot as { executorDaily?: unknown }).executorDaily ?? null} refreshing={refreshing} onRefresh={() => void load(true)} /> : <section className="os-loading" role="status">{connection === 'offline' ? '系统数据暂不可用' : '正在读取系统数据…'}<button type="button" onClick={() => void load()} disabled={refreshing}>刷新</button></section>}
    </div>;
}
