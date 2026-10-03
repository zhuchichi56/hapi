import type { SessionSummary } from '@/types/api'

const hiddenMachineIds = new Set<string>(
    (import.meta.env.VITE_HAPI_HIDDEN_MACHINE_IDS ?? '').split(',').map((id: string) => id.trim()).filter(Boolean)
)

/** Hide retired machines in navigation without changing stored history or direct session links. */
export function filterSidebarMachines(sessions: SessionSummary[], excluded: ReadonlySet<string> = hiddenMachineIds): SessionSummary[] {
    return sessions.filter(session => !excluded.has(session.metadata?.machineId ?? ''))
}
