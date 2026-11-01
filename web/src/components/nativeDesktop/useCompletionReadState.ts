import { useCallback, useMemo, useState } from 'react'

type Entry = { id: string; updatedAt?: number | string }
type Receipts = Record<string, string>
const prefix = 'hapi-native-completion-read-v1:'
const stamp = (entry: Entry) => String(entry.updatedAt ?? 'observed-completion')
function read(key: string): Receipts {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(prefix + key) || '{}')
        if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).filter(([key, value]) => key.length < 200 && typeof value === 'string').slice(-600))
    } catch { /* Indicators also work when storage is disabled. */ }
    return {}
}

// A viewed completion is presentation state. Native running/finished state is unchanged.
export function useCompletionReadState(scope: string) {
    const saved = useMemo(() => read(scope), [scope])
    const [scopes, setScopes] = useState<Map<string, Receipts>>(() => new Map())
    const receipts = scopes.get(scope) ?? saved
    const update = useCallback((change: (previous: Receipts) => Receipts) => {
        setScopes(previous => {
            const current = previous.get(scope) ?? saved
            const next = change(current)
            if (next === current) return previous
            const bounded = Object.fromEntries(Object.entries(next).slice(-600))
            try { localStorage.setItem(prefix + scope, JSON.stringify(bounded)) } catch { /* Keep the in-memory receipt. */ }
            const result = new Map(previous); result.set(scope, bounded); return result
        })
    }, [scope, saved])
    const markRead = useCallback((app: string, entry: Entry) => update(previous => {
        const key = `${app}:${entry.id}`, version = stamp(entry)
        return previous[key] === version ? previous : { ...previous, [key]: version }
    }), [update])
    const observeRunning = useCallback((app: string, ids: string[]) => update(previous => {
        const keys = ids.map(id => `${app}:${id}`).filter(key => Object.hasOwn(previous, key))
        if (!keys.length) return previous
        const next = { ...previous }; for (const key of keys) delete next[key]; return next
    }), [update])
    return { markRead, observeRunning, unread: (app: string, entry: Entry) => receipts[`${app}:${entry.id}`] !== stamp(entry) }
}
