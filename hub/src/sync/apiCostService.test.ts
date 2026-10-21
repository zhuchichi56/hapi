import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiCostsAvailableResponse } from '@hapi/protocol/usage'
import { readApiCosts } from './apiCostService'

const SECRET = 'SENTINEL_SECRET_9f3a'
const PERSONAL = 'sentinel.person@example.invalid'
const PROVIDERS = ['getapikey', 'copilot', 'codex_pro', 'jev'] as const
const SUMMARY_KEYS = [
    'actualUSD',
    'coverageComplete',
    'equivalentUSD',
    'missingUsage',
    'pricedRequests',
    'requests',
    'supplierEstimatedUSD',
    'supplierPricedRequests'
].sort()
const SOURCE_KEYS = [...SUMMARY_KEYS, 'id', 'name'].sort()

const roots: string[] = []

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-api-cost-'))
    roots.push(dir)
    return dir
}

function writeSnapshot(document: unknown): string {
    const path = join(tempDir(), 'snapshot.json')
    writeFileSync(path, JSON.stringify(document))
    return path
}

function metric(overrides: Record<string, unknown> = {}) {
    return {
        requests: 4,
        failures: 1,
        inputTokens: 1000,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 0,
        missingUsage: 1,
        pricedRequests: 3,
        equivalentUSD: 1.25,
        supplierEstimatedUSD: 2.5,
        supplierPricedRequests: 2,
        actualUSD: null,
        unpricedRequests: 1,
        recordedSince: '2026-10-01',
        recordedDays: 21,
        apiKey: SECRET,
        email: PERSONAL,
        ...overrides
    }
}

function sourceRow(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name: `Snapshot ${id}`,
        enabled: true,
        pending: false,
        statusLabel: SECRET,
        statusNote: PERSONAL,
        coverageComplete: true,
        ...metric(),
        ...overrides
    }
}

function period(overrides: Record<string, unknown> = {}) {
    return {
        summary: metric(),
        sources: PROVIDERS.map((id) => sourceRow(id)),
        models: [{ provider: 'getapikey', model: 'sentinel-model', email: PERSONAL }],
        ...overrides
    }
}

function snapshot(sourceUsageOverrides: Record<string, unknown> = {}) {
    return {
        updatedAt: '2026-10-21T08:01:00+00:00',
        sourceUsage: {
            updatedAt: '2026-10-21T08:00:00+00:00',
            periods: { today: period(), month: period(), all: period() },
            coverage: { proxy: { available: true, first: SECRET, latest: PERSONAL } },
            errors: [SECRET],
            configuredSources: 4,
            enabledSources: 4,
            oauthAccounts: 2,
            unclassifiedRecords: 0,
            billingNote: PERSONAL,
            coverageNote: SECRET,
            ...sourceUsageOverrides
        },
        officialQuota: { accounts: [{ email: PERSONAL }] },
        copilot: { quota: { email: PERSONAL } },
        personal: { email: PERSONAL },
        apiKey: SECRET
    }
}

function available(result: Awaited<ReturnType<typeof readApiCosts>>): ApiCostsAvailableResponse {
    if (!result.available) throw new Error(`expected available snapshot, got ${result.reason}`)
    return result
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true })
    }
})

describe('readApiCosts', () => {
    it('returns only whitelisted fields with hardcoded source names', async () => {
        const result = available(await readApiCosts(writeSnapshot(snapshot())))

        expect(result.updatedAt).toBe('2026-10-21T08:00:00.000Z')
        expect(Object.keys(result).sort()).toEqual(['available', 'periods', 'updatedAt'])
        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain(SECRET)
        expect(serialized).not.toContain(PERSONAL)
        for (const field of ['apiKey', 'email', 'account', 'quota', 'coverage', 'errors', 'models', 'inputTokens', 'projects', 'statusNote']) {
            expect(serialized).not.toContain(`"${field}"`)
        }

        for (const key of ['today', 'month', 'all'] as const) {
            const bucket = result.periods[key]
            expect(Object.keys(bucket).sort()).toEqual(['sources', 'summary'])
            expect(Object.keys(bucket.summary).sort()).toEqual(SUMMARY_KEYS)
            expect(bucket.sources).toHaveLength(4)
            expect(bucket.sources.map((source) => source.id)).toEqual([...PROVIDERS])
            expect(bucket.sources.map((source) => source.name)).toEqual(['Get APIKey', 'Copilot', 'Codex Pro', 'JEV'])
            for (const source of bucket.sources) {
                expect(Object.keys(source).sort()).toEqual(SOURCE_KEYS)
            }
        }
    })

    it('preserves null monetary values instead of turning them into zero', async () => {
        const document = snapshot()
        const nullMoney = { equivalentUSD: null, supplierEstimatedUSD: null, actualUSD: null }
        for (const key of ['today', 'month', 'all'] as const) {
            document.sourceUsage.periods[key] = period({
                summary: metric(nullMoney),
                sources: PROVIDERS.map((id) => sourceRow(id, nullMoney))
            })
        }

        const result = available(await readApiCosts(writeSnapshot(document)))
        const today = result.periods.today
        expect(today.summary.equivalentUSD).toBeNull()
        expect(today.summary.supplierEstimatedUSD).toBeNull()
        expect(today.summary.actualUSD).toBeNull()
        expect(today.sources[0]?.equivalentUSD).toBeNull()
        expect(today.sources[0]?.supplierEstimatedUSD).toBeNull()
        expect(today.sources[0]?.actualUSD).toBeNull()
        expect(today.summary.requests).toBe(4)
        expect(today.summary.pricedRequests).toBe(3)
    })

    it('keeps partial pricing coverage partial without summing or repricing', async () => {
        const document = snapshot()
        document.sourceUsage.periods.today = period({
            summary: metric({
                requests: 12,
                pricedRequests: 6,
                supplierPricedRequests: 4,
                missingUsage: 4,
                equivalentUSD: 9.5,
                supplierEstimatedUSD: 7.25,
                actualUSD: null
            }),
            sources: [
                sourceRow('getapikey', { requests: 7, pricedRequests: 4, supplierPricedRequests: 3, missingUsage: 2, coverageComplete: false }),
                sourceRow('copilot', { requests: 3, pricedRequests: 2 }),
                sourceRow('codex_pro', { requests: 0, pricedRequests: 0, supplierPricedRequests: 0, missingUsage: 0, equivalentUSD: null, supplierEstimatedUSD: null }),
                sourceRow('jev', { requests: 0, pricedRequests: 0, supplierPricedRequests: 0, missingUsage: 0, equivalentUSD: null, supplierEstimatedUSD: null })
            ]
        })

        const today = available(await readApiCosts(writeSnapshot(document))).periods.today
        expect(today.summary.requests).toBe(12)
        expect(today.summary.pricedRequests).toBe(6)
        expect(today.summary.supplierPricedRequests).toBe(4)
        expect(today.summary.equivalentUSD).toBe(9.5)
        expect(today.summary.coverageComplete).toBe(false)
        expect(today.sources[0]?.requests).toBe(7)
        expect(today.sources[0]?.pricedRequests).toBe(4)
        expect(today.sources[0]?.coverageComplete).toBe(false)
        expect(today.sources[1]?.coverageComplete).toBe(true)
    })

    it('accepts the raw source snapshot with top-level periods', async () => {
        const raw = snapshot().sourceUsage
        const result = available(await readApiCosts(writeSnapshot(raw)))
        expect(result.updatedAt).toBe('2026-10-21T08:00:00.000Z')
        expect(result.periods.all.sources).toHaveLength(4)
    })

    it('returns unavailable for a missing snapshot', async () => {
        const result = await readApiCosts(join(tempDir(), 'absent.json'))
        expect(result).toEqual({ available: false, reason: 'missing' })
    })

    it('returns unavailable for malformed JSON', async () => {
        const path = join(tempDir(), 'snapshot.json')
        writeFileSync(path, '{"sourceUsage":')
        expect(await readApiCosts(path)).toEqual({ available: false, reason: 'malformed' })
    })

    it('returns unavailable rather than zeros for incomplete or unsupported shapes', async () => {
        const missingSource = snapshot()
        missingSource.sourceUsage.periods.today.sources.pop()
        const missingMoney = snapshot()
        delete (missingMoney.sourceUsage.periods.month.summary as Record<string, unknown>).equivalentUSD
        const wrongMoneyType = snapshot()
        ;(wrongMoneyType.sourceUsage.periods.all.summary as Record<string, unknown>).actualUSD = '0.00'
        const negativeCount = snapshot()
        negativeCount.sourceUsage.periods.today.summary.requests = -1
        const missingPeriod = snapshot({ periods: { today: period(), month: period() } })

        for (const document of [missingSource, missingMoney, wrongMoneyType, negativeCount, missingPeriod]) {
            expect(await readApiCosts(writeSnapshot(document))).toEqual({ available: false, reason: 'incomplete' })
        }
    })
})
