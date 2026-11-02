import type { DecisionData } from './decisionMetrics';
/** Pure, deterministic T021 aggregation. No clock reads, I/O, timers or usage scraping. */
export const DAY_MS = 86_400_000;
export const UNKNOWN = 'unknown';
export type WindowKey = '24h' | '7d';
export type WaitReason = 'approval' | 'resource' | 'external_input' | 'other' | 'unknown';
export type EventKind = 'received' | 'dispatch' | 'sent' | 'ack' | 'first_action' | 'progress' |
    'delivery' | 'delivery_observed' | 'review' | 'wait_start' | 'wait_end' | 'artifact_probe' | 'error' | 'disconnect' | 'recovery';
export interface MetricEvent {
    id: string;
    taskId: string;
    goalId: string;
    stageId: string | null;
    correlationId: string | null;
    at: string;
    clock: string;
    kind: EventKind;
    turnId?: string | null;
    scope?: 'goal' | 'stage' | 'session';
    goalAuthority?: boolean;
    result?: 'accepted' | 'rejected' | null;
    sendStatus?: 'succeeded' | 'failed' | 'unknown';
    retryOf?: string | null;
    duplicateOf?: string | null;
    waitReason?: WaitReason;
    incidentId?: string | null;
    artifactId?: string | null;
    accessible?: boolean | null;
}
export interface MetricTask {
    id: string;
    goalId: string;
    project: string | null;
    executor: string | null;
    href: string | null;
    execution: string | null;
    review: string | null;
    archive: string | null;
    stateAt: string | null;
    observedAt: string | null;
    lastProgressAt: string | null;
    waitingOnApproval: boolean | null;
    waitSince: string | null;
    sourceTurnId: string | null;
    deliveryTurnId: string | null;
    acceptedTurnId: string | null;
    turnStatus: string | null;
    /** Only the ledger task row can assert goal review, never a session or presentation. */
    goalAuthority: boolean;
}
export interface UsageStage {
    taskId: string;
    stageId: string;
    phaseId: string;
    /** Complete meter list from T016, required to claim full per-stage field coverage. */
    expectedMeterIds?: string[];
    startedAt?: string;
    endedAt?: string | null;
}
/** T016 supplies stage attributable cumulative meters, NOT whole-chat counters.
 * Each independent meter has one stable id, one origin, one stage and one clock.
 * A reset requires a new meter id. A later snapshot replaces earlier snapshots.
 * Values apply exactly to [periodStart, periodEnd], not to observedAt.
 */
export interface StageUsageSnapshot extends UsageStage {
    id: string;
    meterId: string;
    observedAt: string;
    periodStart: string;
    periodEnd: string;
    clock: string;
    source: string;
    model: string;
    coverageKnown: boolean;
    input: number | null;
    output: number | null;
    cache: number | null; // subset of input
}
export interface UsageAdapter {
    expectedStages: UsageStage[] | null;
    /** true only if the expected-stage list covers the entire requested window. */
    expectedStagesComplete: boolean;
    snapshots: StageUsageSnapshot[];
}
export type HistoryEventFamily = 'dispatch' | 'goal_review' | 'session_review';
/** Authoritative instrumentation coverage, independent of retained-ledger completeness.
 * Unknown boundaries must remain null; restart/import timestamps are not evidence.
 */
export interface HistoricalEventCoverage {
    startAt: string | null;
    endAt: string | null;
    completeFamilies: HistoryEventFamily[];
}
export interface MetricsData {
    asOf: string;
    generatedAt: string | null;
    source: 'snapshot' | 'sanitized-sample' | 'normalized';
    tasks: MetricTask[];
    events: MetricEvent[];
    usage: UsageAdapter | null;
    decisions?: DecisionData | null;
    collector: {
        lastSuccessAt: string | null;
        lastObservedAt: string | null;
        lastPollAt?: string | null;
        connected: boolean | null;
        stale: boolean | null;
    };
    coverage: {
        tasksComplete: boolean;
        historyComplete: boolean;
        historyCoverage?: HistoricalEventCoverage;
        reviewHistoryComplete: boolean;
        operationLimit: number | null;
        operationsObserved: number;
        artifactsExpected: number | null;
        dispatchRelationsComplete?: boolean;
        errorEventsComplete?: boolean;
    };
    /** Safe fixed codes only, never raw server errors. */
    errors: string[];
    diagnostics: string[];
}
export interface MetricsFilter { window: WindowKey; project?: string; executor?: string }
export interface Distribution { medianMs: number | null; p95Ms: number | null; n: number; missing: number; clocks: string[] }
export interface Ratio { value: number | null; numerator: number; denominator: number }
export interface UsageMetric {
    input: number | null; output: number | null; cache: number | null; total: number | null;
    expectedStages: number | null;
    coveredStages: number;
    coverage: Ratio;
    fieldCoverage: Record<'input' | 'output' | 'cache', Ratio>;
    excludedMeters: number;
    sources: string[];
    models: string[];
}
export interface Anomaly { id: string; taskId: string | null; tone: 'warning' | 'muted'; label: string; action: string; href: string | null }
export interface DailyTrend { day: string; dispatchObserved: number | null; goalAccepted: number | null; goalRejected: number | null; sessionReviews: number | null; coverage: Record<HistoryEventFamily, boolean> }
export interface SystemMetrics {
    asOf: string; start: string; filter: MetricsFilter;
    taskCount: number; projectOptions: string[]; executorOptions: string[];
    current: { blocked: number | null; blockedObserved: number; longestWaitMs: number | null; longestObservedWaitMs: number | null; waitKnown: number;
        staleRunning: number; runningFreshnessUnknown: number; accepted: number | null; acceptedVerified: number; acceptanceUnknown: number; cancelled: number; archived: number };
    dispatch: { success: Ratio; succeeded: number; failed: number; unknown: number; observed: number; retries: number | null; duplicates: number | null; knownCoverage: Ratio };
    acceptance: { pass: Ratio; uniqueGoalsAccepted: number; decisions: number; unbound: number; sessionReviews: number;
        firstPass: Ratio | null; rework: number | null; artifactAccess: Ratio | null; artifactExpected: number | null };
    efficiency: Record<string, Distribution>;
    waits: Record<WaitReason, { durationMs: number | null; n: number }>;
    usage: UsageMetric; todayUsage: UsageMetric;
    freshness: { ageMs: number | null; snapshotAgeMs: number | null; lastObservedAgeMs: number | null; lastPollAgeMs: number | null; state: 'fresh' | 'old' | 'missing' | 'clock_error'; connected: boolean | null };
    trend: DailyTrend[];
    anomalies: Anomaly[];
    technical: { eventsObserved: number; eventsInWindow: number; duplicateEvents: number; conflictingIds: number;
        invalidEvents: number; operationLimit: number | null; operationsObserved: number; historyComplete: boolean; historyCoverage: HistoricalEventCoverage; tasksComplete: boolean; errors: string[]; diagnostics: string[];
        ttftMs: null; recovery: Distribution; explicitErrors: number | null };
}

export function timestamp(value: string | null | undefined): number | null {
    if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
}
export function shanghaiDay(ms: number): string {
    return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function ratio(numerator: number, denominator: number): Ratio {
    return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}
export function distribution(values: number[], missing = 0, clocks: string[] = []): Distribution {
    const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    const n = sorted.length;
    return { medianMs: n ? ((sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2) : null,
        p95Ms: n ? sorted[Math.ceil(n * .95) - 1]! : null, n, missing, clocks: [...new Set(clocks)].sort() };
}
function signature(value: unknown): string {
    // Canonicalize keys so semantically identical objects from different serializers dedup.
    if (Array.isArray(value)) return `[${value.map(signature).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${signature(v)}`).join(',')}}`;
    return JSON.stringify(value) ?? 'undefined';
}
export function deduplicateEvents(events: MetricEvent[]): { events: MetricEvent[]; duplicates: number; conflicts: number; invalid: number } {
    const map = new Map<string, MetricEvent>();
    const conflicts = new Set<string>();
    let duplicates = 0, invalid = 0;
    for (const event of events) {
        if (!event.id || !event.taskId || !event.clock || timestamp(event.at) === null) { invalid++; continue; }
        const old = map.get(event.id);
        if (old) {
            duplicates++;
            if (signature(old) !== signature(event)) conflicts.add(event.id);
        } else map.set(event.id, event);
    }
    return { events: [...map.values()].filter(e => !conflicts.has(e.id)).sort((a, b) => timestamp(a.at)! - timestamp(b.at)! || a.id.localeCompare(b.id)),
        duplicates, conflicts: conflicts.size, invalid };
}
function taskMatches(task: MetricTask, filter: MetricsFilter): boolean {
    return (!filter.project || (task.project ?? UNKNOWN) === filter.project) && (!filter.executor || (task.executor ?? UNKNOWN) === filter.executor);
}
function key(...parts: (string | null)[]): string { return JSON.stringify(parts); }
function age(now: number, at: string | null): number | null {
    const time = timestamp(at);
    return time === null || time > now ? null : now - time;
}
function active(task: MetricTask): boolean { return task.archive !== 'archived' && task.execution !== 'cancelled'; }
function currentAccepted(task: MetricTask): boolean {
    return task.goalAuthority && task.review === 'accepted' && task.execution === 'reported' && task.turnStatus === 'completed' &&
        !!task.acceptedTurnId && task.acceptedTurnId === task.deliveryTurnId && task.acceptedTurnId === task.sourceTurnId;
}

function aggregateUsage(adapter: UsageAdapter | null, taskIds: Set<string>, start: number, end: number): UsageMetric {
    const expected = adapter?.expectedStages?.filter(s => taskIds.has(s.taskId) &&
        (!s.startedAt || (timestamp(s.startedAt) !== null && timestamp(s.startedAt)! <= end)) &&
        (!s.endedAt || (timestamp(s.endedAt) !== null && timestamp(s.endedAt)! > start))) ?? [];
    const expectedKeys = new Set(expected.map(s => key(s.taskId, s.stageId, s.phaseId)));
    const expectedCount = adapter?.expectedStagesComplete && adapter.expectedStages !== null ? expectedKeys.size : null;
    const meters = new Map<string, StageUsageSnapshot>();
    const badMeters = new Set<string>();
    for (const s of adapter?.snapshots ?? []) {
        if (!taskIds.has(s.taskId)) continue;
        const id = key(s.taskId, s.stageId, s.phaseId, s.meterId);
        const observed = timestamp(s.observedAt);
        if (observed === null || observed > end) continue;
        const old = meters.get(id);
        if (old && timestamp(old.observedAt) === observed && signature(old) !== signature(s)) badMeters.add(id);
        if (!old || timestamp(old.observedAt)! < observed) meters.set(id, s);
    }
    const values: Record<'input' | 'output' | 'cache', number[]> = { input: [], output: [], cache: [] };
    const fieldMeters = { input: new Set<string>(), output: new Set<string>(), cache: new Set<string>() };
    const covered = new Set<string>(), sources = new Set<string>(), models = new Set<string>();
    let excludedMeters = 0;
    for (const [id, s] of meters) {
        const from = timestamp(s.periodStart), to = timestamp(s.periodEnd);
        const stage = key(s.taskId, s.stageId, s.phaseId);
        if (badMeters.has(id) || !s.coverageKnown || !s.stageId || !s.phaseId || !expectedKeys.has(stage) || !s.clock || !s.source || !s.model ||
            from === null || to === null || from < start || to > end || to < from || timestamp(s.observedAt)! < to ||
            (s.cache !== null && s.input !== null && s.cache > s.input)) { excludedMeters++; continue; }
        let any = false;
        for (const field of ['input', 'output', 'cache'] as const) {
            const value = s[field];
            if (value !== null && Number.isSafeInteger(value) && value >= 0) {
                values[field].push(value); fieldMeters[field].add(id); any = true;
            }
        }
        if (any) { covered.add(stage); sources.add(s.source); models.add(s.model); }
    }
    const fieldStages = { input: new Set<string>(), output: new Set<string>(), cache: new Set<string>() };
    for (const stage of expected) {
        if (!stage.expectedMeterIds?.length) continue;
        for (const field of ['input', 'output', 'cache'] as const) {
            if (stage.expectedMeterIds.every(id => fieldMeters[field].has(key(stage.taskId, stage.stageId, stage.phaseId, id)))) {
                fieldStages[field].add(key(stage.taskId, stage.stageId, stage.phaseId));
            }
        }
    }
    const fullyCovered = new Set([...fieldStages.input].filter(id => fieldStages.output.has(id) && fieldStages.cache.has(id)));
    const sum = (field: 'input' | 'output' | 'cache') => {
        const result = values[field].length ? values[field].reduce((a, b) => a + b, 0) : null;
        return result !== null && Number.isSafeInteger(result) ? result : null;
    };
    const input = sum('input'), output = sum('output'), cache = sum('cache');
    return { input, output, cache, total: input !== null && output !== null && Number.isSafeInteger(input + output) && signature([...fieldMeters.input].sort()) === signature([...fieldMeters.output].sort()) ? input + output : null,
        expectedStages: expectedCount, coveredStages: fullyCovered.size, coverage: ratio(fullyCovered.size, expectedCount ?? 0),
        fieldCoverage: { input: ratio(fieldStages.input.size, expectedCount ?? 0), output: ratio(fieldStages.output.size, expectedCount ?? 0), cache: ratio(fieldStages.cache.size, expectedCount ?? 0) },
        excludedMeters, sources: [...sources].sort(), models: [...models].sort() };
}

/** Call once per existing parent refresh. Supplying the same inputs yields the same output. */
export function aggregateSystemMetrics(data: MetricsData, filter: MetricsFilter = { window: '24h' }): SystemMetrics {
    const now = timestamp(data.asOf);
    if (now === null) throw new Error('Metrics asOf must be an explicit ISO timestamp with timezone');
    const start = now - (filter.window === '7d' ? 7 : 1) * DAY_MS;
    // Current snapshots are replacements, never append-only counters.
    const taskMap = new Map<string, MetricTask>();
    const taskConflicts = new Set<string>();
    for (const task of data.tasks) {
        const old = taskMap.get(task.id);
        const at = timestamp(task.stateAt) ?? -Infinity, oldAt = timestamp(old?.stateAt) ?? -Infinity;
        if (!old || at > oldAt) { taskMap.set(task.id, task); taskConflicts.delete(task.id); }
        else if (at === oldAt && signature(old) !== signature(task)) taskConflicts.add(task.id);
    }
    const allTasks = [...taskMap.values()].map(task => taskConflicts.has(task.id) ? {
        ...task, execution: null, review: null, waitingOnApproval: null, goalAuthority: false,
        project: null, executor: null, sourceTurnId: null, acceptedTurnId: null, deliveryTurnId: null
    } : task);
    const tasks = allTasks.filter(t => taskMatches(t, filter));
    const ids = new Set(tasks.map(t => t.id));
    const dedup = deduplicateEvents(data.events);
    const events = dedup.events.filter(e => ids.has(e.taskId) && timestamp(e.at)! <= now);
    const inWindow = (e: MetricEvent) => timestamp(e.at)! > start && timestamp(e.at)! <= now;
    const windowEvents = events.filter(inWindow);
    const byId = new Map(tasks.map(t => [t.id, t]));
    const anomalies: Anomaly[] = [];
    const add = (id: string, taskId: string | null, label: string, action: string, tone: Anomaly['tone'] = 'warning') => {
        anomalies.push({ id, taskId, label, action, tone, href: taskId ? byId.get(taskId)?.href ?? null : null });
    };
    const blocked = tasks.filter(t => active(t) && (t.execution === 'blocked' || t.waitingOnApproval === true));
    const waitsKnown = blocked.map(t => age(now, t.waitSince)).filter((v): v is number => v !== null);
    const staleRunning = tasks.filter(t => active(t) && t.execution === 'running' && age(now, t.observedAt) !== null && age(now, t.observedAt)! > 30_000);
    const runningFreshnessUnknown = tasks.filter(t => active(t) && t.execution === 'running' && age(now, t.observedAt) === null);
    const blockedExact = data.coverage.tasksComplete && tasks.every(t => !active(t) || t.execution === 'blocked' || t.waitingOnApproval === true || (t.execution !== null && t.execution !== 'unknown' && t.waitingOnApproval === false)) ? blocked.length : null;
    for (const t of runningFreshnessUnknown) add(`running-missing:${t.id}`, t.id, '运行任务新鲜度缺测', '核对现有采集是否覆盖该执行器', 'muted');
    for (const t of blocked) add(`blocked:${t.id}`, t.id, t.waitingOnApproval ? '等待审批' : '执行器明确报告阻塞', '打开任务，核对等待原因和所需决定');
    for (const t of staleRunning) add(`stale:${t.id}`, t.id, '运行状态较旧，尚不能判定停滞', '核对执行器与采集状态', 'muted');
    for (const t of tasks.filter(t => active(t) && t.review === 'rejected')) add(`rejected:${t.id}`, t.id, '当前交付未通过验收', '打开任务，核对验收决定与返工要求');
    for (const t of tasks.filter(t => active(t) && t.review === 'awaiting')) add(`awaiting:${t.id}`, t.id, '交付等待验收', '打开任务，查看已有交付并记录目标验收决定');
    for (const t of tasks.filter(t => active(t) && ['failed', 'interrupted'].includes(t.execution ?? ''))) add(`execution:${t.id}`, t.id, t.execution === 'failed' ? '执行报告失败' : '执行报告中断', '核对执行器与已有汇报，再由责任人决定下一步');
    const verifiedAccepted = tasks.filter(currentAccepted).length;
    const acceptanceUnknown = tasks.filter(t => t.review === null || (t.review === 'accepted' && !currentAccepted(t))).length;
    const accepted = acceptanceUnknown || !data.coverage.tasksComplete ? null : verifiedAccepted;
    const sends = windowEvents.filter(e => e.kind === 'sent' || e.kind === 'dispatch');
    // An intent and its wire outcome share correlationId. Uncorrelated records remain separate unknown attempts.
    const attempts = new Map<string, MetricEvent[]>();
    for (const e of sends) {
        const id = key(e.taskId, e.stageId, e.correlationId ?? e.id);
        attempts.set(id, [...(attempts.get(id) ?? []), e]);
    }
    let succeeded = 0, failed = 0, unknown = 0, retries = 0, duplicates = 0;
    for (const list of attempts.values()) {
        const terminal = list.filter(e => e.kind === 'sent').at(-1);
        if (terminal?.sendStatus === 'succeeded') succeeded++;
        else if (terminal?.sendStatus === 'failed') { failed++; add(`send:${terminal.id}`, terminal.taskId, '发送失败', '核对派遣结果，再按原流程决定是否重试'); }
        else unknown++;
        if (list.some(e => e.retryOf)) retries++;
        if (list.some(e => e.duplicateOf)) duplicates++;
    }
    // Goal review decisions are keyed by delivery turn. Session decisions are always separate.
    const reviews = events.filter(e => e.kind === 'review' && e.scope === 'goal' && e.goalAuthority === true && e.result && e.turnId);
    const decisions = new Map<string, MetricEvent>();
    const conflictingDecisions = new Set<string>();
    for (const e of reviews) {
        const id = key(e.taskId, e.goalId, e.turnId!);
        const old = decisions.get(id);
        if (old && old.result !== e.result) conflictingDecisions.add(id);
        if (!old) decisions.set(id, e); // repeated acceptance never moves a decision into a new window
    }
    const historicalDecisions = [...decisions.entries()].filter(([id]) => !conflictingDecisions.has(id)).map(([, e]) => e);
    const selectedDecisions = historicalDecisions.filter(inWindow);
    const passing = selectedDecisions.filter(e => e.result === 'accepted');
    const firstGoalAccepted = new Map<string, MetricEvent>();
    for (const e of historicalDecisions.filter(e => e.result === 'accepted')) {
        const id = key(e.taskId, e.goalId);
        if (!firstGoalAccepted.has(id)) firstGoalAccepted.set(id, e);
    }
    const firstAcceptedInWindow = [...firstGoalAccepted.values()].filter(inWindow);
    const acceptedGoals = new Set(firstAcceptedInWindow.map(e => key(e.taskId, e.goalId)));
    const unbound = windowEvents.filter(e => e.kind === 'review' && e.scope === 'goal' && (!e.turnId || !e.result || e.goalAuthority !== true)).length;
    const sessionReviews = windowEvents.filter(e => e.kind === 'review' && e.scope !== 'goal').length;
    let firstPass: Ratio | null = null, rework: number | null = null;
    if (data.coverage.reviewHistoryComplete) {
        const first = new Map<string, MetricEvent>();
        for (const e of historicalDecisions) { const id = key(e.taskId, e.goalId); if (!first.has(id)) first.set(id, e); }
        const cohort = [...first.values()].filter(inWindow);
        firstPass = ratio(cohort.filter(e => e.result === 'accepted').length, cohort.length);
        rework = selectedDecisions.filter(e => e.result === 'rejected').length;
    }
    // Pair only explicit stage+correlation+clock. Review/delivery pair by their bound turn.
    const pairs = [
        ['receivedToDispatch', 'received', 'dispatch'], ['dispatchToSent', 'dispatch', 'sent'],
        ['sentToAck', 'sent', 'ack'], ['ackToFirstAction', 'ack', 'first_action'],
        ['runToDelivery', 'first_action', 'delivery'], ['deliveryToAcceptance', 'delivery', 'review'],
        ['deliveryObservedToAcceptance', 'delivery_observed', 'review'],
        ['endToEnd', 'received', 'review']
    ] as const;
    const efficiency: Record<string, Distribution> = {};
    for (const [name, from, to] of pairs) {
        const ends = (to === 'review' ? historicalDecisions.filter(e => e.result === 'accepted') : windowEvents.filter(e => e.kind === to)).filter(inWindow);
        const values: number[] = [], clocks: string[] = [];
        let missing = 0;
        for (const end of ends) {
            if (!end.stageId || !end.correlationId || (to === 'sent' && end.sendStatus !== 'succeeded')) { missing++; continue; }
            const begin = events.filter(e => e.kind === from && e.taskId === end.taskId && e.goalId === end.goalId && e.stageId === end.stageId &&
                e.correlationId === end.correlationId && e.clock === end.clock && (from !== 'sent' || e.sendStatus === 'succeeded') &&
                (!['deliveryToAcceptance', 'deliveryObservedToAcceptance'].includes(name) || (!!e.turnId && e.turnId === end.turnId)) && timestamp(e.at)! <= timestamp(end.at)!).at(0);
            if (begin) { values.push(timestamp(end.at)! - timestamp(begin.at)!); clocks.push(end.clock); }
            else missing++;
        }
        efficiency[name] = distribution(values, missing, clocks);
    }
    const progressAges: number[] = [];
    for (const task of tasks.filter(active)) {
        const latest = events.filter(e => e.taskId === task.id && e.kind === 'progress').at(-1);
        const progressAge = age(now, task.lastProgressAt ?? latest?.at ?? null);
        if (progressAge !== null) progressAges.push(progressAge);
    }
    efficiency.lastProgressAge = distribution(progressAges, tasks.filter(active).length - progressAges.length, ['explicit-progress-to-parent-asOf']);
    const waits = Object.fromEntries((['approval', 'resource', 'external_input', 'other', 'unknown'] as const).map(reason => [reason, { durationMs: null, n: 0 }])) as SystemMetrics['waits'];
    const waitIntervals = new Map<string, [number, number][]>();
    for (const e of events.filter(e => e.kind === 'wait_start')) {
        if (!e.correlationId || !e.stageId) continue;
        const end = events.find(x => x.kind === 'wait_end' && x.taskId === e.taskId && x.stageId === e.stageId && x.correlationId === e.correlationId && x.clock === e.clock && timestamp(x.at)! >= timestamp(e.at)!);
        // Open intervals require current explicit blocking; stale-running alone cannot accrue waiting.
        const task = byId.get(e.taskId);
        if (!end && (!task || !blocked.includes(task))) continue;
        const left = Math.max(start, timestamp(e.at)!), right = Math.min(now, end ? timestamp(end.at)! : now);
        if (right < left || right <= start) continue;
        const id = key(e.taskId, e.stageId, e.waitReason ?? 'unknown');
        waitIntervals.set(id, [...(waitIntervals.get(id) ?? []), [left, right]]);
    }
    for (const [id, intervals] of waitIntervals) {
        const reason = (JSON.parse(id) as string[])[2] as WaitReason;
        intervals.sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        for (const [left, right] of intervals) {
            const last = merged.at(-1);
            if (last && last[1] >= left) last[1] = Math.max(last[1], right);
            else merged.push([left, right]);
        }
        waits[reason].durationMs = (waits[reason].durationMs ?? 0) + merged.reduce((sum, [a, b]) => sum + b - a, 0);
        waits[reason].n += merged.length;
    }
    const probes = new Map<string, MetricEvent>();
    for (const e of windowEvents.filter(e => e.kind === 'artifact_probe' && e.artifactId && typeof e.accessible === 'boolean')) probes.set(key(e.taskId, e.artifactId!), e);
    const artifactAccess = probes.size ? ratio([...probes.values()].filter(e => e.accessible).length, probes.size) : null;
    const successTime = timestamp(data.collector.lastSuccessAt), generatedTime = timestamp(data.generatedAt);
    const freshnessAge = age(now, data.collector.lastSuccessAt), snapshotAge = age(now, data.generatedAt);
    const freshness: SystemMetrics['freshness'] = { ageMs: freshnessAge, snapshotAgeMs: snapshotAge, lastObservedAgeMs: age(now, data.collector.lastObservedAt), lastPollAgeMs: age(now, data.collector.lastPollAt ?? null), connected: data.collector.connected,
        state: (successTime !== null && successTime > now) || (generatedTime !== null && generatedTime > now) ? 'clock_error' :
            data.errors.length > 0 || data.collector.connected === false || data.collector.stale === true || (freshnessAge !== null && freshnessAge > 30_000) || (snapshotAge !== null && snapshotAge > 30_000) ? 'old' :
                freshnessAge === null ? 'missing' : 'fresh' };
    if (freshness.state !== 'fresh') add('collector', null, freshness.state === 'old' ? '采集数据已旧' : freshness.state === 'clock_error' ? '采集时钟异常' : '采集新鲜度缺测', '核对现有采集器；刷新不会补齐缺失历史', 'muted');
    if (data.errors.length) add('refresh', null, '父级刷新报告错误', '使用宿主已有刷新入口核对连接');
    if (unknown) add('send-unknown', null, `${unknown} 次派遣发送结果未核实`, '查看已有操作证据；绑定成功不能证明发送成功', 'muted');
    if (acceptanceUnknown) add('acceptance-unknown', null, `${acceptanceUnknown} 个接受状态缺少当前 turn 权威证明`, '核对 ledger 的交付与验收 turn，避免将历史接受计为当前完成', 'muted');
    const declaredCoverage = data.coverage.historyCoverage;
    const coverageStart = timestamp(declaredCoverage?.startAt), coverageEnd = timestamp(declaredCoverage?.endAt);
    const coverageValid = coverageStart !== null && coverageEnd !== null && coverageStart <= coverageEnd && coverageEnd <= now;
    const historyCoverage: HistoricalEventCoverage = {
        startAt: coverageStart !== null ? declaredCoverage!.startAt : null,
        endAt: coverageEnd !== null ? declaredCoverage!.endAt : null,
        completeFamilies: coverageValid ? [...(declaredCoverage?.completeFamilies ?? [])] : []
    };
    const fullDayCovered = (dayStart: number, family: HistoryEventFamily) => coverageValid &&
        coverageStart! <= dayStart && coverageEnd! >= dayStart + DAY_MS && historyCoverage.completeFamilies.includes(family);
    const trend: DailyTrend[] = [];
    for (let cursor = Math.floor((start + 8 * 3_600_000) / DAY_MS) * DAY_MS - 8 * 3_600_000; cursor <= now; cursor += DAY_MS) {
        const day = shanghaiDay(cursor);
        const dayDecisions = selectedDecisions.filter(e => shanghaiDay(timestamp(e.at)!) === day);
        const dispatchCount = windowEvents.filter(e => e.kind === 'dispatch' && shanghaiDay(timestamp(e.at)!) === day).length;
        const sessionCount = windowEvents.filter(e => e.kind === 'review' && e.scope !== 'goal' && shanghaiDay(timestamp(e.at)!) === day).length;
        const firstAcceptedCount = firstAcceptedInWindow.filter(e => shanghaiDay(timestamp(e.at)!) === day).length;
        const rejectedCount = dayDecisions.filter(e => e.result === 'rejected').length;
        const coverage = { dispatch: fullDayCovered(cursor, 'dispatch'), goal_review: fullDayCovered(cursor, 'goal_review'), session_review: fullDayCovered(cursor, 'session_review') };
        // Retained SQLite completeness never proves an unobserved historical day was idle.
        // Each event family needs authoritative coverage of the entire Shanghai day to emit 0.
        trend.push({ day, dispatchObserved: dispatchCount > 0 || coverage.dispatch ? dispatchCount : null,
            goalAccepted: firstAcceptedCount > 0 || coverage.goal_review ? firstAcceptedCount : null,
            goalRejected: rejectedCount > 0 || coverage.goal_review ? rejectedCount : null,
            sessionReviews: sessionCount > 0 || coverage.session_review ? sessionCount : null, coverage });
    }
    const recoveries: number[] = [], recoveryClocks: string[] = [];
    let missingRecovery = 0;
    for (const e of windowEvents.filter(e => e.kind === 'recovery')) {
        const begin = e.incidentId && events.find(x => x.kind === 'disconnect' && x.taskId === e.taskId && x.incidentId === e.incidentId && x.clock === e.clock && timestamp(x.at)! <= timestamp(e.at)!);
        if (begin) { recoveries.push(timestamp(e.at)! - timestamp(begin.at)!); recoveryClocks.push(e.clock); } else missingRecovery++;
    }
    const todayStart = Math.max(start, Math.floor((now + 8 * 3_600_000) / DAY_MS) * DAY_MS - 8 * 3_600_000);
    return {
        asOf: data.asOf, start: new Date(start).toISOString(), filter, taskCount: tasks.length,
        projectOptions: [...new Set(allTasks.map(t => t.project ?? UNKNOWN))].sort(), executorOptions: [...new Set(allTasks.map(t => t.executor ?? UNKNOWN))].sort(),
        current: { blocked: blockedExact, blockedObserved: blocked.length,
            longestWaitMs: blockedExact !== null && blockedExact > 0 && waitsKnown.length === blockedExact ? Math.max(...waitsKnown) : null,
            longestObservedWaitMs: waitsKnown.length ? Math.max(...waitsKnown) : null, waitKnown: waitsKnown.length, staleRunning: staleRunning.length, runningFreshnessUnknown: runningFreshnessUnknown.length,
            accepted, acceptedVerified: verifiedAccepted, acceptanceUnknown, cancelled: tasks.filter(t => t.execution === 'cancelled').length, archived: tasks.filter(t => t.archive === 'archived').length },
        dispatch: { success: ratio(succeeded, succeeded + failed), succeeded, failed, unknown, observed: attempts.size,
            retries: data.coverage.dispatchRelationsComplete || retries ? retries : null, duplicates: data.coverage.dispatchRelationsComplete || duplicates ? duplicates : null,
            knownCoverage: ratio(succeeded + failed, attempts.size) },
        acceptance: { pass: ratio(passing.length, selectedDecisions.length), uniqueGoalsAccepted: acceptedGoals.size, decisions: selectedDecisions.length, unbound, sessionReviews,
            firstPass, rework, artifactAccess, artifactExpected: data.coverage.artifactsExpected },
        efficiency, waits, usage: aggregateUsage(data.usage, ids, start, now), todayUsage: aggregateUsage(data.usage, ids, todayStart, now), freshness, trend, anomalies,
        technical: { eventsObserved: events.length, eventsInWindow: windowEvents.length, duplicateEvents: dedup.duplicates, conflictingIds: dedup.conflicts + conflictingDecisions.size + taskConflicts.size,
            invalidEvents: dedup.invalid, operationLimit: data.coverage.operationLimit, operationsObserved: data.coverage.operationsObserved, historyComplete: data.coverage.historyComplete, historyCoverage,
            tasksComplete: data.coverage.tasksComplete, errors: data.errors, diagnostics: data.diagnostics, ttftMs: null,
            recovery: distribution(recoveries, missingRecovery, recoveryClocks), explicitErrors: data.coverage.errorEventsComplete || windowEvents.some(e => e.kind === 'error') ? windowEvents.filter(e => e.kind === 'error').length : null }
    };
}
