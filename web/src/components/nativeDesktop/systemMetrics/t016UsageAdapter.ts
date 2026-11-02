import { timestamp, type StageUsageSnapshot, type UsageAdapter } from './systemMetrics';

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const id = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,127}$/.test(value) ? value : null;
const date = (value: unknown): string | null => typeof value === 'string' && timestamp(value) !== null ? value : null;
const tokens = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export interface T016StageBinding {
    taskId: string;
    stageId: string;
    phaseId: string;
    /** Explicitly verified by T016 owner; not inferred from task labels. */
    model: string;
    clock: string;
}
export interface T016AdapterResult { usage: UsageAdapter | null; diagnostics: string[] }
/** Optional consumption of T016 phase_metrics/v1 output. No reads, collection or T016 reimplementation.
 * T016 has already deduplicated and bounded each turn. We only normalize cache conventions
 * and bind the independently named system stage to the explicit T016 phase.
 */
export function normalizeT016Phase(value: unknown, binding: T016StageBinding): T016AdapterResult {
    const r = object(value), phase = object(r.phase);
    if (r.schema !== 'phase_metrics/v1' || r.ok !== true || !id(binding.taskId) || !id(binding.stageId) || !id(binding.phaseId) || !id(binding.model) || !id(binding.clock) ||
        phase.taskId !== binding.taskId || phase.phaseId !== binding.phaseId || !date(phase.startedAt)) {
        return { usage: null, diagnostics: ['T016_phase_binding_unverified'] };
    }
    const expectedMeterIds = new Set<string>(), snapshots: StageUsageSnapshot[] = [], diagnostics = new Set<string>();
    const turns: unknown[] = Array.isArray(r.turns) ? r.turns : [];
    for (const raw of turns) {
        const turn = object(raw), u = object(turn.usage), threadId = id(turn.threadId), turnId = id(turn.turnId);
        if (!threadId || !turnId) { diagnostics.add('T016_turn_identity_missing'); continue; }
        const meterId = JSON.stringify([threadId, turnId]);
        expectedMeterIds.add(meterId);
        const observedAt = date(turn.observedAt), startedAt = date(turn.startedAt), completedAt = date(turn.completedAt);
        if (u.state !== 'accepted' || u.basis !== 'turn_total' || u.source !== 'native_turn_usage' ||
            turn.wholeTurnInPhase !== true || u.wholeTurnEligible !== true || !observedAt || !startedAt || !completedAt) {
            diagnostics.add('T016_turn_usage_missing_or_outside_phase'); continue;
        }
        const input = tokens(u.inputTokens), output = tokens(u.outputTokens), read = tokens(u.cacheReadInputTokens), write = tokens(u.cacheWriteInputTokens);
        const cacheSum = read !== null && write !== null && Number.isSafeInteger(read + write) ? read + write : null;
        let canonicalInput: number | null = null, cache: number | null = null;
        if (u.cacheConvention === 'included_in_input') {
            canonicalInput = input;
            cache = cacheSum;
            if (input !== null && cache !== null && cache > input) { diagnostics.add('T016_cache_exceeds_input'); continue; }
        } else if (u.cacheConvention === 'separate_from_input') {
            // Upstream input excludes cache: add it ONCE when both cache fields are known.
            canonicalInput = input !== null && cacheSum !== null && Number.isSafeInteger(input + cacheSum) ? input + cacheSum : null;
            cache = canonicalInput !== null ? cacheSum : null;
        } else diagnostics.add('T016_cache_convention_unknown');
        snapshots.push({ taskId: binding.taskId, stageId: binding.stageId, phaseId: binding.phaseId,
            id: `T016:${meterId}`, meterId, observedAt, periodStart: startedAt, periodEnd: completedAt,
            clock: binding.clock, source: 'T016/native_turn_usage', model: binding.model, coverageKnown: true,
            input: canonicalInput, output, cache });
    }
    return { usage: {
        expectedStages: [{ taskId: binding.taskId, stageId: binding.stageId, phaseId: binding.phaseId,
            expectedMeterIds: [...expectedMeterIds].sort(), startedAt: date(phase.startedAt)!, endedAt: date(phase.endedAt) }],
        // A complete phase is not proof of the complete SYSTEM window. The owner must
        // merge all expected stages and explicitly assert system coverage later.
        expectedStagesComplete: false,
        snapshots
    }, diagnostics: [...diagnostics].sort() };
}
