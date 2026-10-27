import { useCallback, useMemo, useState, type SetStateAction } from 'react'
import type { DraftImage } from './attachments'
type Draft = { text: string; images: DraftImage[] }
const prefix = 'hapi-native-draft-v1:'
export function composerStorageScope(token?: string, baseUrl?: string) {
    let identity = 'session', owner = false
    try {
        const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))))
        identity = JSON.stringify([payload.uid, payload.ns]); owner = payload.ns === 'default'
    } catch { /* No credentials are placed in storage keys. */ }
    return { key: JSON.stringify([baseUrl || location.origin, identity]), owner }
}
const read = (key: string, legacy?: string) => {
    try {
        const saved = sessionStorage.getItem(prefix + key)
        if (saved !== null || !legacy) return saved ?? ''
        const old = sessionStorage.getItem(prefix + legacy) ?? ''
        if (old) { sessionStorage.setItem(prefix + key, old); sessionStorage.removeItem(prefix + legacy) }
        return old
    } catch { return '' }
}
// Text survives a tab refresh. Unsent image bytes stay only in this page's memory.
export function useComposerDraft(key: string, legacy?: string) {
    const [drafts, setDrafts] = useState<Map<string, Draft>>(() => new Map())
    const initial = useMemo<Draft>(() => ({ text: read(key, legacy), images: [] }), [key, legacy])
    const value = drafts.get(key) ?? initial
    const update = useCallback((change: (previous: Draft) => Draft) => {
        setDrafts(previous => {
            const next = change(previous.get(key) ?? initial)
            try {
                if (next.text) sessionStorage.setItem(prefix + key, next.text)
                else sessionStorage.removeItem(prefix + key)
            } catch { /* Input still works when browser storage is unavailable. */ }
            const result = new Map(previous); result.set(key, next); return result
        })
    }, [key, initial])
    const setText = useCallback((next: SetStateAction<string>) => update(old => ({ ...old, text: typeof next === 'function' ? next(old.text) : next })), [update])
    const setImages = useCallback((next: SetStateAction<DraftImage[]>) => update(old => ({ ...old, images: typeof next === 'function' ? next(old.images) : next })), [update])
    return [value.text, setText, value.images, setImages] as const
}
