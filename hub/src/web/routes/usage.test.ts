import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ApiCostsResponse } from '@hapi/protocol/usage'
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
