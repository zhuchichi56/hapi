import { expect, it } from 'vitest';
import { dailyOptions, filterDaily, groupView, parseExecutorDaily, UNKNOWN } from './executorDaily';
const g = (executor: string, model: string | null, provider: string | null, usage: any = {}, started = 1) => ({ dimensions: { executor, model, provider, taskType: 't' }, tasks: { cohort: { startedTasks: started, delivered: 1, failed: 0, active: 0, unknown: 0 } }, usage, reviews: { final: { passed: 1, tasks: 1 }, first: { passed: 1, tasks: 1 } }, timing: { runner_total: { n: 1, medianMs: 50123, p95Ms: 50123, warning: 'single_sample' }, queue: { n: 0, medianMs: null, p95Ms: null } } });
const block = { available: true, fileModifiedAt: 'x', data: { generatedAt: '2026-11-03T14:58:11Z', coverage: {}, current: {}, days: [{ date: '2026-11-03', groups: [
    g('codex', 'm1', 'p1', { observed: { input: 100, cache: 40, output: 5, total: 105 }, coveredTasks: 1, eligibleTasks: 1 }), g('dsh', null, null, { observed: { input: null, cache: null, output: 896, total: null } }), g('browser', null, null, {}, 0)] }] } };
it('keeps dimensions and null unknowns, filters by dimension', () => {
    const d = parseExecutorDaily(block)!;
    expect(d.days[0]!.groups).toHaveLength(3);
    expect(dailyOptions(d, 'model')).toEqual({ values: ['m1'], hasUnknown: true });
    const out = filterDaily(d, '2026-11-01T00:00:00Z', '2026-11-05T01:00:00Z', { model: UNKNOWN });
    expect(out[0]!.groups.map(x => x.dimensions.executor)).toEqual(['dsh', 'browser']);
    expect(filterDaily(d, '2026-11-04T00:00:00Z', '2026-11-05T01:00:00Z', {})).toEqual([]);
});
it('does not turn nulls into zero or add cache to input', () => {
    const d = parseExecutorDaily(block)!;
    const [a, b] = d.days[0]!.groups.map(groupView);
    expect(a!.tokens).toMatchObject({ input: 100, cache: 40, total: 105 });
    expect(b!.tokens).toMatchObject({ input: null, cache: null, total: null, output: 896 });
    expect(a!.timing).toEqual([{ name: 'runner_total', n: 1, medianMs: 50123, p95Ms: 50123, warning: 'single_sample' }]);
});
it('rejects unavailable or malformed blocks', () => {
    expect(parseExecutorDaily({ available: false })).toBeNull();
    expect(parseExecutorDaily(null)).toBeNull();
    expect(parseExecutorDaily({ available: true, data: {} })).toBeNull();
});
