import { useEffect, useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SettingsRow, SettingsSection } from './SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'

const PERIODS = ['today', 'month', 'all'] as const
type CostPeriod = typeof PERIODS[number]
const FRESHNESS_MS = 180_000
let connectionSequence = 0

function formatUsd(value: number | null, unknown: string): string {
    return value === null ? unknown : `$${value.toFixed(2)}`
}

function formatCount(value: number, locale: string): string {
    return value.toLocaleString(locale)
}

function isStale(updatedAt: string, now: number): boolean {
    const timestamp = Date.parse(updatedAt)
    return !Number.isFinite(timestamp) || now - timestamp > FRESHNESS_MS
}

function CostMetric(props: { label: string; value: string; detail: string }) {
    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
            <div className="text-xs text-[var(--app-hint)]">{props.label}</div>
            <div className="mt-1 text-lg font-semibold text-[var(--app-fg)]">{props.value}</div>
            <div className="mt-0.5 text-xs text-[var(--app-hint)]">{props.detail}</div>
        </div>
    )
}

export function ApiCostPanel() {
    const { api, token, baseUrl } = useAppContext()
    const { t, locale } = useTranslation()
    const numberLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'
    const [period, setPeriod] = useState<CostPeriod>('today')
    const periodName = useId()
    // Keep cached accounting isolated across client/auth changes without putting
    // credentials in query keys.
    const connectionScope = useMemo(() => ++connectionSequence, [api, token])
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000)
        return () => window.clearInterval(timer)
    }, [])
    const query = useQuery({
        queryKey: ['api-costs', baseUrl, connectionScope],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getApiCosts()
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        // React Query stops this interval when the panel unmounts.
        refetchInterval: 60_000,
        refetchOnWindowFocus: false,
        retry: false
    })

    const data = query.data
    const available = api && data?.available === true ? data : null
    const unavailable = data?.available === false ? data : null
    const selected = available?.periods[period]
    const stale = available ? isStale(available.updatedAt, now) : false
    const unknown = t('settings.apiCost.unknown')
    const updatedTime = available
        ? new Date(available.updatedAt).toLocaleString(numberLocale, { hour12: false })
        : null

    return (
        <SettingsSection title={t('settings.apiCost.title')} description={t('settings.apiCost.subtitle')}>
            <div className="px-3 py-3">
                <div role="radiogroup" aria-label={t('settings.apiCost.rangeLabel')} className="inline-flex overflow-hidden rounded-lg border border-[var(--app-border)]">
                    {PERIODS.map((option) => (
                        <label
                            key={option}
                            className={`cursor-pointer focus-within:ring-2 focus-within:ring-inset focus-within:ring-[var(--app-link)] border-r border-[var(--app-border)] px-3 py-2 text-sm font-medium transition-colors last:border-r-0 ${period === option ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]' : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
                        >
                            <input
                                className="sr-only"
                                type="radio"
                                name={periodName}
                                value={option}
                                checked={period === option}
                                onChange={() => setPeriod(option)}
                            />
                            {t(`settings.apiCost.period.${option}`)}
                        </label>
                    ))}
                </div>
            </div>

            {query.isLoading ? <SettingsRow label={t('settings.apiCost.loading')} /> : null}
            {query.isError ? <SettingsRow label={t('settings.apiCost.error')} description={t('settings.apiCost.errorDetail')} /> : null}
            {!query.isError && unavailable ? (
                <SettingsRow
                    label={t('settings.apiCost.unavailable')}
                    description={t(`settings.apiCost.reason.${unavailable.reason}`)}
                />
            ) : null}

            {!query.isError && available && selected ? (
                <>
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-[var(--app-hint)]">
                        <span>{t('settings.apiCost.updated', { time: updatedTime ?? unknown })}</span>
                        {stale ? (
                            <span role="status" className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                                {t('settings.apiCost.stale')}
                            </span>
                        ) : null}
                    </div>
                    <div className="grid grid-cols-2 gap-2 px-3 py-3 sm:grid-cols-4">
                        <CostMetric
                            label={t('settings.apiCost.equivalent')}
                            value={formatUsd(selected.summary.equivalentUSD, unknown)}
                            detail={t('settings.apiCost.pricedDetail', {
                                priced: formatCount(selected.summary.pricedRequests, numberLocale),
                                requests: formatCount(selected.summary.requests, numberLocale)
                            })}
                        />
                        <CostMetric
                            label={t('settings.apiCost.supplier')}
                            value={formatUsd(selected.summary.supplierEstimatedUSD, unknown)}
                            detail={t('settings.apiCost.pricedDetail', {
                                priced: formatCount(selected.summary.supplierPricedRequests, numberLocale),
                                requests: formatCount(selected.summary.requests, numberLocale)
                            })}
                        />
                        <CostMetric
                            label={t('settings.apiCost.actual')}
                            value={formatUsd(selected.summary.actualUSD, unknown)}
                            detail={t('settings.apiCost.actualDetail')}
                        />
                        <CostMetric
                            label={t('settings.apiCost.coverage')}
                            value={`${formatCount(selected.summary.pricedRequests, numberLocale)} / ${formatCount(selected.summary.requests, numberLocale)}`}
                            detail={t('settings.apiCost.missingDetail', {
                                missing: formatCount(selected.summary.missingUsage, numberLocale)
                            })}
                        />
                    </div>
                    <div className="px-3 pb-3">
                        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--app-hint)]">
                            {t('settings.apiCost.sources')}
                        </div>
                        <div className="divide-y divide-[var(--app-divider)] overflow-hidden rounded-lg border border-[var(--app-border)]">
                            {selected.sources.map((source) => (
                                <div key={source.id} className="px-3 py-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <span className="text-sm font-medium text-[var(--app-fg)]">{source.name}</span>
                                        <span className={`rounded-full px-2 py-0.5 text-xs ${source.coverageComplete ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]' : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'}`}>
                                            {source.coverageComplete ? t('settings.apiCost.coverageComplete') : t('settings.apiCost.coveragePartial')}
                                        </span>
                                    </div>
                                    <div className="mt-1 text-xs text-[var(--app-hint)]">
                                        {t('settings.apiCost.sourceDetail', {
                                            requests: formatCount(source.requests, numberLocale),
                                            priced: formatCount(source.pricedRequests, numberLocale),
                                            missing: formatCount(source.missingUsage, numberLocale)
                                        })}
                                    </div>
                                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                                        <div>
                                            <div className="text-[var(--app-hint)]">{t('settings.apiCost.equivalent')}</div>
                                            <div className="font-medium text-[var(--app-fg)]">{formatUsd(source.equivalentUSD, unknown)}</div>
                                        </div>
                                        <div>
                                            <div className="text-[var(--app-hint)]">{t('settings.apiCost.supplier')}</div>
                                            <div className="font-medium text-[var(--app-fg)]">{formatUsd(source.supplierEstimatedUSD, unknown)}</div>
                                        </div>
                                        <div>
                                            <div className="text-[var(--app-hint)]">{t('settings.apiCost.actual')}</div>
                                            <div className="font-medium text-[var(--app-fg)]">{formatUsd(source.actualUSD, unknown)}</div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            ) : null}
        </SettingsSection>
    )
}
