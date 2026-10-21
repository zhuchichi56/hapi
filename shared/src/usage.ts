/**
 * Protocol marker for token_count payloads whose input token total already
 * includes cache reads/writes. Consumers must not add cache tokens again.
 */
export const INCLUSIVE_INPUT_TOKEN_USAGE_MARKER = {
    usageSchema: 'hapi.usage.v1',
    inputTokenSemantics: 'includes-cache'
} as const

export type InclusiveInputTokenUsageMarker = typeof INCLUSIVE_INPUT_TOKEN_USAGE_MARKER

/** Dashboard accounting providers; display names are fixed by the hub DTO. */
export type ApiCostProviderId = 'getapikey' | 'copilot' | 'codex_pro' | 'jev'

export type ApiCostPeriodKey = 'today' | 'month' | 'all'

/** Whitelisted fields copied from each dashboard accounting group. */
export type ApiCostSummary = {
    requests: number
    pricedRequests: number
    missingUsage: number
    equivalentUSD: number | null
    supplierEstimatedUSD: number | null
    supplierPricedRequests: number
    actualUSD: number | null
    coverageComplete: boolean
}

export type ApiCostSourceRow = ApiCostSummary & {
    id: ApiCostProviderId
    name: string
}

export type ApiCostPeriod = {
    summary: ApiCostSummary
    sources: ApiCostSourceRow[]
}

export type ApiCostsAvailableResponse = {
    available: true
    updatedAt: string
    periods: Record<ApiCostPeriodKey, ApiCostPeriod>
}

export type ApiCostsUnavailableReason = 'missing' | 'unreadable' | 'malformed' | 'incomplete'

export type ApiCostsUnavailableResponse = {
    available: false
    reason: ApiCostsUnavailableReason
}

export type ApiCostsResponse = ApiCostsAvailableResponse | ApiCostsUnavailableResponse

/**
 * Fixed quota dashboard rows. Names and order are part of the hub DTO so no
 * account identity from the source snapshot can reach a client.
 */
export type QuotaProviderId =
    | 'copilot'
    | 'getapikey'
    | 'codex_pro'
    | 'claude_1'
    | 'claude_2'
    | 'claude_3'

export type QuotaProviderState = 'ok' | 'unavailable' | 'missing'

/** A reported quota window. Timestamps are normalized ISO-8601 strings. */
export type QuotaWindow = {
    remainingPercent: number | null
    resetAt: string | null
}

/** One whitelisted quota row. Unknown values are null, never zero. */
export type QuotaProviderRow = {
    id: QuotaProviderId
    name: string
    state: QuotaProviderState
    checkedAt: string | null
    remainingPercent: number | null
    fiveHour: QuotaWindow | null
    sevenDay: QuotaWindow | null
    unlimited: boolean
    resetDate: string | null
    spentPoints: number | null
}

export type QuotasAvailableResponse = {
    available: true
    updatedAt: string
    providers: QuotaProviderRow[]
}

export type QuotasUnavailableReason = 'missing' | 'unreadable' | 'malformed' | 'incomplete'

export type QuotasUnavailableResponse = {
    available: false
    reason: QuotasUnavailableReason
}

export type QuotasResponse = QuotasAvailableResponse | QuotasUnavailableResponse
