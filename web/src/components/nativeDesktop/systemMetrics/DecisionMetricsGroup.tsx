import { useMemo } from 'react';
import { aggregateDecisionMetrics, type DecisionStatus } from './decisionMetrics';
import type { MetricsData, MetricsFilter } from './systemMetrics';
const n = (value: number | null) => value === null ? '—' : value.toLocaleString('zh-CN');
const span = (ms: number | null) => ms === null ? '—' : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} 分钟` : `${(ms / 3_600_000).toFixed(1)} 小时`;
const when = (value: string | null) => value === null ? '—' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const authorities = { controller: '总控可决定', user: '待用户', external: '待外部', unknown: '归属未知' };
const statuses: Record<DecisionStatus, string> = { pending: '待决策', decided: '已决定，待执行回执', action_confirmed: '执行已回执，待独立核验', verified: '已独立核验', revoked: '已撤销', unknown: '状态证据缺测' };
export function DecisionMetricsGroup({ data, filter }: { data: MetricsData; filter: MetricsFilter }) {
    const m = useMemo(() => aggregateDecisionMetrics(data.decisions, data.asOf, filter, data.tasks), [data, filter]);
    return <section className="sm-panel sm-decisions" aria-labelledby="sm-decision-title">
        <div className="sm-panel-head"><div><h2 id="sm-decision-title">决策闭环</h2><p>{m.collected ? `统计起点 ${when(m.statisticsStartAt)} · 当前覆盖${m.currentComplete ? '完整' : '不全'} · 窗口历史${m.windowComplete ? '完整' : '不全'}` : '尚未采集决策记录 · 统计起点未知 · 覆盖未知'}</p></div><span className="sm-small-badge">{m.collected ? m.freshness === 'fresh' ? '按事项去重' : m.freshness === 'old' ? '决策数据已旧' : m.freshness === 'clock_error' ? '决策时钟异常' : '决策新鲜度缺测' : '未采集'}</span></div>
        <div className="sm-decision-overview">
            <div><span>已决策 <small>所选窗口</small></span><strong>{n(m.decided)}</strong><p>{m.collected ? m.firstDecisionTimeKnown ? `已观察 ${n(m.decidedObserved)} 个不同事项` : '首次决定时间契约待核实' : '缺少真实决策记录'}</p></div>
            <div><span>待决策 <small>当前</small></span><strong>{n(m.pending)}</strong><p>最长待决等待 {span(m.pendingLongestWaitMs)}</p></div>
            <div><span>决定后未落实 <small>当前</small></span><strong>{n(m.actionPending)}</strong><p>{m.collected ? `待执行 ${n(m.awaitingExecution)} · 待核验 ${n(m.awaitingVerification)}` : '决定、执行与核验分别记录'}</p></div>
        </div>
        <details className="sm-decision-details"><summary>事项与决策口径 <span>责任人 · 下一步 · 期限</span></summary>
            {!m.collected ? <p className="sm-footnote">决策数据接入后显示待决问题、责任人和期限。普通通知不计决策；同一事项的回执与修订不增加决策次数。计数不代表有效性。</p> : <>
                <div className="sm-decision-facts"><span>总控可决定 {n(m.waiting.controller)}</span><span>待用户 {n(m.waiting.user)}</span><span>待外部 {n(m.waiting.external)}</span><span>归属未知 {n(m.waiting.unknown)}</span><span>未解决事项最长年龄 {span(m.longestWaitMs)}</span><span>超期 {n(m.overdue)}（已观察 {m.overdueObserved}）</span><span>已独立核验 {n(m.verified)}</span><span>当前未撤销且已决定 {n(m.currentlyEffective)}</span></div>
                <p className="sm-footnote">决策时延 P50 {span(m.decisionLatency.medianMs)} · P95 {span(m.decisionLatency.p95Ms)} · N={m.decisionLatency.n} · 缺测 {m.decisionLatency.missing}。返工事项 {n(m.rework)} · 撤销事项 {n(m.revoked)}。这些是事项计数，不代表决定有效。</p>
                <ul className="sm-decision-items">{m.items.map(item => <li key={item.decisionId}><div className="sm-decision-item-title">{item.href ? <a href={item.href}>{item.taskId} ↗</a> : <strong>{item.taskId}</strong>}<span>{statuses[item.status]}</span>{item.overdue === true && <em>已超期</em>}</div>
                    <p>{item.question ?? '待决问题缺测'}</p><p>下一步：{item.nextAction ?? '缺测'}</p><small>{authorities[item.waitingOn ?? item.authority ?? 'unknown']} · 责任人 {item.owner ?? '未知'} · 期限 {when(item.dueAt)} · 当前待决等待 {span(item.waitMs)} · 未解决事项年龄 {span(item.issueAgeMs)}</small></li>)}</ul>
                <p className="sm-footnote">决策快照 {when(m.generatedAt)}。统计仅从已记录起点开始，不回填推断历史。状态由真实决定、执行回执与独立核验时间分别证明。去重/修订 {m.duplicates} · 冲突 {m.conflicts} · 排除普通通知 {m.notificationsExcluded} · 排除测试记录 {m.testRecordsExcluded} · 无法核验 {m.unknownRecords}。</p>
            </>}
        </details>
    </section>;
}
