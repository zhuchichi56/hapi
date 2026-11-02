import { normalizeT022Decisions, type DecisionData } from './decisionMetrics';
import { timestamp, type MetricEvent, type MetricTask, type MetricsData, type UsageAdapter } from './systemMetrics';

// Read only explicitly allowed fields. Never spread a raw task, payload, telemetry or error.
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const identity = (value: unknown): string | null => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) ? value : null;
const date = (value: unknown): string | null => typeof value === 'string' && timestamp(value) !== null ? value : null;
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : value === 1 ? true : value === 0 ? false : null;
const enumValue = (value: unknown, allowed: readonly string[]): string | null => typeof value === 'string' && allowed.includes(value) ? value : null;
const executions = ['queued', 'running', 'reported', 'failed', 'interrupted', 'unknown', 'blocked', 'cancelled'];
const reviews = ['pending', 'awaiting', 'accepted', 'rejected'];
const archives = ['none', 'pending', 'archived', 'unknown'];

export interface HostAdapterOptions {
    /** Parent refresh evaluation time. Do not invent a fresh time inside the adapter. */
    asOf: string;
    refreshFailed?: boolean;
    usage?: UsageAdapter | null;
    decisions?: DecisionData | null;
    /** Optional authoritative mappings supplied by the owners. No cwd/title guessing. */
    authority?: Readonly<Record<string, { project: string | null; executor: string | null }>>;
    taskHref?: (taskId: string, threadId: string | null) => string | null;
}
export function safePrivateHref(value: string | null): string | null {
    // Same-origin relative private routes only. Never accept protocol-relative URLs or file paths.
    if (!value || !/^\/(?:desktop|sessions)(?:[/?#]|$)/.test(value) || /[\s\\<>"\x00-\x1f]/.test(value)) return null;
    return value;
}
export function existingConversationHref(_taskId: string, threadId: string | null): string | null {
    return threadId ? `/desktop?app=codex&thread=${encodeURIComponent(threadId)}` : null;
}
function taskFrom(raw: unknown, options: HostAdapterOptions, sample: boolean): MetricTask | null {
    const r = record(raw), id = identity(r.id);
    if (!id) return null;
    const authority = options.authority?.[id];
    const sourceTurn = identity(sample ? r.source_turn_id : r.sourceTurnId);
    return {
        id, goalId: id, project: identity(authority?.project), executor: identity(authority?.executor),
        href: safePrivateHref((options.taskHref ?? existingConversationHref)(id, identity(sample ? r.thread_id : r.threadId))),
        execution: enumValue(r.execution, executions), review: enumValue(r.review, reviews), archive: enumValue(r.archive, archives),
        stateAt: date(sample ? r.updated_at : r.updatedAt) ?? date(sample ? r.observed_at : r.observedAt),
        observedAt: date(sample ? r.observed_at : r.observedAt),
        // telemetry.lastProgressBasis and phase require a separate authoritative contract; never infer here.
        lastProgressAt: null, waitingOnApproval: bool(r.waitingOnApproval) ?? ((sample ? r.turn_status : r.turnStatus) === 'waitingOnApproval' ? true : null), waitSince: date(r.waitSince),
        sourceTurnId: sourceTurn, deliveryTurnId: identity(sample ? r.delivery_turn_id : r.deliveryTurnId),
        acceptedTurnId: identity(sample ? r.accepted_turn_id : r.acceptedTurnId),
        turnStatus: enumValue(sample ? r.turn_status : r.turnStatus, ['completed', 'running', 'failed', 'interrupted', 'waitingOnApproval']),
        goalAuthority: bool(r.external) === false && (!sample || bool(r.read_only) === false)
    };
}
interface Operation { id: string; taskId: string; kind: string; status: string | null; at: string; updatedAt: string; metadata: RecordValue }
function parseOperations(value: unknown, sample: boolean): Operation[] {
    const map = new Map<string, Operation>();
    const conflicts = new Map<string, Operation[]>();
    for (const raw of list(value)) {
        const r = record(raw), id = identity(sample ? r.op_id : r.opId), taskId = identity(sample ? r.task_id : r.taskId);
        const at = date(sample ? r.created_at : r.createdAt), updatedAt = date(sample ? r.updated_at : r.updatedAt) ?? at;
        const kind = enumValue(r.kind, ['dispatch_intent', 'review', 'session_review']);
        if (!id || !taskId || !at || !updatedAt || !kind) continue;
        const op: Operation = { id, taskId, kind, status: text(r.status), at, updatedAt, metadata: record(sample ? r.metadata : r.payload) };
        const old = map.get(id);
        if (!old || timestamp(old.updatedAt)! < timestamp(updatedAt)!) { map.set(id, op); conflicts.delete(id); }
        else if (timestamp(old.updatedAt) === timestamp(updatedAt) &&
            (old.taskId !== op.taskId || old.kind !== op.kind || old.at !== op.at ||
             old.metadata.result !== op.metadata.result || old.metadata.turnId !== op.metadata.turnId)) conflicts.set(id, [...(conflicts.get(id) ?? []), op]);
    }
    // Feed conflicting immutable identities to the pure deduper so diagnostics survive.
    return [...map.values()].flatMap(op => [op, ...(conflicts.get(op.id) ?? [])]);
}
function operationEvents(operations: Operation[], history: unknown[], sample: boolean, tasks: MetricTask[]): MetricEvent[] {
    // History links opId to turn metadata omitted from many older operation payloads.
    // Merge this evidence, retaining one stable event id across both representations.
    const bound = new Map<string, { taskId: string; turnId: string | null; result: 'accepted' | 'rejected' | null }>();
    for (const raw of history) {
        const r = record(raw), m = record(r.metadata), opId = identity(m.opId), taskId = identity(r.task_id);
        const turnId = identity(m.turnId), delivery = identity(m.deliveryTurnId);
        if (sample && r.kind === 'review' && opId && taskId) bound.set(opId, { taskId,
            turnId: turnId && delivery === turnId ? turnId : null,
            result: m.result === 'accepted' || m.result === 'rejected' ? m.result : null });
    }
    const events: MetricEvent[] = [];
    for (const op of operations) {
        const link = bound.get(op.id), m = op.metadata;
        if (op.kind === 'dispatch_intent') {
            events.push({ id: `op:${op.id}`, taskId: op.taskId, goalId: op.taskId, stageId: null,
                correlationId: op.id, at: op.at, clock: 'ledger-recorded', kind: 'dispatch', sendStatus: 'unknown' });
            // Even reconciled, recorded and succeeded ledger statuses do not prove a wire-send.
        } else {
            const scope = op.kind === 'session_review' ? 'session' : 'goal';
            const goalAuthority = tasks.find(t => t.id === op.taskId)?.goalAuthority === true;
            const turnId = identity(m.turnId) ?? (link?.taskId === op.taskId ? link.turnId : null);
            const result = m.result === 'accepted' || m.result === 'rejected' ? m.result : link?.result ?? null;
            events.push({ id: `op:${op.id}`, taskId: op.taskId, goalId: op.taskId, stageId: turnId,
                correlationId: turnId, at: op.at, clock: 'ledger-recorded', kind: 'review', scope, goalAuthority, turnId, result });
        }
    }
    if (sample) for (const raw of history) {
        const r = record(raw), m = record(r.metadata), taskId = identity(r.task_id), id = identity(r.id), at = date(r.created_at), turnId = identity(m.turnId);
        if (!id || !taskId || !at) continue;
        if (r.kind === 'delivery' && turnId) events.push({ id: `history:${id}`, taskId, goalId: taskId, stageId: turnId,
            correlationId: turnId, at, clock: 'ledger-recorded', kind: 'delivery_observed', turnId });
        if (r.kind === 'review' && !operations.some(op => op.id === identity(m.opId)) && turnId && turnId === identity(m.deliveryTurnId)) {
            events.push({ id: `op:${identity(m.opId) ?? id}`, taskId, goalId: taskId, stageId: turnId, correlationId: turnId,
                at, clock: 'ledger-recorded', kind: 'review', scope: 'goal', goalAuthority: tasks.find(t => t.id === taskId)?.goalAuthority === true, turnId,
                result: m.result === 'accepted' || m.result === 'rejected' ? m.result : null });
        }
    }
    return events;
}
/** Production adapter: consume the EXISTING authenticated parent snapshot, never fetch. */
export function normalizeOrchestraSnapshot(value: unknown, options: HostAdapterOptions): MetricsData {
    if (timestamp(options.asOf) === null) throw new Error('Parent asOf required');
    const r = record(value), c = record(r.collector);
    const valid = r.version === 1 && Array.isArray(r.tasks);
    const tasks = valid ? list(r.tasks).map(t => taskFrom(t, options, false)).filter((t): t is MetricTask => t !== null) : [];
    return {
        asOf: options.asOf, generatedAt: date(r.generatedAt), source: 'snapshot', tasks,
        events: operationEvents(parseOperations(r.operations, false), [], false, tasks), usage: options.usage ?? null, decisions: options.decisions === undefined ? normalizeT022Decisions(r.systemDecisions) : options.decisions,
        collector: { lastSuccessAt: date(c.lastSuccessAt), lastObservedAt: date(c.lastObservedAt), lastPollAt: date(c.lastPollAt), connected: bool(c.connected), stale: bool(c.stale) },
        coverage: { tasksComplete: valid && tasks.length === list(r.tasks).length, historyComplete: false, historyCoverage: { startAt: null, endAt: null, completeFamilies: [] }, reviewHistoryComplete: false,
            operationLimit: 50, operationsObserved: list(r.operations).length, artifactsExpected: null },
        errors: [...(options.refreshFailed ? ['parent_refresh_failed'] : []), ...(!valid ? ['snapshot_invalid'] : []), ...(c.error || c.lastError ? ['collector_error'] : [])],
        diagnostics: ['operations_last_50_only', 'bounded_history_has_no_stage_evidence', 'project_executor_require_authority', 'usage_requires_T016', 'historical_day_coverage_unknown']
    };
}
/** Offline-only allowlist sample path. Never treat this complete sample as online snapshot coverage. */
export function normalizeMetadataSample(value: unknown): MetricsData {
    const r = record(value), asOf = date(r.generatedAt);
    if (!asOf || r.version !== 1) throw new Error('Invalid real metadata sample');
    const options: HostAdapterOptions = { asOf };
    const tasks = list(r.tasks).map(t => taskFrom(t, options, true)).filter((t): t is MetricTask => t !== null);
    const scope = record(r.scope), c = record(r.collectorMeta);
    return {
        asOf, generatedAt: asOf, source: 'sanitized-sample', tasks,
        events: operationEvents(parseOperations(r.operations, true), list(r.history), true, tasks), usage: null, decisions: null,
        collector: { lastSuccessAt: date(c.collector_last_success_at), lastObservedAt: date(c.collector_last_observed_at), lastPollAt: date(c.last_poll_at),
            connected: bool(c.collector_connected), stale: null },
        coverage: { tasksComplete: tasks.length === list(r.tasks).length, historyComplete: scope.sampleIsCompleteLedgerMetadata === true,
            historyCoverage: { startAt: null, endAt: null, completeFamilies: [] },
            // Legacy reviews are unbound: even a complete metadata export cannot prove first attempt coverage.
            reviewHistoryComplete: false, operationLimit: null, operationsObserved: list(r.operations).length, artifactsExpected: null },
        errors: [], diagnostics: ['offline_real_metadata_only', 'ledger_delivery_time_is_observation', 'current_goal_turn_authority_missing', 'project_executor_unknown', 'usage_unavailable', 'historical_day_coverage_unknown']
    };
}
