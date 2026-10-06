import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useRecentPaths } from '@/hooks/useRecentPaths'
import { useTranslation } from '@/lib/use-translation'
import { loadPreferredAgent, loadPreferredLaunchSettings, loadPreferredYoloMode, resolvePreferredLaunchSettings } from './preferences'

export type QuickSessionPreset = { machineId: string; directory: string }
export type QuickSessionTarget = { machineId: string | null; directory: string }

export const QUICK_SESSION_MODEL = 'gpt-6.1-sol'
export const QUICK_SESSION_EFFORT = 'medium'

export function readQuickSessionPreset(): QuickSessionPreset | null {
    const machineId = import.meta.env.VITE_HAPI_QUICK_SESSION_MACHINE_ID?.trim()
    const directory = import.meta.env.VITE_HAPI_QUICK_SESSION_DIRECTORY?.trim()
    return machineId && directory ? { machineId, directory } : null
}

export const quickSessionPreset = readQuickSessionPreset()

/** Start the explicit personal preset on click; never substitute another machine or model. */
export function useQuickSessionLaunch(api: ApiClient | null, machines: Machine[], preset: QuickSessionPreset | null) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { spawnSession } = useSpawnSession(api)
    const { addRecentPath, setLastUsedMachineId } = useRecentPaths()
    const inFlight = useRef(false)
    const [isPending, setIsPending] = useState(false)

    const catalogOptions = useCallback((machineId: string) => ({
        queryKey: queryKeys.machineCodexModels(machineId),
        queryFn: async () => {
            if (!api) throw new Error(t('newSession.quick.unavailable'))
            const catalog = await api.getMachineCodexModels(machineId)
            if (!catalog.success) throw new Error(catalog.error || t('newSession.quick.unavailable'))
            return catalog
        },
        staleTime: 30_000,
        retry: false as const,
    }), [api, t])

    // Discovery can launch an app-server and refresh account authentication.
    // Warm it before the click and share the verified catalog with chat controls.
    useEffect(() => {
        if (api && preset && machines.some(machine => machine.id === preset.machineId && machine.active)) {
            void queryClient.prefetchQuery(catalogOptions(preset.machineId))
        }
    }, [api, preset, machines, queryClient, catalogOptions])

    const launch = useCallback(async (target?: QuickSessionTarget): Promise<string | null> => {
        if (inFlight.current) return null
        if (!api || !preset) throw new Error(t('newSession.quick.unavailable'))
        if (target && !target.machineId) throw new Error(t('newSession.quick.missingMachine'))
        const machineId = target?.machineId ?? preset.machineId
        const directory = (target?.directory ?? preset.directory).trim()
        if (!machines.some(machine => machine.id === machineId && machine.active)) {
            throw new Error(t('newSession.quick.offline'))
        }

        inFlight.current = true
        setIsPending(true)
        try {
            const [catalog, paths] = await Promise.all([
                queryClient.fetchQuery(catalogOptions(machineId)),
                api.checkMachinePathsExists(machineId, [directory]),
            ])
            if (!catalog.success) throw new Error(catalog.error || t('newSession.quick.unavailable'))
            const model = catalog.models?.find(model => model.id === QUICK_SESSION_MODEL)
            if (!model || !model.supportedReasoningEfforts?.includes(QUICK_SESSION_EFFORT)) {
                throw new Error(t('newSession.quick.unsupported'))
            }
            if (!paths.exists[directory] || paths.outsideWorkspaceRoots?.includes(directory)) {
                throw new Error(t('newSession.quick.directoryUnavailable'))
            }
            const permissionMode = resolvePreferredLaunchSettings(
                'codex',
                loadPreferredLaunchSettings(machineId, 'codex'),
                loadPreferredYoloMode() && loadPreferredAgent() === 'codex',
            ).permissionMode ?? 'default'
            const result = await spawnSession({
                machineId,
                directory,
                agent: 'codex',
                model: QUICK_SESSION_MODEL,
                modelReasoningEffort: QUICK_SESSION_EFFORT,
                permissionMode,
                sessionType: 'simple',
                collaborationMode: 'default',
            })
            if (result.type !== 'success') throw new Error(result.message)
            setLastUsedMachineId(machineId)
            addRecentPath(machineId, directory)
            return result.sessionId
        } finally {
            inFlight.current = false
            setIsPending(false)
        }
    }, [api, machines, preset, queryClient, catalogOptions, spawnSession, addRecentPath, setLastUsedMachineId, t])

    return { launch, isPending }
}
