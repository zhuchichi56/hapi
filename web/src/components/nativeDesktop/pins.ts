export const PIN_STORAGE_KEY = 'hapi-native-pins-v1'
export function loadPins(): Record<string, boolean> {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(PIN_STORAGE_KEY) || '{}')
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
        return Object.fromEntries(Object.entries(value).filter(([key, value]) => /^(codex|claude):[A-Za-z0-9_-]{1,128}$/.test(key) && typeof value === 'boolean'))
    } catch { return {} }
}
