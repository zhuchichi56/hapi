import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiCostsResponse, QuotaProviderRow } from '@hapi/protocol/usage'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'

type CostsView = {
    data?: ApiCostsResponse
    isLoading: boolean
    isError: boolean
}

const ROOT_STALE_MS = 180_000
const FUTURE_TOLERANCE_MS = 30_000
const COPILOT_STALE_MS = 1_500_000
const PROVIDER_STALE_MS = 1_300_000
const RING_RADIUS = 33
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
let connectionSequence = 0

function isFresh(timestamp: string | null, maxAgeMs: number, now: number): boolean {
    if (!timestamp) return false
    const parsed = Date.parse(timestamp)
    if (!Number.isFinite(parsed)) return false
    const age = now - parsed
    return age >= -FUTURE_TOLERANCE_MS && age <= maxAgeMs
}

function formatPercent(value: number | null, unknown: string): string {
    return value === null ? unknown : `${Math.round(value)}%`
}

function formatReset(iso: string | null, locale: string): string | null {
    if (!iso) return null
    const parsed = Date.parse(iso)
    if (!Number.isFinite(parsed)) return null
    return new Date(parsed).toLocaleString(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    })
}

function resetLine(windows: Array<[string, string | null]>, locale: string): string | null {
    const parts: string[] = []
    for (const [label, iso] of windows) {
        const value = formatReset(iso, locale)
        if (value) parts.push(`${label} ${value}`)
    }
    return parts.length > 0 ? parts.join(' · ') : null
}

function QuotaRing(props: {
    ariaLabel: string
    value: number | null
    unlimited: boolean
    center: string
    color: string
}) {
    const fraction = props.unlimited ? 1 : Math.max(0, Math.min(100, props.value ?? 0)) / 100
    const dashOffset = RING_CIRCUMFERENCE * (1 - fraction)
    return (
        <div className="relative mx-auto flex h-20 w-20 items-center justify-center sm:h-24 sm:w-24">
            <svg
                viewBox="0 0 80 80"
                className="h-20 w-20 sm:h-24 sm:w-24"
                role="img"
                aria-label={props.ariaLabel}
            >
                <circle cx="40" cy="40" r={RING_RADIUS} fill="none" stroke="var(--app-border)" strokeWidth="5" />
                <circle
                    cx="40"
                    cy="40"
                    r={RING_RADIUS}
                    fill="none"
                    stroke={props.color}
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={dashOffset}
                    transform="rotate(-90 40 40)"
                />
            </svg>
            <span
                aria-hidden="true"
                className={`absolute inset-0 flex items-center justify-center font-semibold ${props.center.length > 4 ? 'text-sm' : 'text-xl'}`}
                style={{ color: props.color }}
            >
                {props.center}
            </span>
        </div>
    )
}

function QuotaCard(props: {
    row: QuotaProviderRow
    rootFresh: boolean
    now: number
    numberLocale: string
}) {
    const { t } = useTranslation()
    const { row, rootFresh, now, numberLocale } = props
    const unknown = t('settings.quota.unknownValue')
    const staleMs = row.id === 'copilot' ? COPILOT_STALE_MS : PROVIDER_STALE_MS
    const providerFresh = isFresh(row.checkedAt, staleMs, now)
    const usable = rootFresh && row.state === 'ok' && providerFresh

    let status: string | null = null
    let tone: 'warning' | 'muted' = 'muted'
    if (!rootFresh) {
        status = t('settings.quota.status.expired')
        tone = 'warning'
    } else if (row.state === 'missing') {
        status = t('settings.quota.status.missing')
    } else if (row.state === 'unavailable') {
        status = t('settings.quota.status.unavailable')
    } else if (!providerFresh) {
        status = t('settings.quota.status.expired')
        tone = 'warning'
    }

    let value: number | null = usable ? row.remainingPercent : null
    let unlimited = usable && row.unlimited
    let center = unknown
    let color = 'var(--app-hint)'
    let windows: string[] = []
    let reset: string | null = null
    let detail: string | null = null

    if (row.id === 'copilot') {
        if (unlimited) {
            value = 100
            center = '∞'
        } else {
            center = formatPercent(value, unknown)
        }
        color = value === null && !unlimited ? 'var(--app-hint)' : '#3b82f6'
        windows = [
            t('settings.quota.window.monthly'),
            usable && row.resetDate
                ? t('settings.quota.resetOn', { date: row.resetDate.slice(5) })
                : t('settings.quota.window.notUpdated')
        ]
    } else if (row.id === 'getapikey') {
        color = usable ? '#0d9488' : 'var(--app-hint)'
        if (usable && row.remainingPercent === null && row.spentPoints !== null) {
            center = row.spentPoints.toLocaleString(numberLocale, { maximumFractionDigits: 1 })
            windows = [
                t('settings.quota.window.spentPoints'),
                t('settings.quota.window.noKeyLimit')
            ]
            detail = t('settings.quota.noKeyLimitNote')
        } else {
            center = formatPercent(value, unknown)
            windows = [
                t('settings.quota.window.keyRemaining'),
                t('settings.quota.window.keyLimit')
            ]
        }
    } else if (row.id === 'codex_pro') {
        color = value === null ? 'var(--app-hint)' : '#8b5cf6'
        center = formatPercent(value, unknown)
        const fiveHour = usable ? row.fiveHour?.remainingPercent ?? null : null
        const sevenDay = usable ? row.sevenDay?.remainingPercent ?? null : null
        windows = [
            `5h ${formatPercent(fiveHour, unknown)}`,
            `7d ${formatPercent(sevenDay, unknown)}`
        ]
        if (usable) {
            reset = resetLine([
                ['5h', row.fiveHour?.resetAt ?? null],
                ['7d', row.sevenDay?.resetAt ?? null]
            ], numberLocale)
        }
    } else {
        if (row.state === 'missing') {
            windows = [t('settings.quota.window.noAccount')]
        } else if (row.state === 'unavailable') {
            windows = [`5h ${unknown}`, `7d ${unknown}`]
        } else {
            const fiveHour = usable ? row.fiveHour?.remainingPercent ?? null : null
            const sevenDay = usable ? row.sevenDay?.remainingPercent ?? null : null
            const shown = usable ? row.remainingPercent : null
            color = shown === null
                ? 'var(--app-hint)'
                : shown <= 30
                    ? '#f59e0b'
                    : '#0d9488'
            center = formatPercent(shown, unknown)
            windows = [
                `5h ${formatPercent(fiveHour, unknown)}`,
                `7d ${formatPercent(sevenDay, unknown)}`
            ]
            if (usable) {
                reset = resetLine([
                    ['5h', row.fiveHour?.resetAt ?? null],
                    ['7d', row.sevenDay?.resetAt ?? null]
                ], numberLocale)
            }
        }
    }

    const ariaValue = unlimited
        ? t('settings.quota.unlimited')
        : center === unknown
            ? t('settings.quota.unknown')
            : center
    const ariaLabel = [row.name, ariaValue, ...windows, status].filter(Boolean).join(' · ')

    return (
        <li className="min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-sm">
            <div className="flex min-h-5 items-center justify-between gap-2">
                <h3 className="min-w-0 truncate text-sm font-semibold text-[var(--app-fg)]">{row.name}</h3>
                {unlimited ? (
                    <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">
                        {t('settings.quota.unlimitedBadge')}
                    </span>
                ) : null}
            </div>
            <div className="mt-2">
                <QuotaRing
                    ariaLabel={ariaLabel}
                    value={value}
                    unlimited={unlimited}
                    center={center}
                    color={color}
                />
            </div>
            <div className="mt-2 space-y-0.5 text-center text-xs text-[var(--app-hint)]">
                {windows.map((window, index) => (
                    <div key={`${row.id}-${index}`} className="truncate">{window}</div>
                ))}
            </div>
            {reset ? (
                <div className="mt-1 break-words text-center text-[10px] leading-snug text-[var(--app-hint)]">{reset}</div>
            ) : null}
            {detail ? (
                <div className="mt-1 text-center text-[10px] leading-snug text-[var(--app-hint)]">{detail}</div>
            ) : null}
            {status ? (
                <div className={`mt-1 text-center text-[10px] font-medium ${tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-[var(--app-hint)]'}`}>
                    {status}
                </div>
            ) : null}
        </li>
    )
}

export function QuotaPanel(props: { costs?: CostsView }) {
    const { api, token, baseUrl } = useAppContext()
    const { t, locale } = useTranslation()
    const numberLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'
    const [now, setNow] = useState(() => Date.now())
    // Keep cached quota isolated across client/auth changes without putting
    // credentials in query keys.
    const connectionScope = useMemo(() => ++connectionSequence, [api, token])
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000)
        return () => window.clearInterval(timer)
    }, [])
    const query = useQuery({
        queryKey: ['usage-quotas', baseUrl, connectionScope],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getUsageQuotas()
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        // React Query stops this interval when the panel unmounts.
        refetchInterval: 60_000,
        refetchOnWindowFocus: false,
        retry: false
    })

    const data = query.isError ? undefined : query.data
    const available = data?.available === true ? data : null
    const unavailable = data?.available === false ? data : null
    const rootFresh = available ? isFresh(available.updatedAt, ROOT_STALE_MS, now) : false
    const updatedTime = available
        ? new Date(available.updatedAt).toLocaleString(numberLocale, { hour12: false })
        : null

    const costsData = props.costs && !props.costs.isError && props.costs.data?.available === true
        ? props.costs.data
        : null
    const cumulative = costsData?.periods.all.summary.equivalentUSD ?? null
    const cumulativeText = cumulative === null
        ? t('settings.quota.cumulativeUnknown')
        : t('settings.quota.cumulativeAmount', { amount: cumulative.toFixed(2) })

    return (
        <section>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="text-base font-semibold text-[var(--app-fg)]">{t('settings.quota.title')}</h2>
                <span className="text-xs text-[var(--app-hint)]" title={t('settings.quota.cumulativeNote')}>
                    {t('settings.quota.cumulative', { amount: cumulativeText })}
                </span>
            </div>
            <div className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
                {query.isError ? (
                    <div className="px-3 py-4">
                        <div className="text-sm font-medium text-[var(--app-fg)]">{t('settings.quota.error')}</div>
                        <div className="mt-0.5 text-xs leading-snug text-[var(--app-hint)]">{t('settings.quota.errorDetail')}</div>
                    </div>
                ) : unavailable ? (
                    <div className="px-3 py-4">
                        <div className="text-sm font-medium text-[var(--app-fg)]">{t('settings.quota.unavailable')}</div>
                        <div className="mt-0.5 text-xs leading-snug text-[var(--app-hint)]">
                            {t(`settings.quota.reason.${unavailable.reason}`)}
                        </div>
                    </div>
                ) : !available ? (
                    <div className="px-3 py-4 text-sm text-[var(--app-hint)]">{t('settings.quota.loading')}</div>
                ) : (
                    <>
                        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--app-divider)] px-3 py-2 text-xs text-[var(--app-hint)]">
                            <span>{t('settings.quota.updated', { time: updatedTime ?? t('settings.quota.unknown') })}</span>
                            {!rootFresh ? (
                                <span role="status" className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                                    {t('settings.quota.status.expired')}
                                </span>
                            ) : null}
                        </div>
                        <ul className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3" aria-label={t('settings.quota.ringsLabel')}>
                            {available.providers.map((row) => (
                                <QuotaCard key={row.id} row={row} rootFresh={rootFresh} now={now} numberLocale={numberLocale} />
                            ))}
                        </ul>
                    </>
                )}
            </div>
            <p className="mt-2 text-xs leading-snug text-[var(--app-hint)]">
                {t('settings.quota.cumulativeNote')} {t('settings.quota.footnote')}
            </p>
        </section>
    )
}
