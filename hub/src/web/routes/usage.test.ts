import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ApiCostsResponse, QuotasResponse } from '@hapi/protocol/usage'
import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createUsageRoutes, type UsageRoutesOptions } from './usage'

function createApp(store: Store, namespace: string, options?: UsageRoutesOptions): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createUsageRoutes(store, options))
    return app
}

function zeroSummary() {
    return {
        requests: 0,
        pricedRequests: 0,
        missingUsage: 0,
        equivalentUSD: null,
        supplierEstimatedUSD: null,
        supplierPricedRequests: 0,
        actualUSD: null,
        coverageComplete: true
    }
}

function availableCosts(): ApiCostsResponse {
    const summary = zeroSummary()
    const sources = (['getapikey', 'copilot', 'codex_pro', 'jev'] as const).map((id) => ({
        ...summary,
        id,
        name: id
    }))
    const period = { summary, sources }
    return {
        available: true,
        updatedAt: '2026-10-21T08:00:00.000Z',
        periods: { today: period, month: period, all: period }
    }
}

function snapshotPeriod() {
    const summary = zeroSummary()
    return {
        summary,
        sources: (['getapikey', 'copilot', 'codex_pro', 'jev'] as const).map((id) => ({
            ...summary,
            id,
            name: 'SENTINEL_NAME'
        }))
    }
}

function availableQuotas(): QuotasResponse {
    const providers = [
        ['copilot', 'Copilot'],
        ['getapikey', 'Get APIKey'],
        ['codex_pro', 'Codex Pro'],
        ['claude_1', 'Claude 1'],
        ['claude_2', 'Claude 2'],
        ['claude_3', 'Claude 3']
    ] as const
    return {
        available: true,
        updatedAt: '2026-10-21T08:00:00.000Z',
        providers: providers.map(([id, name]) => ({
            id,
            name,
            state: 'ok' as const,
            checkedAt: '2026-10-21T07:59:00.000Z',
            remainingPercent: 50,
            fiveHour: null,
            sevenDay: null,
            unlimited: false,
            resetDate: null,
            spentPoints: null
        }))
    }
}

describe('GET /api/usage/summary', () => {
    it('returns a no-store summary for the hub owner', async () => {
        const store = new Store(':memory:')
        try {
            const response = await createApp(store, 'default').request('/api/usage/summary?range=30d')

            expect(response.status).toBe(200)
            expect(response.headers.get('cache-control')).toBe('no-store')
            const body = await response.json() as { range: { from: number | null; to: number | null }; totals: { requests: number } }
            expect(typeof body.range.from).toBe('number')
            expect(typeof body.range.to).toBe('number')
            expect(body.totals.requests).toBe(0)
        } finally {
            store.close()
        }
    })

    it('rejects non-default namespaces', async () => {
        const store = new Store(':memory:')
        try {
            const response = await createApp(store, 'tenant').request('/api/usage/summary')

            expect(response.status).toBe(403)
            expect(await response.json()).toEqual({ error: 'Usage summary is only available to the hub owner' })
        } finally {
            store.close()
        }
    })

    it('validates IANA time zones', async () => {
        const store = new Store(':memory:')
        try {
            for (const timeZone of ['America/New_York', 'Asia/Shanghai']) {
                const response = await createApp(store, 'default').request(`/api/usage/summary?timeZone=${encodeURIComponent(timeZone)}`)
                expect(response.status).toBe(200)
            }
            for (const timeZone of ['Mars/Olympus', 'x'.repeat(101)]) {
                const response = await createApp(store, 'default').request(`/api/usage/summary?timeZone=${encodeURIComponent(timeZone)}`)
                expect(response.status).toBe(400)
            }
        } finally {
            store.close()
        }
    })
})

describe('GET /api/usage/costs', () => {
    it('rejects non-default namespaces before reading the snapshot', async () => {
        const store = new Store(':memory:')
        let reads = 0
        try {
            const response = await createApp(store, 'tenant', {
                readCosts: async () => {
                    reads += 1
                    return { available: false, reason: 'missing' }
                }
            }).request('/api/usage/costs')

            expect(response.status).toBe(403)
            expect(reads).toBe(0)
            expect(await response.json()).toEqual({ error: 'API costs are only available to the hub owner' })
        } finally {
            store.close()
        }
    })

    it('sets no-store for available and unavailable responses', async () => {
        const store = new Store(':memory:')
        try {
            const responses: ApiCostsResponse[] = [
                availableCosts(),
                { available: false, reason: 'missing' }
            ]
            for (const body of responses) {
                const response = await createApp(store, 'default', {
                    readCosts: async () => body
                }).request('/api/usage/costs')

                expect(response.status).toBe(200)
                expect(response.headers.get('cache-control')).toBe('no-store')
                expect(await response.json()).toEqual(body)
            }
        } finally {
            store.close()
        }
    })

    it('serves a sanitized snapshot from the configured local path', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-usage-costs-'))
        const store = new Store(':memory:')
        try {
            const period = snapshotPeriod()
            const path = join(directory, 'snapshot.json')
            writeFileSync(path, JSON.stringify({
                updatedAt: '2026-10-21T08:01:00+00:00',
                sourceUsage: {
                    updatedAt: '2026-10-21T08:00:00+00:00',
                    periods: { today: period, month: period, all: period },
                    secret: 'SENTINEL_SECRET'
                }
            }))

            const response = await createApp(store, 'default', { apiCostSnapshotPath: path }).request('/api/usage/costs')
            expect(response.status).toBe(200)
            expect(response.headers.get('cache-control')).toBe('no-store')
            const text = await response.text()
            expect(text).not.toContain('SENTINEL')
            const body = JSON.parse(text) as ApiCostsResponse
            expect(body.available).toBe(true)
            if (body.available) {
                expect(body.periods.today.sources.map((source) => source.name)).toEqual(['Get APIKey', 'Copilot', 'Codex Pro', 'JEV'])
            }
        } finally {
            store.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})

describe('GET /api/usage/quotas', () => {
    it('rejects non-default namespaces before reading the snapshot', async () => {
        const store = new Store(':memory:')
        let reads = 0
        try {
            const response = await createApp(store, 'tenant', {
                readQuotas: async () => {
                    reads += 1
                    return { available: false, reason: 'missing' }
                }
            }).request('/api/usage/quotas')

            expect(response.status).toBe(403)
            expect(reads).toBe(0)
            expect(await response.json()).toEqual({ error: 'Quotas are only available to the hub owner' })
        } finally {
            store.close()
        }
    })

    it('sets no-store for available and unavailable responses', async () => {
        const store = new Store(':memory:')
        try {
            const responses: QuotasResponse[] = [
                availableQuotas(),
                { available: false, reason: 'missing' }
            ]
            for (const body of responses) {
                const response = await createApp(store, 'default', {
                    readQuotas: async () => body
                }).request('/api/usage/quotas')

                expect(response.status).toBe(200)
                expect(response.headers.get('cache-control')).toBe('no-store')
                expect(await response.json()).toEqual(body)
            }
        } finally {
            store.close()
        }
    })

    it('serves a sanitized snapshot from the configured local path', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-usage-quotas-'))
        const store = new Store(':memory:')
        try {
            const path = join(directory, 'snapshot.json')
            writeFileSync(path, JSON.stringify({
                updatedAt: '2026-10-21T08:01:00+00:00',
                copilot: {
                    quotaCheckedAt: '2026-10-21T08:00:00+00:00',
                    quota: {
                        resetDate: '2026-10-22',
                        premiumInteractions: {
                            percent_remaining: 33,
                            unlimited: false,
                            email: 'SENTINEL_EMAIL'
                        }
                    },
                    email: 'SENTINEL_EMAIL'
                },
                email: 'SENTINEL_EMAIL'
            }))

            const response = await createApp(store, 'default', { quotaSnapshotPath: path }).request('/api/usage/quotas')
            expect(response.status).toBe(200)
            expect(response.headers.get('cache-control')).toBe('no-store')
            const text = await response.text()
            expect(text).not.toContain('SENTINEL')
            const body = JSON.parse(text) as QuotasResponse
            expect(body.available).toBe(true)
            if (body.available) {
                expect(body.providers.map((provider) => provider.name)).toEqual([
                    'Copilot',
                    'Get APIKey',
                    'Codex Pro',
                    'Claude 1',
                    'Claude 2',
                    'Claude 3'
                ])
                expect(body.providers[0]?.remainingPercent).toBe(33)
            }
        } finally {
            store.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
