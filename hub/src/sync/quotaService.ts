import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
    QuotaProviderId,
    QuotaProviderRow,
    QuotaProviderState,
    QuotasResponse,
    QuotaWindow
} from '@hapi/protocol/usage'

const CLAUDE_IDS = ['claude_1', 'claude_2', 'claude_3'] as const
const KNOWN_SECTIONS = ['copilot', 'supplierQuota', 'officialQuota', 'claudeQuota'] as const
const PROVIDER_NAMES: Record<QuotaProviderId, string> = {
    copilot: 'Copilot',
    getapikey: 'Get APIKey',
    codex_pro: 'Codex Pro',
    claude_1: 'Claude 1',
    claude_2: 'Claude 2',
    claude_3: 'Claude 3'
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
}

export function getQuotaSnapshotPath(): string {
    return join(homedir(), '.local/share/api-usage-monitor/snapshot.json')
}

function emptyRow(
    id: QuotaProviderId,
    state: QuotaProviderState = 'missing',
    checkedAt: string | null = null
): QuotaProviderRow {
    return {
        id,
        name: PROVIDER_NAMES[id],
        state,
        checkedAt,
        remainingPercent: null,
        fiveHour: null,
        sevenDay: null,
        unlimited: false,
        resetDate: null,
        spentPoints: null
    }
}

/** Strict ISO-8601; the source collector emits +00:00 timestamps with microseconds. */
function parseIsoTimestamp(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 64) return null
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
    if (!match) return null
    const [, date, hours, minutes, seconds, zone, , offsetHours, offsetMinutes] = match
    if (parseDateOnly(date) === null) return null
    if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null
    if (zone !== 'Z' && (Number(offsetHours) > 23 || Number(offsetMinutes) > 59)) return null
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

/** A calendar date only; do not let Date normalize an impossible date. */
function parseDateOnly(value: unknown): string | null {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
    const timestamp = Date.parse(`${value}T00:00:00.000Z`)
    if (!Number.isFinite(timestamp)) return null
    return new Date(timestamp).toISOString().slice(0, 10) === value ? value : null
}

function parsePercent(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
        ? value
        : null
}

function parseNonNegative(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Normalize a source Unix-seconds reset time into the DTO's ISO timestamp. */
function parseUnixTimestamp(value: unknown): string | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
    const milliseconds = value * 1000
    if (!Number.isFinite(milliseconds) || milliseconds > 8.64e15) return null
    const timestamp = new Date(milliseconds)
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null
}

function minKnown(...values: Array<number | null>): number | null {
    const known = values.filter((value): value is number => value !== null)
    return known.length > 0 ? Math.min(...known) : null
}

function parseClaudeWindow(value: unknown): QuotaWindow | null {
    const record = asRecord(value)
    if (!record) return null
    const remainingPercent = parsePercent(record.remaining)
    if (remainingPercent === null) return null
    return { remainingPercent, resetAt: parseIsoTimestamp(record.resetAt) }
}

function codexWindows(section: JsonRecord): JsonRecord[] {
    if (!Array.isArray(section.accounts)) return []
    const windows: JsonRecord[] = []
    for (const account of section.accounts) {
        const record = asRecord(account)
        if (!record || !Array.isArray(record.windows)) continue
        for (const window of record.windows) {
            const windowRecord = asRecord(window)
            if (windowRecord) windows.push(windowRecord)
        }
    }
    return windows
}

/** Lowest known remaining row for one window length, with that row's reset. */
function pickCodexWindow(windows: JsonRecord[], seconds: number): QuotaWindow | null {
    let selected: JsonRecord | null = null
    let selectedRemaining: number | null = null
    for (const window of windows) {
        if (window.seconds !== seconds) continue
        const remaining = parsePercent(window.remaining)
        if (remaining === null) continue
        if (selectedRemaining === null || remaining < selectedRemaining) {
            selected = window
            selectedRemaining = remaining
        }
    }
    if (!selected || selectedRemaining === null) return null
    return { remainingPercent: selectedRemaining, resetAt: parseUnixTimestamp(selected.resetAt) }
}

function parseCopilot(value: unknown): QuotaProviderRow {
    const row = emptyRow('copilot')
    const section = asRecord(value)
    if (!section) return row

    row.checkedAt = parseIsoTimestamp(section.quotaCheckedAt)
    const quota = asRecord(section.quota)
    const premium = asRecord(quota?.premiumInteractions)
    if (!row.checkedAt || !quota || !premium) {
        row.state = 'unavailable'
        return row
    }

    row.state = 'ok'
    row.remainingPercent = parsePercent(premium.percent_remaining)
    row.unlimited = premium.unlimited === true
    row.resetDate = parseDateOnly(quota.resetDate)
    return row
}

function parseSupplier(value: unknown): QuotaProviderRow {
    const row = emptyRow('getapikey')
    const section = asRecord(value)
    if (!section) return row

    row.checkedAt = parseIsoTimestamp(section.checkedAt)
    if (section.state !== 'ok' || !row.checkedAt) {
        row.state = 'unavailable'
        return row
    }

    row.state = 'ok'
    row.remainingPercent = parsePercent(section.remainingPercent)
    row.spentPoints = parseNonNegative(section.spentPoints)
    return row
}

function parseCodex(value: unknown): QuotaProviderRow {
    const row = emptyRow('codex_pro')
    const section = asRecord(value)
    if (!section) return row

    row.checkedAt = parseIsoTimestamp(section.checkedAt)
    if (section.state !== 'ok' || !row.checkedAt) {
        row.state = 'unavailable'
        return row
    }

    row.state = 'ok'
    const windows = codexWindows(section)
    row.fiveHour = pickCodexWindow(windows, 18000)
    row.sevenDay = pickCodexWindow(windows, 604800)
    row.remainingPercent = minKnown(
        row.fiveHour?.remainingPercent ?? null,
        row.sevenDay?.remainingPercent ?? null
    )
    return row
}

function parseClaude(value: unknown): QuotaProviderRow[] {
    const section = asRecord(value)
    if (!section) return CLAUDE_IDS.map((id) => emptyRow(id))

    const checkedAt = parseIsoTimestamp(section.checkedAt)
    const accounts = Array.isArray(section.accounts) ? section.accounts : null
    if (!checkedAt || !accounts) {
        return CLAUDE_IDS.map((id) => emptyRow(id, 'unavailable', checkedAt))
    }

    return CLAUDE_IDS.map((id, index) => {
        const row = emptyRow(id)
        const account = accounts ? asRecord(accounts[index]) : null
        if (!account) return row

        row.checkedAt = checkedAt
        if (account.state !== 'ok') {
            row.state = 'unavailable'
            return row
        }

        row.state = 'ok'
        row.fiveHour = parseClaudeWindow(account.fiveHour)
        row.sevenDay = parseClaudeWindow(account.sevenDay)
        row.remainingPercent = minKnown(
            row.fiveHour?.remainingPercent ?? null,
            row.sevenDay?.remainingPercent ?? null
        )
        return row
    })
}

/**
 * Read the local dashboard snapshot's quota sections. Never makes network
 * calls and never returns identities, paths, raw fields, or raw errors.
 */
export async function readQuotaSnapshot(snapshotPath: string = getQuotaSnapshotPath()): Promise<QuotasResponse> {
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

    const updatedAt = parseIsoTimestamp(root.updatedAt)
    const hasQuotaSection = KNOWN_SECTIONS.some((key) => asRecord(root[key]) !== null)
    if (!updatedAt || !hasQuotaSection) return { available: false, reason: 'incomplete' }

    return {
        available: true,
        updatedAt,
        providers: [
            parseCopilot(root.copilot),
            parseSupplier(root.supplierQuota),
            parseCodex(root.officialQuota),
            ...parseClaude(root.claudeQuota)
        ]
    }
}
