/** Pure consumer of the already-aggregated snapshot.executorDaily block. No raw-log reads, no re-aggregation. */
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {});
export const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v : null;

export interface DailyGroup { dimensions: { executor: string | null; model: string | null; provider: string | null; taskType: string | null }; raw: Rec }
export interface DailyDay { date: string; groups: DailyGroup[] }
export interface ExecutorDaily {
    generatedAt: string | null; fileModifiedAt: string | null; coverage: Rec; current: Rec; days: DailyDay[];
}
export type DailyDimension = 'executor' | 'model' | 'provider' | 'taskType';
export type DailyFilter = Partial<Record<DailyDimension, string>>;
export const UNKNOWN = '__unknown__';
export const dimensions: DailyDimension[] = ['executor', 'model', 'provider', 'taskType'];

/** Returns null when the source block is unavailable or malformed. */
export function parseExecutorDaily(raw: unknown): ExecutorDaily | null {
    const block = rec(raw);
    if (block.available !== true) return null;
    const data = rec(block.data);
    if (!Array.isArray(data.days)) return null;
    const days: DailyDay[] = [];
    for (const d of data.days) {
        const day = rec(d); const date = str(day.date);
        if (!date || !Array.isArray(day.groups)) continue;
        days.push({ date, groups: day.groups.map(g => {
            const r = rec(g); const dim = rec(r.dimensions);
            return { raw: r, dimensions: { executor: str(dim.executor), model: str(dim.model), provider: str(dim.provider), taskType: str(dim.taskType) } };
        }) });
    }
    return { generatedAt: str(data.generatedAt), fileModifiedAt: str(block.fileModifiedAt), coverage: rec(data.coverage), current: rec(data.current), days };
}

const shanghaiDate = (iso: string): string | null => {
    const t = Date.parse(iso); if (Number.isNaN(t)) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
};
/** Reuses the page's existing rolling window: keeps source days whose Shanghai date lies in [start, end]. */
export function filterDaily(daily: ExecutorDaily, startIso: string, endIso: string, filter: DailyFilter): DailyDay[] {
    const from = shanghaiDate(startIso); const to = shanghaiDate(endIso);
    if (!from || !to) return [];
    const match = (g: DailyGroup) => dimensions.every(k => {
        const want = filter[k]; if (want === undefined) return true;
        const have = g.dimensions[k]; return want === UNKNOWN ? have === null : have === want;
    });
    return daily.days.filter(d => d.date >= from && d.date <= to).map(d => ({ date: d.date, groups: d.groups.filter(match) }));
}
export function dailyOptions(daily: ExecutorDaily, dim: DailyDimension): { values: string[]; hasUnknown: boolean } {
    const set = new Set<string>(); let hasUnknown = false;
    for (const d of daily.days) for (const g of d.groups) { const v = g.dimensions[dim]; if (v === null) hasUnknown = true; else set.add(v); }
    return { values: [...set].sort(), hasUnknown };
}

export interface GroupView {
    cohort: { started: number | null; delivered: number | null; failed: number | null; active: number | null; unknown: number | null };
    tokens: { input: number | null; output: number | null; cache: number | null; total: number | null; coveredTasks: number | null; eligibleTasks: number | null };
    review: { final: { passed: number | null; tasks: number | null }; first: { passed: number | null; tasks: number | null }; nonIndependentExcluded: number | null; pendingExcluded: number | null };
    timing: { name: string; n: number; medianMs: number | null; p95Ms: number | null; warning: string | null }[];
}
export function groupView(g: DailyGroup): GroupView {
    const tasks = rec(rec(g.raw.tasks).cohort); const usage = rec(g.raw.usage); const obs = rec(usage.observed);
    const reviews = rec(g.raw.reviews); const fin = rec(reviews.final); const first = rec(reviews.first);
    const timing = rec(g.raw.timing);
    return {
        cohort: { started: num(tasks.startedTasks), delivered: num(tasks.delivered), failed: num(tasks.failed), active: num(tasks.active), unknown: num(tasks.unknown) },
        tokens: { input: num(obs.input), output: num(obs.output), cache: num(obs.cache), total: num(obs.total), coveredTasks: num(usage.coveredTasks), eligibleTasks: num(usage.eligibleTasks) },
        review: { final: { passed: num(fin.passed), tasks: num(fin.tasks) }, first: { passed: num(first.passed), tasks: num(first.tasks) }, nonIndependentExcluded: num(reviews.nonIndependentExcluded), pendingExcluded: num(reviews.pendingExcluded) },
        timing: Object.entries(timing).map(([name, v]) => { const t = rec(v); return { name, n: num(t.n) ?? 0, medianMs: num(t.medianMs), p95Ms: num(t.p95Ms), warning: str(t.warning) }; }).filter(t => t.n > 0),
    };
}
