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
