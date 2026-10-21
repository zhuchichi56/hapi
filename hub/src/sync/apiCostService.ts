import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
    ApiCostPeriod,
    ApiCostProviderId,
    ApiCostSourceRow,
    ApiCostSummary,
    ApiCostsResponse
} from '@hapi/protocol/usage'

const PROVIDER_IDS: readonly ApiCostProviderId[] = ['getapikey', 'copilot', 'codex_pro', 'jev']
const PROVIDER_NAMES: Record<ApiCostProviderId, string> = {
    getapikey: 'Get APIKey',
    copilot: 'Copilot',
    codex_pro: 'Codex Pro',
    jev: 'JEV'
}

type JsonRecord = Record<string, unknown>
type GroupFields = Omit<ApiCostSummary, 'coverageComplete'>

function asRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
}

export function getApiCostSnapshotPath(): string {
    return join(homedir(), '.local/share/api-usage-monitor/snapshot.json')
}

function parseCount(record: JsonRecord, key: string): number | null {
    const value = record[key]
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** undefined means absent or invalid; null is the snapshot's intentional unknown. */
function parseMoney(record: JsonRecord, key: string): number | null | undefined {
    const value = record[key]
    if (value === null) return null
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function parseGroup(record: JsonRecord): GroupFields | null {
    const requests = parseCount(record, 'requests')
    const pricedRequests = parseCount(record, 'pricedRequests')
    const missingUsage = parseCount(record, 'missingUsage')
    const supplierPricedRequests = parseCount(record, 'supplierPricedRequests')
    const equivalentUSD = parseMoney(record, 'equivalentUSD')
    const supplierEstimatedUSD = parseMoney(record, 'supplierEstimatedUSD')
    const actualUSD = parseMoney(record, 'actualUSD')
    if (requests === null || pricedRequests === null || missingUsage === null
        || supplierPricedRequests === null || equivalentUSD === undefined
        || supplierEstimatedUSD === undefined || actualUSD === undefined) {
        return null
    }
    return {
        requests,
        pricedRequests,
        missingUsage,
        equivalentUSD,
        supplierEstimatedUSD,
        supplierPricedRequests,
        actualUSD
    }
}

function parseSource(value: unknown, id: ApiCostProviderId): ApiCostSourceRow | null {
    const record = asRecord(value)
    if (!record || record.id !== id || typeof record.coverageComplete !== 'boolean') return null
    const group = parseGroup(record)
    return group
        ? { id, name: PROVIDER_NAMES[id], ...group, coverageComplete: record.coverageComplete }
        : null
}

function parsePeriod(value: unknown): ApiCostPeriod | null {
    const record = asRecord(value)
    const summaryRecord = asRecord(record?.summary)
    const rows = record?.sources
    if (!summaryRecord || !Array.isArray(rows)) return null
    const summary = parseGroup(summaryRecord)
    if (!summary) return null
    const sources: ApiCostSourceRow[] = []
    for (const id of PROVIDER_IDS) {
        const row = rows.find((candidate) => asRecord(candidate)?.id === id)
        const source = parseSource(row, id)
        if (!source) return null
        sources.push(source)
    }
    // The dashboard does not flag summary completeness; it is complete only
    // when every required source reports its own coverage as complete.
    return { summary: { ...summary, coverageComplete: sources.every((source) => source.coverageComplete) }, sources }
}

function parseUpdatedAt(root: JsonRecord, sourceUsage: JsonRecord): string | null {
    for (const candidate of [sourceUsage.updatedAt, root.updatedAt]) {
        if (typeof candidate !== 'string' || candidate.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(candidate)) continue
        const timestamp = Date.parse(candidate)
        if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
    }
    return null
}

/**
 * Read the local dashboard accounting snapshot. Never makes network calls and
 * never exposes raw fields: unsupported data becomes a typed unavailable result.
 */
export async function readApiCosts(snapshotPath: string = getApiCostSnapshotPath()): Promise<ApiCostsResponse> {
    let raw: string
    try {
        raw = await readFile(snapshotPath, 'utf8')
    } catch (error) {
        return {
            available: false,
            reason: (error as { code?: unknown }).code === 'ENOENT' ? 'missing' : 'unreadable'
        }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return { available: false, reason: 'malformed' }
    }
    const root = asRecord(parsed)
    if (!root) return { available: false, reason: 'malformed' }

    const nested = asRecord(root.sourceUsage)
    const sourceUsage = nested && asRecord(nested.periods)
        ? nested
        : asRecord(root.periods) ? root : null
    if (!sourceUsage) return { available: false, reason: 'incomplete' }

    const updatedAt = parseUpdatedAt(root, sourceUsage)
    const periods = asRecord(sourceUsage.periods)
    if (!updatedAt || !periods) return { available: false, reason: 'incomplete' }

    const today = parsePeriod(periods.today)
    const month = parsePeriod(periods.month)
    const all = parsePeriod(periods.all)
    if (!today || !month || !all) return { available: false, reason: 'incomplete' }

    return { available: true, updatedAt, periods: { today, month, all } }
}
