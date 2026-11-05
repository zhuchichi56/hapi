import { DecisionMetricsGroup } from './DecisionMetricsGroup';
import { ExecutorDailyGroup } from './ExecutorDailyGroup';
import { useMemo, useState } from 'react';
import { aggregateSystemMetrics, type MetricsData, type MetricsFilter, type Ratio, type Distribution } from './systemMetrics';
import './SystemMetricsView.css';

export interface SystemMetricsViewProps {
    data: MetricsData;
    /** Owned by the existing parent poll. This view never creates a fetch or timer. */
    refreshing?: boolean;
    onRefresh?: () => void;
    initialFilter?: MetricsFilter;
    /** Raw snapshot.executorDaily block, consumed as-is. */
    executorDaily?: unknown;
}
const number = (value: number | null) => value === null ? '—' : value.toLocaleString('zh-CN');
const percent = (value: Ratio) => value.value === null ? '—' : `${(value.value * 100).toFixed(1)}%`;
function duration(ms: number | null): string {
    if (ms === null) return '—';
    if (ms < 1_000) return `${ms.toFixed(0)} ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} 秒`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} 分钟`;
    return `${(ms / 3_600_000).toFixed(1)} 小时`;
}
const dateTime = (at: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(at));
function Missing({ children }: { children: React.ReactNode }) { return <span className="sm-missing">{children}</span>; }
function Sample({ metric }: { metric: Distribution }) { return <span>中位 {duration(metric.medianMs)} · P95 {duration(metric.p95Ms)} · N={metric.n} · 未配对 {metric.missing}</span>; }
const phaseNames: Record<string, string> = {
    lastProgressAge: '最近显式进展年龄', receivedToDispatch: '收到 → 派遣意图', dispatchToSent: '派遣 → 确认发送', sentToAck: '发送 → 公开承接', ackToFirstAction: '承接 → 首个动作',
    runToDelivery: '首个动作 → 交付记录', deliveryToAcceptance: '真实交付 → 目标验收', deliveryObservedToAcceptance: '采集记录交付 → 验收（观察延迟）', endToEnd: '收到 → 目标验收'
};
const waitNames = { approval: '审批', resource: '资源', external_input: '外部输入', other: '其他', unknown: '原因未知' };

/** Independent system page; filter state is local and all data belongs to the host. */
export function SystemMetricsView({ data, refreshing = false, onRefresh, initialFilter = { window: '24h' }, executorDaily }: SystemMetricsViewProps) {
    const [filter, setFilter] = useState<MetricsFilter>(initialFilter);
    const [allAnomalies, setAllAnomalies] = useState(false);
    const metrics = useMemo(() => aggregateSystemMetrics(data, filter), [data, filter]);
    const { current, dispatch, acceptance, todayUsage, freshness } = metrics;
    const change = (field: 'project' | 'executor', value: string) => setFilter(previous => {
        const next = { ...previous };
        if (value) next[field] = value; else delete next[field];
        return next;
    });
    const maxTrend = Math.max(1, ...metrics.trend.flatMap(day => [day.dispatchObserved ?? 0, day.goalAccepted ?? 0]));
    const visibleAnomalies = allAnomalies ? metrics.anomalies : metrics.anomalies.slice(0, 6);
    const missingTokens = todayUsage.input === null && todayUsage.output === null;
    return <main className="sm-page" aria-labelledby="sm-title">
        <header className="sm-header">
            <div className="sm-heading"><div className="sm-eyebrow"><span className="sm-mark" aria-hidden="true">▥</span> ORCHESTRA <span className="sm-divider">/</span> SYSTEM</div>
                <h1 id="sm-title">系统运行</h1><p>看清投入、流转与交付质量</p></div>
            <div className="sm-refresh"><span className={`sm-badge sm-${freshness.state}`}>{data.source === 'sanitized-sample' ? '离线真实样本' : '共享刷新'} · {freshness.state === 'fresh' ? '采集新鲜' : freshness.state === 'old' ? '数据已旧' : freshness.state === 'clock_error' ? '时钟异常' : '新鲜度缺测'}</span>
                <span className="sm-asof">截至 {dateTime(data.asOf)} · 上海</span>
                {onRefresh && <button className="sm-button" type="button" onClick={onRefresh} disabled={refreshing}>{refreshing ? '刷新中…' : '刷新'}</button>}</div>
        </header>
        <div className="sm-toolbar" aria-label="指标筛选">
            <div className="sm-segment" role="group" aria-label="滚动时间窗口">{(['24h', '7d'] as const).map(window => <button key={window} type="button" aria-pressed={filter.window === window} onClick={() => setFilter(previous => ({ ...previous, window }))}>{window === '24h' ? '近 24 小时' : '近 7 天'}</button>)}</div>
            <label>项目<select value={filter.project ?? ''} onChange={event => change('project', event.target.value)}><option value="">全部项目</option>{metrics.projectOptions.map(project => <option key={project} value={project}>{project === 'unknown' ? '未知项目' : project}</option>)}</select></label>
            <label>执行器<select value={filter.executor ?? ''} onChange={event => change('executor', event.target.value)}><option value="">全部执行器</option>{metrics.executorOptions.map(executor => <option key={executor} value={executor}>{executor === 'unknown' ? '未知执行器' : executor}</option>)}</select></label>
            <span className="sm-scope">{metrics.taskCount} 个当前任务 · {metrics.technical.eventsInWindow} 条窗口事件</span>
        </div>
        <aside className="sm-notice" role="status"><span aria-hidden="true">◷</span><div>{data.source === 'sanitized-sample' ? '真实元数据快照；时间固定，不随当前时钟变化。' : '复用宿主采集；历史只含当前快照可见的最近 50 条操作。'}<span> {metrics.technical.historyComplete ? '样本元数据完整；实际阶段时间与用量仍缺测。' : '窗口统计为局部观察，不能代表全部历史。'} 未知值用「—」表示。</span></div></aside>
        {data.errors.length > 0 && <p className="sm-error" role="alert">父级刷新或采集报告错误，以下保留最后可用数据。请使用宿主刷新入口核对。</p>}
        <section className="sm-cards" aria-label="系统概览">
            <article className="sm-card"><div className="sm-card-label">今日投入 <span>TOKENS</span></div><div className="sm-value">{number(todayUsage.total)}<small>{missingTokens ? '缺测' : '已覆盖投入'}</small></div>
                <p>输入 {number(todayUsage.input)} <i> / </i> 输出 {number(todayUsage.output)}</p><p>缓存 {number(todayUsage.cache)} <span className="sm-light">已含在输入中</span></p>
                <footer>{missingTokens ? <Missing>阶段用量未采集</Missing> : `阶段覆盖 ${todayUsage.coveredStages}/${number(todayUsage.expectedStages)} · ${percent(todayUsage.coverage)}`}</footer></article>
            <article className="sm-card"><div className="sm-card-label">任务端到端 <span>MEDIAN</span></div><div className="sm-value">{duration(metrics.efficiency.endToEnd!.medianMs)}</div>
                <p>P95 {duration(metrics.efficiency.endToEnd!.p95Ms)}</p><p>收到请求 → 目标验收</p><footer>N={metrics.efficiency.endToEnd!.n} · <Missing>{metrics.efficiency.endToEnd!.n ? '真实事件配对' : '收到请求时间缺测'}</Missing></footer></article>
            <article className="sm-card"><div className="sm-card-label">当前卡住 <span>NOW</span></div><div className="sm-value">{number(current.blocked)}<small>{current.blocked === null ? '覆盖不全' : '个'}</small></div>
                <p>已观察显式阻塞 {current.blockedObserved} · 最长 {duration(current.longestWaitMs)}</p><p>等待起点覆盖 {current.waitKnown}/{current.blockedObserved}</p><footer>仅显式阻塞 / 等待审批</footer></article>
            <article className="sm-card"><div className="sm-card-label">派发成功率 <span>发送</span></div><div className="sm-value">{percent(dispatch.success)}</div>
                <p>成功 {dispatch.succeeded} <i> / </i> 失败 {dispatch.failed}</p><p>结果未知 <strong>{dispatch.unknown}</strong> 次</p><footer>已知结果 {dispatch.success.denominator}/{dispatch.observed} · 绑定不证明发送</footer></article>
            <article className="sm-card"><div className="sm-card-label">交付验收通过率 <span>GOAL</span></div><div className="sm-value">{percent(acceptance.pass)}</div>
                <p>{acceptance.pass.numerator}/{acceptance.pass.denominator} 个已绑定交付决策</p><p>观察到接受 {acceptance.uniqueGoalsAccepted} 个不同目标</p><footer>另有 {acceptance.unbound} 条未绑定 · 当前已验收 {number(current.accepted)}</footer></article>
        </section>
        <DecisionMetricsGroup data={data} filter={filter} />
        {executorDaily !== undefined && <ExecutorDailyGroup source={executorDaily} filter={filter} windowStart={metrics.start} asOf={metrics.asOf} />}
        <div className="sm-main-grid">
            <section className="sm-panel sm-trend" aria-labelledby="sm-trend-title"><div className="sm-panel-head"><div><h2 id="sm-trend-title">每日流转</h2><p>账本事件 · 上海自然日 · 所选滚动窗口</p></div><span className="sm-small-badge">{metrics.technical.historyCoverage.completeFamilies.length ? '按事件族声明覆盖' : '日覆盖未知'}</span></div>
                <div className="sm-legend"><span><i className="sm-key-dispatch" />派遣意图</span><span><i className="sm-key-accept" />首次观察接受</span></div>
                <div className="sm-chart" role="img" aria-label="按天显示派遣意图和首次观察接受数量，精确数据见下表">
                    {metrics.trend.map(day => <div className="sm-chart-day" key={day.day}><div className="sm-bars">{([['dispatchObserved', 'dispatch'], ['goalAccepted', 'accept']] as const).map(([field, style]) => <div key={field} className="sm-bar-slot"><span>{number(day[field])}</span><div className={`sm-bar sm-bar-${style}`} style={{ height: day[field] === null ? 0 : `${Math.max(1, day[field]! / maxTrend * 132)}px` }} /></div>)}</div><span className="sm-chart-date">{day.day.slice(5).replace('-', '/')}</span></div>)}
                </div>
                <table className="sm-trend-table"><caption className="sm-sr-only">每日事件精确值</caption><thead><tr><th>日期</th><th>派遣</th><th>首次观察接受</th><th>拒绝交付</th><th>会话验收</th></tr></thead><tbody>{metrics.trend.map(day => <tr key={day.day}><th>{day.day.slice(5)}</th><td>{number(day.dispatchObserved)}</td><td>{number(day.goalAccepted)}</td><td>{number(day.goalRejected)}</td><td>{number(day.sessionReviews)}</td></tr>)}</tbody></table>
                <p className="sm-footnote">历史采集覆盖起点：{metrics.technical.historyCoverage.startAt ? dateTime(metrics.technical.historyCoverage.startAt) : '未知'}。正数为已观察账本事件；没有整日覆盖证据的空白日显示「—」。会话验收独立列出。重复接受不新增完成目标；历史接受不证明当前目标完成。</p>
            </section>
            <section className="sm-panel" aria-labelledby="sm-anomaly-title"><div className="sm-panel-head"><div><h2 id="sm-anomaly-title">需要核对</h2><p>显式异常与数据缺口 · 不干预运行任务</p></div><span className="sm-count">{metrics.anomalies.length}</span></div>
                <ul className="sm-anomalies">{visibleAnomalies.map(item => <li key={item.id} className={`sm-anomaly sm-anomaly-${item.tone}`}><span className="sm-anomaly-dot" aria-hidden="true" /><div><div className="sm-anomaly-title">{item.taskId && (item.href ? <a href={item.href}>{item.taskId} ↗</a> : <strong>{item.taskId}</strong>)}<span>{item.label}</span></div><p>{item.action}</p></div></li>)}</ul>
                {metrics.anomalies.length === 0 && <p className="sm-empty">可见数据中未观察到需核对项；缺少历史仍不能证明系统无异常。</p>}
                {metrics.anomalies.length > 6 && <button type="button" className="sm-show-more" onClick={() => setAllAnomalies(value => !value)}>{allAnomalies ? '收起' : `查看全部 ${metrics.anomalies.length} 项`}</button>}
            </section>
        </div>
        <details className="sm-details"><summary>技术口径与覆盖 <span>阶段耗时 · usage · 数据边界</span></summary><div className="sm-detail-grid">
            <section><h3>阶段耗时</h3><dl className="sm-definitions">{Object.entries(metrics.efficiency).map(([name, value]) => <div key={name}><dt>{phaseNames[name]}</dt><dd><Sample metric={value} />{value.clocks.length > 0 && <small>时钟：{value.clocks.join(', ')}；ledger 为记录时刻</small>}</dd></div>)}</dl></section>
            <section><h3>当前状态 / 窗口决策</h3><dl className="sm-definitions"><div><dt>当前目标已验收</dt><dd>{number(current.accepted)} · 已证实 {current.acceptedVerified} · 无法核验 {current.acceptanceUnknown}</dd></div><div><dt>归档 / 取消</dt><dd>{current.archived} / {current.cancelled} · 不据此计为解决</dd></div><div><dt>已观察陈旧运行 / 运行新鲜度缺测</dt><dd>{current.staleRunning} / {current.runningFreshnessUnknown}</dd></div><div><dt>重试 / 重复派遣</dt><dd>{number(dispatch.retries)} / {number(dispatch.duplicates)}</dd></div><div><dt>已知起点最长等待</dt><dd>{duration(current.longestObservedWaitMs)} · N={current.waitKnown}</dd></div><div><dt>首次通过率 / 返工</dt><dd>{acceptance.firstPass ? percent(acceptance.firstPass) : '—'} / {number(acceptance.rework)} · 需要完整验收历史</dd></div><div><dt>成果实际访问率</dt><dd>{acceptance.artifactAccess ? `${percent(acceptance.artifactAccess)} · N=${acceptance.artifactAccess.denominator}` : '— · 无实际探测'} · 应探测 {number(acceptance.artifactExpected)}</dd></div></dl></section>
            <section><h3>投入与等待</h3><dl className="sm-definitions"><div><dt>窗口 input / output / cache</dt><dd>{number(metrics.usage.input)} / {number(metrics.usage.output)} / {number(metrics.usage.cache)}</dd></div><div><dt>阶段覆盖 / input / output / cache</dt><dd>{metrics.usage.coveredStages}/{number(metrics.usage.expectedStages)} · {percent(metrics.usage.fieldCoverage.input)} / {percent(metrics.usage.fieldCoverage.output)} / {percent(metrics.usage.fieldCoverage.cache)}</dd></div><div><dt>被排除 usage meter</dt><dd>{metrics.usage.excludedMeters} · 阶段、覆盖或时间边界不匹配</dd></div>{Object.entries(metrics.waits).map(([reason, value]) => <div key={reason}><dt>{waitNames[reason as keyof typeof waitNames]}等待</dt><dd>{duration(value.durationMs)} · N={value.n}</dd></div>)}</dl></section>
            <section><h3>采集证据</h3><dl className="sm-definitions"><div><dt>采集成功年龄 / 快照年龄</dt><dd>{duration(freshness.ageMs)} / {duration(freshness.snapshotAgeMs)}</dd></div><div><dt>最近源观察 / poll 年龄 / 连接</dt><dd>{duration(freshness.lastObservedAgeMs)} / {duration(freshness.lastPollAgeMs)} / {freshness.connected === null ? '—' : freshness.connected ? '已连接' : '断开'}</dd></div><div><dt>已观察 operations / 在线上限</dt><dd>{metrics.technical.operationsObserved} / {number(metrics.technical.operationLimit)} · {metrics.technical.historyComplete ? '离线元数据样本完整' : '在线历史不完整'}</dd></div><div><dt>历史采集覆盖起点 / 终点</dt><dd>{metrics.technical.historyCoverage.startAt ? dateTime(metrics.technical.historyCoverage.startAt) : '未知'} / {metrics.technical.historyCoverage.endAt ? dateTime(metrics.technical.historyCoverage.endAt) : '未知'} · 事件族 {metrics.technical.historyCoverage.completeFamilies.join(', ') || '未证明日覆盖'}</dd></div><div><dt>事件去重 / 冲突 / 非法时间</dt><dd>{metrics.technical.duplicateEvents} / {metrics.technical.conflictingIds} / {metrics.technical.invalidEvents}</dd></div><div><dt>TTFT / 显式错误事件</dt><dd>— / {number(metrics.technical.explicitErrors)}</dd></div><div><dt>重连恢复</dt><dd><Sample metric={metrics.technical.recovery} /></dd></div></dl><p className="sm-footnote">同阶段、同关联键、同可比较时钟才配对。陈旧不等于卡住；缓存包含于输入。未知项目/执行器不从任务名推断。</p></section>
        </div></details>
        <footer className="sm-page-footer"><span>窗口 {dateTime(metrics.start)} → {dateTime(metrics.asOf)}</span><span>Asia/Shanghai · {data.source === 'sanitized-sample' ? '离线预览 · 未部署' : '元数据统计'}</span></footer>
    </main>;
}
