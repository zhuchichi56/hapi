import { useMemo, useState } from 'react';
import { dailyOptions, dimensions, filterDaily, groupView, parseExecutorDaily, UNKNOWN, type DailyDimension, type DailyFilter } from './executorDaily';
import type { MetricsFilter } from './systemMetrics';

const n = (v: number | null) => v === null ? '未知' : v.toLocaleString('zh-CN');
const ms = (v: number | null) => v === null ? '未知' : v < 1000 ? `${v.toFixed(0)} ms` : v < 60_000 ? `${(v / 1000).toFixed(1)} 秒` : `${(v / 60_000).toFixed(1)} 分钟`;
const when = (v: string | null) => { const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? '未知' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)); };
const age = (from: string | null, to: string) => { const a = from ? Date.parse(from) : NaN; const b = Date.parse(to); if (Number.isNaN(a) || Number.isNaN(b) || b < a) return '未知'; const h = (b - a) / 3_600_000; return h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`; };
const labels: Record<DailyDimension, [string, string]> = { executor: ['执行器', '全部执行器'], model: ['模型', '全部模型'], provider: ['线路', '全部线路'], taskType: ['任务类型', '全部任务类型'] };
const phase: Record<string, string> = { runner_total: '运行总墙钟', queue: '排队', dispatch: '派遣', startup: '启动', first_response: '首响应', model: '模型', tool: '工具', delivery: '交付', acceptance: '验收', dependency_wait: '依赖等待', page_api: '页面接口', page_render: '页面渲染' };
const ratio = (x: { passed: number | null; tasks: number | null }) => x.tasks === null || x.passed === null ? '未知' : `${x.passed}/${x.tasks}`;

/** Consumes the existing snapshot.executorDaily; reuses the page's rolling window and adds no fetch or timer. */
export function ExecutorDailyGroup({ source, filter, windowStart, asOf }: { source: unknown; filter: MetricsFilter; windowStart: string; asOf: string }) {
    const daily = useMemo(() => parseExecutorDaily(source), [source]);
    const [sel, setSel] = useState<DailyFilter>({});
    const days = useMemo(() => daily ? filterDaily(daily, windowStart, asOf, sel) : [], [daily, windowStart, asOf, sel]);
    const change = (dim: DailyDimension, value: string) => setSel(prev => { const next = { ...prev }; if (value) next[dim] = value; else delete next[dim]; return next; });
    if (!daily) return <section className="sm-panel sm-daily" aria-labelledby="sm-daily-title"><div className="sm-panel-head"><div><h2 id="sm-daily-title">每日执行器</h2><p>当前快照未提供 executorDaily · 不推断</p></div><span className="sm-small-badge">未接入</span></div></section>;
    const cov = daily.coverage; const cur = daily.current; const curTasks = (cur.tasks ?? {}) as Record<string, unknown>;
    const groupCount = days.reduce((s, d) => s + d.groups.length, 0);
    return <section className="sm-panel sm-daily" aria-labelledby="sm-daily-title">
        <div className="sm-panel-head"><div><h2 id="sm-daily-title">每日执行器</h2><p>按日期、执行器、模型和线路查看</p></div><span className="sm-small-badge">历史有限样本</span></div>
        <p className="sm-footnote" data-testid="daily-source">源生成 <time dateTime={daily.generatedAt ?? undefined} title={daily.generatedAt ?? undefined}>{when(daily.generatedAt)}</time>（距今 {age(daily.generatedAt, asOf)}）· 源截至 <time dateTime={typeof cur.asOf === 'string' ? cur.asOf : undefined} title={typeof cur.asOf === 'string' ? cur.asOf : undefined}>{when(typeof cur.asOf === 'string' ? cur.asOf : null)}</time></p>
        <details className="sm-daily-coverage"><summary>覆盖范围与缺测</summary><p className="sm-footnote">事件 {n(typeof cov.includedEvents === 'number' ? cov.includedEvents : null)}/{n(typeof cov.inputEvents === 'number' ? cov.inputEvents : null)}（{when(typeof cov.firstEventAt === 'string' ? cov.firstEventAt : null)} → {when(typeof cov.lastEventAt === 'string' ? cov.lastEventAt : null)}）· 交付 {n(typeof curTasks.delivered === 'number' ? curTasks.delivered : null)} / 失败 {n(typeof curTasks.failed === 'number' ? curTasks.failed : null)} / 未知 {n(typeof curTasks.unknown === 'number' ? curTasks.unknown : null)} / 进行中 {n(typeof curTasks.active === 'number' ? curTasks.active : null)}。仅含历史小任务与宿主观察，不代表全量、稳定均值或当前模型速度；未更新不表示任务卡死。</p></details>
        <div className="sm-toolbar sm-daily-filters" aria-label="每日执行器筛选">{dimensions.map(dim => { const o = dailyOptions(daily, dim); return <label key={dim}>{labels[dim][0]}<select value={sel[dim] ?? ''} onChange={e => change(dim, e.target.value)}><option value="">{labels[dim][1]}</option>{o.values.map(v => <option key={v} value={v}>{v}</option>)}{o.hasUnknown && <option value={UNKNOWN}>未知</option>}</select></label>; })}</div>
        {days.length === 0 ? <p className="sm-empty">所选窗口（{filter.window === '7d' ? '近 7 天' : '近 24 小时'}）内没有 daily 日期；daily 源为历史数据，可切换到更长窗口查看。</p>
            : groupCount === 0 ? <p className="sm-empty">当前筛选下没有分组。</p>
            : days.map(day => day.groups.length > 0 && <div key={day.date} className="sm-daily-day"><h3>{day.date} · {day.groups.length} 个分组</h3>
                <div className="sm-daily-cards">{day.groups.map(g => { const v = groupView(g); const d = g.dimensions; const k = `${day.date}|${d.executor}|${d.model}|${d.provider}|${d.taskType}`;
                    return <details key={k} className="sm-daily-card"><summary><strong>{d.executor ?? '未知执行器'}</strong> <span>{d.model ?? '未知模型'} · {d.provider ?? '未知线路'} · {d.taskType ?? '未知类型'}</span>
                        <small>{v.cohort.started === 0 ? '无启动任务（宿主观察）' : `启动 ${n(v.cohort.started)} · 交付 ${n(v.cohort.delivered)} · 失败 ${n(v.cohort.failed)}`}{v.cohort.started === 1 ? ' · N=1 不排名' : ''}</small></summary>
                        <dl className="sm-definitions">
                            <div><dt>任务</dt><dd>启动 {n(v.cohort.started)} · 交付 {n(v.cohort.delivered)} · 失败 {n(v.cohort.failed)} · 进行中 {n(v.cohort.active)} · 状态未知 {n(v.cohort.unknown)}</dd></div>
                            <div><dt>Token（按源）</dt><dd>input {n(v.tokens.input)}（含 cache {n(v.tokens.cache)}，cache 已包含在 input 内，不可相加）· output {n(v.tokens.output)} · total {n(v.tokens.total)}<small>覆盖 {n(v.tokens.coveredTasks)}/{n(v.tokens.eligibleTasks)} 任务；缺测显示「未知」，不当作 0</small></dd></div>
                            <div><dt>独立验收</dt><dd>终审通过 {ratio(v.review.final)} · 首审通过 {ratio(v.review.first)} · 非独立排除 {n(v.review.nonIndependentExcluded)} · 待审排除 {n(v.review.pendingExcluded)}</dd></div>
                            <div><dt>墙钟</dt><dd>{v.timing.length === 0 ? '无样本（未知）' : v.timing.map(t => <span key={t.name} className="sm-daily-timing">{phase[t.name] ?? t.name}：{t.n === 1 ? `单样本 ${ms(t.medianMs)}（N=1，不作均值/排名）` : `中位 ${ms(t.medianMs)} · P95 ${ms(t.p95Ms)} · N=${t.n}`}</span>)}</dd></div>
                        </dl></details>; })}</div></div>)}
    </section>;
}
