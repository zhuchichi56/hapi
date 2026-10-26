export const ARCHIVE_STORAGE_KEY = 'hapi-native-archives-v1'
export function loadArchives(): Record<string, string> {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(ARCHIVE_STORAGE_KEY) || '{}')
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
        return Object.fromEntries(Object.entries(value).filter(([key, title]) => /^(codex|claude):[A-Za-z0-9_-]{1,128}$/.test(key) && typeof title === 'string' && title.length <= 2000))
    } catch { return {} }
}
