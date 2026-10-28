export type SingleProjectGroupConfig = {
    machineId: string
    directory: string
    displayName: string
}

export function isAbsoluteProjectDirectory(directory: string): boolean {
    return directory.startsWith('/')
        || /^[A-Za-z]:[\\/]/.test(directory)
        || /^\\\\[^\\]+\\[^\\]+/.test(directory)
}

function readSingleProjectGroupConfig(): SingleProjectGroupConfig | null {
    const machineId = import.meta.env.VITE_HAPI_SINGLE_PROJECT_MACHINE_ID?.trim()
    const directory = import.meta.env.VITE_HAPI_SINGLE_PROJECT_DIRECTORY?.trim()
    const displayName = import.meta.env.VITE_HAPI_SINGLE_PROJECT_LABEL?.trim()
    if (!machineId || !directory || !isAbsoluteProjectDirectory(directory) || !displayName) return null
    return { machineId, directory, displayName }
}

export type ProjectGroupConfig = SingleProjectGroupConfig | readonly SingleProjectGroupConfig[] | null

export function parseProjectGroupConfigs(value: string | undefined): SingleProjectGroupConfig[] {
    if (!value) return []
    try {
        const entries: unknown = JSON.parse(value)
        if (!Array.isArray(entries)) return []
        return entries.filter((entry): entry is SingleProjectGroupConfig => Boolean(entry)
            && typeof entry.machineId === 'string' && entry.machineId.length > 0
            && typeof entry.directory === 'string' && isAbsoluteProjectDirectory(entry.directory)
            && typeof entry.displayName === 'string' && entry.displayName.trim().length > 0)
    } catch { return [] }
}

export const projectGroupConfigs = parseProjectGroupConfigs(import.meta.env.VITE_HAPI_PROJECT_GROUPS)
export const singleProjectGroupConfig: ProjectGroupConfig = projectGroupConfigs.length > 0
    ? projectGroupConfigs : readSingleProjectGroupConfig()

export function projectForMachine(machineId: string | null | undefined, config: ProjectGroupConfig): SingleProjectGroupConfig | undefined {
    const entries: readonly SingleProjectGroupConfig[] = !config ? [] : Array.isArray(config) ? config : [config as SingleProjectGroupConfig]
    return entries.find(entry => entry.machineId === machineId)
}
