import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import type { OrchestraSnapshot } from './OrchestraBoard'

const SNAPSHOT_PATH = '/api/orchestra/snapshot'
/** 1s with inFlightRef serialization: a response slower than the interval no longer waits for the next 2s tick. Hidden pages are paused. */
const POLL_MS = 1000
/** Snapshot requests measured about 3-3.5s; the previous 4s abort left little margin and caused false offline states and retries. */
export const ORCHESTRA_REQUEST_TIMEOUT_MS = 12_000
/** A trigger (tick/changed/focus/online) that arrived while a slow request was in flight is served right after the response, not up to a full tick later. Floor keeps this from becoming a busy loop. */
export const ORCHESTRA_FOLLOW_UP_MS = 250

function isSnapshot(value: unknown): value is OrchestraSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as { version?: unknown; tasks?: unknown }
    return record.version === 1 && Array.isArray(record.tasks)
}

function snapshotUrl(baseUrl: string): string {
    try {
        return new URL(SNAPSHOT_PATH, baseUrl).toString()
    } catch {
        return SNAPSHOT_PATH
    }
}

/** Used by the conditionally mounted task or system view; keeps the existing refresh policy. */
export function useOrchestraSnapshot() {
    const { token, baseUrl } = useAppContext()
    const [snapshot, setSnapshot] = useState<OrchestraSnapshot | null>(null)
    const [connection, setConnection] = useState<'loading' | 'online' | 'offline'>('loading')
    const [receivedAt, setReceivedAt] = useState<number | null>(null)
    const [refreshing, setRefreshing] = useState(false)
    const mountedRef = useRef(false)
    const inFlightRef = useRef(false)
    const abortRef = useRef<AbortController | null>(null)
    const generationRef = useRef(0)
    const pendingRef = useRef(false)
    const followUpRef = useRef<number | null>(null)
    const loadRef = useRef<() => Promise<void>>(async () => {})

    const load = useCallback(async () => {
        if (!mountedRef.current) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        if (inFlightRef.current) { pendingRef.current = true; return }
        pendingRef.current = false
        inFlightRef.current = true
        setRefreshing(true)
        const generation = ++generationRef.current
        const controller = new AbortController()
        abortRef.current = controller
        const timer = window.setTimeout(() => controller.abort(), ORCHESTRA_REQUEST_TIMEOUT_MS)
        try {
            const response = await fetch(snapshotUrl(baseUrl), {
                method: 'GET',
                headers: { accept: 'application/json', authorization: `Bearer ${token}` },
                cache: 'no-store',
                signal: controller.signal
            })
            if (!response.ok) throw Error('Orchestra snapshot request failed')
            const value: unknown = await response.json()
            if (!isSnapshot(value)) throw Error('Orchestra snapshot response is invalid')
            if (!mountedRef.current || generation !== generationRef.current) return
            setSnapshot(value)
            setReceivedAt(Date.now())
            setConnection('online')
        } catch {
            if (!mountedRef.current || generation !== generationRef.current) return
            setConnection('offline')
        } finally {
            window.clearTimeout(timer)
            if (abortRef.current === controller) abortRef.current = null
            if (generation === generationRef.current) {
                inFlightRef.current = false
                if (mountedRef.current) {
                    setRefreshing(false)
                    // Response-driven follow-up: still serial (only after this request settled), at least FOLLOW_UP_MS apart.
                    if (pendingRef.current && followUpRef.current === null) {
                        followUpRef.current = window.setTimeout(() => { followUpRef.current = null; void loadRef.current() }, ORCHESTRA_FOLLOW_UP_MS)
                    }
                }
            }
        }
    }, [baseUrl, token])

    useEffect(() => {
        mountedRef.current = true
        loadRef.current = load
        const tick = () => {
            if (document.visibilityState === 'visible') void load()
        }
        tick()
        const interval = window.setInterval(tick, POLL_MS)
        const onVisibility = () => {
            if (document.visibilityState === 'visible') void load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('focus', tick)
        window.addEventListener('orchestra:changed', tick)
        window.addEventListener('online', tick)
        return () => {
            mountedRef.current = false
            generationRef.current += 1
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('focus', tick)
            window.removeEventListener('orchestra:changed', tick)
            window.removeEventListener('online', tick)
            abortRef.current?.abort()
            abortRef.current = null
            inFlightRef.current = false
            pendingRef.current = false
            if (followUpRef.current !== null) { window.clearTimeout(followUpRef.current); followUpRef.current = null }
        }
    }, [load])

    return { snapshot, connection, receivedAt, refreshing, load, setConnection, mountedRef }
}
