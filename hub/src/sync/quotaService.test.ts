import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QuotasAvailableResponse } from '@hapi/protocol/usage'
import { readQuotaSnapshot } from './quotaService'

const SECRET = 'SENTINEL_SECRET_7c2e'
const PERSONAL = 'sentinel.person@example.invalid'
const ROOT_UPDATED = '2026-10-21T08:00:00+00:00'
const FIVE_RESET = 1792600000
const SEVEN_RESET = 1793000000

type WindowInput = Record<string, unknown>
type OfficialAccount = { windows?: WindowInput[]; email?: string }
type ClaudeAccount = {
    state?: unknown
    fiveHour?: WindowInput
    sevenDay?: WindowInput
    identity?: string
}
type Snapshot = {
    updatedAt?: unknown
    copilot?: {
        quotaCheckedAt?: unknown
        quota?: {
            resetDate?: unknown
            premiumInteractions?: Record<string, unknown>
        }
    }
    supplierQuota?: Record<string, unknown>
    officialQuota?: {
        checkedAt?: unknown
        state?: unknown
        accounts?: OfficialAccount[]
        detail?: string
    }
    claudeQuota?: {
        checkedAt?: unknown
        accounts?: ClaudeAccount[]
        errors?: string[]
        apiKey?: string
    }
    [key: string]: unknown
}

const PROVIDER_KEYS = [
    'checkedAt',
    'fiveHour',
    'id',
    'name',
    'remainingPercent',
    'resetDate',
    'sevenDay',
    'spentPoints',
    'state',
    'unlimited'
].sort()

const roots: string[] = []

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-quota-'))
    roots.push(dir)
    return dir
}

function writeSnapshot(document: unknown): string {
    const path = join(tempDir(), 'snapshot.json')
    writeFileSync(path, JSON.stringify(document))
    return path
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
    return {
        updatedAt: ROOT_UPDATED,
        copilot: {
            quotaCheckedAt: '2026-10-21T07:59:00+00:00',
            quota: {
                resetDate: '2026-10-22',
                premiumInteractions: {
                    remaining: 425,
                    entitlement: 1000,
                    percent_remaining: 42.5,
                    unlimited: false,
                    email: PERSONAL
                }
            }
        },
        supplierQuota: {
            checkedAt: '2026-10-21T07:58:00+00:00',
            state: 'ok',
            remainingPercent: 75,
            spentPoints: 120.5,
            detail: SECRET
        },
        officialQuota: {
            checkedAt: '2026-10-21T07:57:00+00:00',
            state: 'ok',
            accounts: [
                {
                    email: PERSONAL,
                    windows: [
                        { seconds: 18000, remaining: 50, resetAt: FIVE_RESET, identity: PERSONAL },
                        { seconds: 604800, remaining: 80, resetAt: SEVEN_RESET }
                    ]
                }
            ],
            detail: SECRET
        },
        claudeQuota: {
            checkedAt: '2026-10-21T07:56:00+00:00',
            accounts: [
                {
                    state: 'ok',
                    identity: PERSONAL,
                    fiveHour: { remaining: 40, resetAt: '2026-10-21T12:00:00Z' },
                    sevenDay: { remaining: 20, resetAt: '2026-10-27T00:00:00Z' }
                },
                {
                    state: 'ok',
                    identity: PERSONAL,
                    fiveHour: { remaining: 30, resetAt: '2026-10-21T13:00:00Z' },
                    sevenDay: { remaining: 90, resetAt: '2026-10-28T00:00:00Z' }
                },
                {
                    state: 'error',
                    identity: PERSONAL,
                    fiveHour: { remaining: 1, resetAt: '2026-10-21T14:00:00Z' },
                    sevenDay: { remaining: 1, resetAt: '2026-10-29T00:00:00Z' }
                }
            ],
            errors: [SECRET],
            apiKey: SECRET
        },
        apiKey: SECRET,
        ...overrides
    }
}

function available(result: Awaited<ReturnType<typeof readQuotaSnapshot>>): QuotasAvailableResponse {
    if (!result.available) throw new Error(`expected available snapshot, got ${result.reason}`)
    return result
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true })
    }
})

describe('readQuotaSnapshot', () => {
    it('returns only whitelisted fields, fixed names, and normalized timestamps', async () => {
        const result = available(await readQuotaSnapshot(writeSnapshot(snapshot())))

        expect(Object.keys(result).sort()).toEqual(['available', 'providers', 'updatedAt'])
        expect(result.updatedAt).toBe('2026-10-21T08:00:00.000Z')
        expect(result.providers.map((provider) => provider.id)).toEqual([
            'copilot',
            'getapikey',
            'codex_pro',
            'claude_1',
            'claude_2',
            'claude_3'
        ])
        expect(result.providers.map((provider) => provider.name)).toEqual([
            'Copilot',
            'Get APIKey',
            'Codex Pro',
            'Claude 1',
            'Claude 2',
            'Claude 3'
        ])

        const serialized = JSON.stringify(result)
        for (const value of [SECRET, PERSONAL]) {
            expect(serialized).not.toContain(value)
        }
        for (const field of ['email', 'identity', 'detail', 'apiKey', 'accounts', 'quota', 'errors', 'path', 'token', 'password']) {
            expect(serialized).not.toContain(`"${field}"`)
        }
        for (const provider of result.providers) {
            expect(Object.keys(provider).sort()).toEqual(PROVIDER_KEYS)
            for (const window of [provider.fiveHour, provider.sevenDay]) {
                if (window !== null) expect(Object.keys(window).sort()).toEqual(['remainingPercent', 'resetAt'])
            }
        }
    })

    it('preserves zero and null percentages and accepts unlimited only when it is true', async () => {
        const document = snapshot()
        document.copilot!.quota!.premiumInteractions = { percent_remaining: 0, unlimited: true }
        let result = available(await readQuotaSnapshot(writeSnapshot(document)))
        let copilot = result.providers[0]!
        expect(copilot.remainingPercent).toBe(0)
        expect(copilot.unlimited).toBe(true)
        expect(copilot.resetDate).toBe('2026-10-22')

        document.copilot!.quota!.premiumInteractions = { percent_remaining: null, unlimited: 'true' }
        result = available(await readQuotaSnapshot(writeSnapshot(document)))
        copilot = result.providers[0]!
        expect(copilot.remainingPercent).toBeNull()
        expect(copilot.unlimited).toBe(false)

        document.copilot!.quota!.premiumInteractions = { percent_remaining: 12, unlimited: 1 }
        result = available(await readQuotaSnapshot(writeSnapshot(document)))
        expect(result.providers[0]!.unlimited).toBe(false)
    })

    it('keeps a supplier null percentage with valid spent points separate from zero', async () => {
        const document = snapshot()
        document.supplierQuota = {
            checkedAt: '2026-10-21T07:58:00+00:00',
            state: 'ok',
            remainingPercent: null,
            spentPoints: 0
        }
        const result = available(await readQuotaSnapshot(writeSnapshot(document)))
        const supplier = result.providers[1]!
        expect(supplier.state).toBe('ok')
        expect(supplier.remainingPercent).toBeNull()
        expect(supplier.spentPoints).toBe(0)

        document.supplierQuota = {
            checkedAt: '2026-10-21T07:58:00+00:00',
            state: 'ok',
            remainingPercent: 0,
            spentPoints: 12
        }
        const zero = available(await readQuotaSnapshot(writeSnapshot(document))).providers[1]!
        expect(zero.remainingPercent).toBe(0)
        expect(zero.spentPoints).toBe(12)
    })

    it('reports partial sections and absent Claude accounts without inventing values', async () => {
        const document = snapshot()
        delete document.supplierQuota
        delete document.officialQuota
        delete document.claudeQuota
        const result = available(await readQuotaSnapshot(writeSnapshot(document)))
        expect(result.providers.map((provider) => provider.state)).toEqual([
            'ok',
            'missing',
            'missing',
            'missing',
            'missing',
            'missing'
        ])

        const emptyAccounts = snapshot({
            claudeQuota: {
                checkedAt: '2026-10-21T07:56:00+00:00',
                accounts: []
            }
        })
        expect(available(await readQuotaSnapshot(writeSnapshot(emptyAccounts))).providers.slice(3).map((provider) => provider.state))
            .toEqual(['missing', 'missing', 'missing'])

        const noAccounts = snapshot({
            claudeQuota: { checkedAt: '2026-10-21T07:56:00+00:00' }
        })
        expect(available(await readQuotaSnapshot(writeSnapshot(noAccounts))).providers.slice(3).map((provider) => provider.state))
            .toEqual(['unavailable', 'unavailable', 'unavailable'])

        const base = available(await readQuotaSnapshot(writeSnapshot(snapshot())))
        expect(base.providers[3]!.state).toBe('ok')
        expect(base.providers[4]!.state).toBe('ok')
        expect(base.providers[5]!.state).toBe('unavailable')
        expect(base.providers[5]!.remainingPercent).toBeNull()
        expect(base.providers[5]!.fiveHour).toBeNull()
        expect(base.providers[5]!.checkedAt).toBe('2026-10-21T07:56:00.000Z')
    })

    it('selects the lowest known Codex window and keeps that window’s paired reset', async () => {
        const document = snapshot()
        document.officialQuota = {
            checkedAt: '2026-10-21T07:57:00+00:00',
            state: 'ok',
            accounts: [
                {
                    windows: [
                        { seconds: 18000, remaining: 50, resetAt: FIVE_RESET },
                        { seconds: 604800, remaining: 80, resetAt: SEVEN_RESET }
                    ]
                },
                {
                    windows: [
                        { seconds: 18000, remaining: 30, resetAt: 1792600300 },
                        { seconds: 604800, remaining: 80, resetAt: 1793000300 },
                        { seconds: 3600, remaining: 1, resetAt: 1792600600 }
                    ]
                }
            ]
        }
        const codex = available(await readQuotaSnapshot(writeSnapshot(document))).providers[2]!
        expect(codex.state).toBe('ok')
        expect(codex.remainingPercent).toBe(30)
        expect(codex.fiveHour).toEqual({
            remainingPercent: 30,
            resetAt: new Date(1792600300 * 1000).toISOString()
        })
        // Equal remaining keeps the first reported row and its own reset.
        expect(codex.sevenDay).toEqual({
            remainingPercent: 80,
            resetAt: new Date(SEVEN_RESET * 1000).toISOString()
        })

        document.officialQuota = {
            checkedAt: '2026-10-21T07:57:00+00:00',
            state: 'ok',
            accounts: [
                {
                    windows: [{ seconds: 604800, remaining: 0, resetAt: 1793000300 }]
                }
            ]
        }
        const partial = available(await readQuotaSnapshot(writeSnapshot(document))).providers[2]!
        expect(partial.fiveHour).toBeNull()
        expect(partial.sevenDay?.remainingPercent).toBe(0)
        expect(partial.remainingPercent).toBe(0)
    })

    it('uses each Claude account’s lowest known window and preserves its paired reset', async () => {
        const document = snapshot()
        document.claudeQuota = {
            checkedAt: '2026-10-21T07:56:00+00:00',
            accounts: [
                {
                    state: 'ok',
                    identity: PERSONAL,
                    fiveHour: { remaining: 40, resetAt: '2026-10-21T12:00:00Z' },
                    sevenDay: { remaining: 20, resetAt: '2026-10-27T00:00:00Z' }
                },
                {
                    state: 'ok',
                    identity: PERSONAL,
                    fiveHour: { remaining: null, resetAt: '2026-10-21T13:00:00Z' },
                    sevenDay: { remaining: 90, resetAt: '2026-10-28T00:00:00Z' }
                }
            ]
        }
        const rows = available(await readQuotaSnapshot(writeSnapshot(document))).providers.slice(3)
        expect(rows[0]!.remainingPercent).toBe(20)
        expect(rows[0]!.fiveHour?.resetAt).toBe('2026-10-21T12:00:00.000Z')
        expect(rows[0]!.sevenDay?.resetAt).toBe('2026-10-27T00:00:00.000Z')
        expect(rows[1]!.remainingPercent).toBe(90)
        expect(rows[1]!.fiveHour).toBeNull()
        expect(rows[1]!.sevenDay?.remainingPercent).toBe(90)
        expect(rows[2]!.state).toBe('missing')
    })

    it('turns invalid percentages, points, states, and timestamps into null or unavailable', async () => {
        const document = snapshot()
        document.copilot!.quota!.premiumInteractions = { percent_remaining: 101, unlimited: true }
        document.copilot!.quota!.resetDate = '2026-13-01'
        document.supplierQuota = {
            checkedAt: '2026-10-21T07:58:00+00:00',
            state: 'ok',
            remainingPercent: -1,
            spentPoints: '12'
        }
        document.officialQuota = {
            checkedAt: '2026-10-21T07:57:00+00:00',
            state: 'warning',
            accounts: [{ windows: [{ seconds: 18000, remaining: 50, resetAt: FIVE_RESET }] }]
        }
        document.claudeQuota = {
            checkedAt: '2026-10-21T07:56:00+00:00',
            accounts: [{
                state: 'ok',
                fiveHour: { remaining: 150, resetAt: 'not-a-date' },
                sevenDay: { remaining: 60, resetAt: '2026-10-27T00:00:00Z' }
            }]
        }

        const result = available(await readQuotaSnapshot(writeSnapshot(document)))
        const [copilot, supplier, codex, claude] = result.providers
        expect(copilot!.remainingPercent).toBeNull()
        expect(copilot!.resetDate).toBeNull()
        expect(copilot!.unlimited).toBe(true)
        expect(supplier!.state).toBe('ok')
        expect(supplier!.remainingPercent).toBeNull()
        expect(supplier!.spentPoints).toBeNull()
        expect(codex!.state).toBe('unavailable')
        expect(codex!.remainingPercent).toBeNull()
        expect(codex!.fiveHour).toBeNull()
        expect(claude!.state).toBe('ok')
        expect(claude!.fiveHour).toBeNull()
        expect(claude!.sevenDay?.remainingPercent).toBe(60)
        expect(claude!.remainingPercent).toBe(60)

        document.supplierQuota = {
            checkedAt: '2026-10-21T07:58:00',
            state: 'ok',
            remainingPercent: 50,
            spentPoints: 1
        }
        document.claudeQuota = {
            checkedAt: '2026-10-21T07:56:00',
            accounts: [{ state: 'ok', fiveHour: { remaining: 10 }, sevenDay: { remaining: 20 } }]
        }
        const invalidTimestamps = available(await readQuotaSnapshot(writeSnapshot(document))).providers
        expect(invalidTimestamps[1]!.state).toBe('unavailable')
        expect(invalidTimestamps[1]!.checkedAt).toBeNull()
        expect(invalidTimestamps[1]!.remainingPercent).toBeNull()
        expect(invalidTimestamps.slice(3).map((provider) => provider.state))
            .toEqual(['unavailable', 'unavailable', 'unavailable'])
    })

    it('returns controlled unavailable results for missing, unreadable, malformed, and incomplete roots', async () => {
        expect(await readQuotaSnapshot(join(tempDir(), 'absent.json'))).toEqual({ available: false, reason: 'missing' })

        const blocker = join(tempDir(), 'not-a-directory')
        writeFileSync(blocker, '')
        expect(await readQuotaSnapshot(join(blocker, 'snapshot.json'))).toEqual({ available: false, reason: 'unreadable' })

        const malformedPath = join(tempDir(), 'snapshot.json')
        writeFileSync(malformedPath, '{"updatedAt":')
        expect(await readQuotaSnapshot(malformedPath)).toEqual({ available: false, reason: 'malformed' })

        const incomplete: unknown[] = [
            {},
            [],
            { updatedAt: 'not-an-iso' },
            { updatedAt: '2026-10-21T08:00:00' },
            { updatedAt: '2026-02-31T08:00:00Z' },
            { updatedAt: ROOT_UPDATED }
        ]
        for (const document of incomplete) {
            const result = await readQuotaSnapshot(writeSnapshot(document))
            if (Array.isArray(document)) {
                expect(result).toEqual({ available: false, reason: 'malformed' })
            } else {
                expect(result).toEqual({ available: false, reason: 'incomplete' })
            }
        }
    })

    it('normalizes the root timestamp from the collector format and rejects impossible dates', async () => {
        const result = available(await readQuotaSnapshot(writeSnapshot(snapshot({
            updatedAt: '2026-10-21T08:00:00.123456+00:00'
        }))))
        expect(result.updatedAt).toBe('2026-10-21T08:00:00.123Z')

        expect(await readQuotaSnapshot(writeSnapshot(snapshot({
            updatedAt: '2026-10-21T24:00:00Z'
        })))).toEqual({ available: false, reason: 'incomplete' })
        expect(await readQuotaSnapshot(writeSnapshot(snapshot({
            updatedAt: '2026-10-21T08:00:00+24:00'
        })))).toEqual({ available: false, reason: 'incomplete' })
    })
})
