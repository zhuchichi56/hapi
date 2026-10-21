import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiCostPanel } from '@/components/settings/ApiCostPanel'
import { QuotaPanel } from '@/components/settings/QuotaPanel'
import { SettingsPageContent } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'

let connectionSequence = 0

export default function SettingsQuotaPage() {
    const { api, token, baseUrl } = useAppContext()
    const { t } = useTranslation()
    // Keep cached accounting isolated across client/auth changes without putting
    // credentials in query keys.
    const connectionScope = useMemo(() => ++connectionSequence, [api, token])
    const costs = useQuery({
        queryKey: ['api-costs', baseUrl, connectionScope],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getApiCosts()
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        // React Query stops this interval when the page unmounts.
        refetchInterval: 60_000,
        refetchOnWindowFocus: false,
        retry: false
    })

    return (
        <SettingsPageContent description={t('settings.quota.description')}>
            <QuotaPanel costs={costs} />
            <ApiCostPanel />
        </SettingsPageContent>
    )
}
