import { DAY_MS, distribution, timestamp, type Distribution, type MetricTask, type MetricsFilter } from './systemMetrics';

export type DecisionAuthority = 'controller' | 'user' | 'external';
export interface DecisionRecord {
    decisionId: string;
    taskId: string;
    stageId: string | null;
    decisionRequired: boolean | null;
    authority: DecisionAuthority | null;
    waitingOn: DecisionAuthority | null;
    state: 'pending' | 'decided' | 'action-pending' | 'verified' | null;
    triggeredAt: string | null;
    /** Current pending spell start; rework cannot reuse the original issue trigger. */
    pendingSince?: string | null;
    decidedAt: string | null;
    actionConfirmedAt: string | null;
    verifiedAt: string | null;
    dueAt: string | null;
    clock: string | null;
    revision: number;
    rework: boolean | null;
    revoked: boolean | null;
    test: boolean | null;
    /** Only dedicated T022 public-safe projection may populate these display fields. */
    question: string | null;
    nextAction: string | null;
    owner: string | null;
}
export interface DecisionData {
    version: 1;
    projection: 'T022-public-safe/v1';
    generatedAt: string | null;
    statisticsStartAt: string | null;
    currentComplete: boolean;
    historyComplete: boolean;
    firstDecisionAtImmutable: boolean;
    records: DecisionRecord[];
    invalidRecords: number;
}
export type DecisionStatus = 'pending' | 'decided' | 'action_confirmed' | 'verified' | 'revoked' | 'unknown';
export interface DecisionItem extends DecisionRecord {
    status: DecisionStatus;
    overdue: boolean | null;
    /** Current pending decision wait only; never includes prior execution time. */
    waitMs: number | null;
    /** Original trigger age while unresolved, separate from the current pending spell. */
    issueAgeMs: number | null;
    href: string | null;
}
export interface DecisionMetrics {
    collected: boolean;
    generatedAt: string | null;
    freshness: 'fresh' | 'old' | 'missing' | 'clock_error';
    statisticsStartAt: string | null;
    currentComplete: boolean;
    windowComplete: boolean;
    decided: number | null;
    decidedObserved: number | null;
    firstDecisionTimeKnown: boolean;
    pending: number | null;
    pendingObserved: number;
    actionPending: number | null;
    actionPendingObserved: number;
    awaitingExecution: number | null;
    awaitingVerification: number | null;
    currentlyEffective: number | null;
    actionConfirmed: number | null;
    verified: number | null;
    overdue: number | null;
    overdueObserved: number;
    pendingLongestWaitMs: number | null;
    pendingLongestObservedWaitMs: number | null;
    longestWaitMs: number | null;
    longestObservedWaitMs: number | null;
    waiting: Record<DecisionAuthority | 'unknown', number | null>;
    decisionLatency: Distribution;
    rework: number | null;
    revoked: number | null;
    items: DecisionItem[];
    duplicates: number;
    conflicts: number;
    notificationsExcluded: number;
    testRecordsExcluded: number;
    unknownRecords: number;
}
function classify(r: DecisionRecord, now: number): DecisionStatus {
    if (r.revoked === true) return 'revoked';
    if (r.revoked === null) return 'unknown';
    const trigger = timestamp(r.triggeredAt), decision = timestamp(r.decidedAt), action = timestamp(r.actionConfirmedAt), verified = timestamp(r.verifiedAt);
    if ((trigger !== null && trigger > now) || (decision !== null && (decision > now || (trigger !== null && decision < trigger))) ||
        (action !== null && (decision === null || action < decision || action > now)) ||
        (verified !== null && (decision === null || verified < decision || verified > now || (action !== null && verified < action)))) return 'unknown';
    // A reopened pending issue may retain its immutable historical first choice.
    if (r.state === 'pending') return action !== null || verified !== null ? 'unknown' : 'pending';
    // State flags are not evidence of action or independent verification.
    if (verified !== null) return 'verified';
    if (decision !== null && action !== null) return 'action_confirmed';
    if (decision !== null) return 'decided';
    if (r.state === 'decided' || r.state === 'action-pending' || r.state === 'verified') return 'unknown';
    return r.state === 'pending' ? 'pending' : 'unknown';
}
const canonical = (r: DecisionRecord) => JSON.stringify(Object.fromEntries(Object.entries({ ...r, pendingSince: r.pendingSince ?? null }).sort(([a], [b]) => a.localeCompare(b))));
/** Historical decisions use decidedAt in the rolling window; unresolved items are current-state.
 * These are counts of recorded choices/issues, never a measure of decision effectiveness.
 */
export function aggregateDecisionMetrics(data: DecisionData | null | undefined, asOf: string, filter: MetricsFilter, tasks: MetricTask[]): DecisionMetrics {
    const now = timestamp(asOf);
    if (now === null) throw new Error('Decision asOf must have timezone');
    const start = now - (filter.window === '7d' ? 7 : 1) * DAY_MS;
    const allTasks = new Map(tasks.map(t => [t.id, t]));
    const ids = new Map(tasks.filter(t => (!filter.project || (t.project ?? 'unknown') === filter.project) && (!filter.executor || (t.executor ?? 'unknown') === filter.executor)).map(t => [t.id, t]));
    const byId = new Map<string, DecisionRecord>(), conflicts = new Set<string>();
    const firstDecisions = new Map<string, string>();
    let duplicates = 0;
    for (const r of data?.records ?? []) {
        const old = byId.get(r.decisionId);
        const choice = timestamp(r.decidedAt), firstChoice = timestamp(firstDecisions.get(r.decisionId));
        if (r.test === false && r.decisionRequired === true && choice !== null && (firstChoice === null || choice < firstChoice)) firstDecisions.set(r.decisionId, r.decidedAt!);
        if (old) duplicates++;
        if (!old || r.revision > old.revision) { byId.set(r.decisionId, r); conflicts.delete(r.decisionId); }
        else if (old.revision === r.revision && canonical(old) !== canonical(r)) conflicts.add(r.decisionId);
    }
    let notificationsExcluded = 0, testRecordsExcluded = 0, unknownRecords = data?.invalidRecords ?? 0;
    const items: DecisionItem[] = [];
    for (const r of byId.values()) {
        // No filter: retain records whose registered task is not in this partial task snapshot.
        const task = allTasks.get(r.taskId);
        if ((filter.project && (task?.project ?? 'unknown') !== filter.project) || (filter.executor && (task?.executor ?? 'unknown') !== filter.executor)) continue;
        if (r.test === true) { testRecordsExcluded++; continue; }
        if (r.decisionRequired === false) { notificationsExcluded++; continue; }
        if (r.test !== false || r.decisionRequired !== true || conflicts.has(r.decisionId)) { unknownRecords++; continue; }
        const status = classify(r, now), unresolved = ['pending', 'decided', 'action_confirmed'].includes(status);
        if (status === 'unknown') unknownRecords++;
        const trigger = timestamp(r.triggeredAt), due = timestamp(r.dueAt), decision = timestamp(r.decidedAt);
        const pendingOrigin = r.pendingSince !== null && r.pendingSince !== undefined ? timestamp(r.pendingSince) : r.rework === false ? trigger : null;
        const validPendingOrigin = pendingOrigin !== null && pendingOrigin <= now &&
            (trigger === null || pendingOrigin >= trigger) && (r.rework !== true || decision === null || pendingOrigin >= decision);
        items.push({ ...r, status, overdue: unresolved ? due === null ? null : due < now : false,
            waitMs: status === 'pending' && r.clock && validPendingOrigin ? now - pendingOrigin! : null,
            issueAgeMs: unresolved && r.clock && trigger !== null && trigger <= now ? now - trigger : null,
            href: ids.get(r.taskId)?.href ?? null });
    }
    const collection = timestamp(data?.statisticsStartAt);
    const currentComplete = data?.currentComplete === true && collection !== null && collection <= now && !unknownRecords && !conflicts.size;
    const firstDecisionTimeKnown = data?.firstDecisionAtImmutable === true;
    const windowComplete = firstDecisionTimeKnown && currentComplete && data?.historyComplete === true && collection !== null && collection <= start;
    const pending = items.filter(r => r.status === 'pending');
    const actionPending = items.filter(r => r.status === 'decided' || r.status === 'action_confirmed');
    const unresolved = [...pending, ...actionPending];
    const decided = items.filter(r => {
        const first = timestamp(firstDecisions.get(r.decisionId)), trigger = timestamp(r.triggeredAt);
        return first !== null && first > start && first <= now && (trigger === null || trigger <= first);
    });
    const waiting = Object.fromEntries((['controller', 'user', 'external', 'unknown'] as const).map(who => [who, currentComplete ? pending.filter(r => (r.waitingOn ?? r.authority ?? 'unknown') === who).length : null])) as DecisionMetrics['waiting'];
    const pendingWaits = pending.map(r => r.waitMs).filter((v): v is number => v !== null);
    const waits = unresolved.map(r => r.issueAgeMs).filter((v): v is number => v !== null);
    const latencies: number[] = [], clocks: string[] = [];
    for (const r of decided) {
        const trigger = timestamp(r.triggeredAt), decision = timestamp(firstDecisions.get(r.decisionId));
        if (firstDecisionTimeKnown && trigger !== null && decision !== null && decision >= trigger && r.clock) { latencies.push(decision - trigger); clocks.push(r.clock); }
    }
    const overdueObserved = unresolved.filter(r => r.overdue === true).length;
    const currentFlagCount = (flag: 'rework' | 'revoked') => currentComplete && items.every(r => r[flag] !== null) ? items.filter(r => r[flag] === true).length : null;
    const generated = timestamp(data?.generatedAt);
    const freshness = generated === null ? 'missing' : generated > now ? 'clock_error' : now - generated > 30_000 ? 'old' : 'fresh';
    return {
        collected: !!data, generatedAt: data?.generatedAt ?? null, freshness, statisticsStartAt: data?.statisticsStartAt ?? null, currentComplete, windowComplete,
        decided: windowComplete ? decided.length : null, decidedObserved: firstDecisionTimeKnown ? decided.length : null, firstDecisionTimeKnown,
        pending: currentComplete ? pending.length : null, pendingObserved: pending.length,
        actionPending: currentComplete ? actionPending.length : null, actionPendingObserved: actionPending.length,
        awaitingExecution: currentComplete ? items.filter(r => r.status === 'decided').length : null,
        awaitingVerification: currentComplete ? items.filter(r => r.status === 'action_confirmed').length : null,
        currentlyEffective: currentComplete ? items.filter(r => ['decided', 'action_confirmed', 'verified'].includes(r.status)).length : null,
        actionConfirmed: currentComplete ? items.filter(r => r.status === 'action_confirmed').length : null,
        verified: currentComplete ? items.filter(r => r.status === 'verified').length : null,
        overdue: currentComplete && unresolved.every(r => r.overdue !== null) ? overdueObserved : null, overdueObserved,
        pendingLongestWaitMs: currentComplete && pending.length > 0 && pendingWaits.length === pending.length ? Math.max(...pendingWaits) : null,
        pendingLongestObservedWaitMs: pendingWaits.length ? Math.max(...pendingWaits) : null,
        longestWaitMs: currentComplete && unresolved.length > 0 && waits.length === unresolved.length ? Math.max(...waits) : null,
        longestObservedWaitMs: waits.length ? Math.max(...waits) : null,
        waiting, decisionLatency: distribution(latencies, decided.length - latencies.length, clocks),
        rework: currentFlagCount('rework'), revoked: currentFlagCount('revoked'), items: items.sort((a, b) => Number(b.overdue === true) - Number(a.overdue === true) || a.decisionId.localeCompare(b.decisionId)),
        duplicates, conflicts: conflicts.size, notificationsExcluded, testRecordsExcluded, unknownRecords
    };
}

type JsonRecord = Record<string, unknown>;
const object = (v: unknown): JsonRecord => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as JsonRecord : {};
const safeId = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/.test(v) ? v : null;
const safeDate = (v: unknown): string | null => typeof v === 'string' && timestamp(v) !== null ? v : null;
const safeBool = (v: unknown): boolean | null => typeof v === 'boolean' ? v : null;
const safeDisplay = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) : null;
const authority = (v: unknown): DecisionAuthority | null => v === 'controller' || v === 'user' || v === 'external' ? v : null;
/** T022 deployed versioned public-safe boundary; lifecycle verification remains separate.
 * Never call with a native receipt, evidence payload or generic ledger snapshot.
 */
export function normalizeT022Decisions(value: unknown): DecisionData | null {
    const r = object(value);
    if (r.version !== 1 || r.projection !== 'T022-public-safe/v1' || r.safeDisplay !== true || !Array.isArray(r.decisions)) return null;
    const c = object(r.coverage), records: DecisionRecord[] = [];
    let invalidRecords = 0;
    for (const raw of r.decisions) {
        const d = object(raw), decisionId = safeId(d.decisionId), taskId = safeId(d.taskId);
        if (!decisionId || !taskId || typeof d.revision !== 'number' || !Number.isSafeInteger(d.revision) || d.revision < 0) { invalidRecords++; continue; }
        records.push({ decisionId, taskId, stageId: safeId(d.stageId), revision: d.revision,
            decisionRequired: safeBool(d.decisionRequired), authority: authority(d.authority), waitingOn: authority(d.waitingOn),
            state: d.state === 'pending' || d.state === 'decided' || d.state === 'action-pending' || d.state === 'verified' ? d.state : null,
            triggeredAt: safeDate(d.triggeredAt), pendingSince: safeDate(d.pendingSince), decidedAt: safeDate(d.decidedAt), actionConfirmedAt: safeDate(d.actionConfirmedAt), verifiedAt: safeDate(d.verifiedAt), dueAt: safeDate(d.dueAt), clock: safeId(d.clock ?? r.clock),
            rework: safeBool(d.rework), revoked: safeBool(d.revoked), test: safeBool(d.test),
            question: safeDisplay(d.question), nextAction: safeDisplay(d.nextAction), owner: safeDisplay(d.owner) });
    }
    return { version: 1, projection: 'T022-public-safe/v1', generatedAt: safeDate(r.generatedAt), statisticsStartAt: safeDate(r.statisticsStartAt),
        currentComplete: c.currentComplete === true, historyComplete: c.historyComplete === true, firstDecisionAtImmutable: c.firstDecisionAtImmutable !== false, records, invalidRecords };
}
