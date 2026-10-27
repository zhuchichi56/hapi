import type { SessionSummary } from '@/types/api'

const hiddenMachineIds = new Set<string>(
    (import.meta.env.VITE_HAPI_HIDDEN_MACHINE_IDS ?? '').split(',').map((id: string) => id.trim()).filter(Boolean)
)

const hiddenProjectDirectories = new Set<string>(
    (import.meta.env.VITE_HAPI_HIDDEN_PROJECT_DIRECTORIES ?? '').split(',').map((path: string) => path.trim()).filter(Boolean)
)

/** Hide configured navigation entries while preserving history and direct session links. */
export function filterSidebarMachines(sessions: SessionSummary[], excluded: ReadonlySet<string> = hiddenMachineIds): SessionSummary[] {
    return sessions.filter(session => !excluded.has(session.metadata?.machineId ?? '')
        && !hiddenProjectDirectories.has(session.metadata?.worktree?.basePath ?? session.metadata?.path ?? ''))
}
