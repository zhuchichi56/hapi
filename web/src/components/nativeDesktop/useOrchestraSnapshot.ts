import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import type { OrchestraSnapshot } from './OrchestraBoard'

const SNAPSHOT_PATH = '/api/orchestra/snapshot'
const POLL_MS = 2000
const REQUEST_TIMEOUT_MS = 4000

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

    const load = useCallback(async () => {
        if (!mountedRef.current || inFlightRef.current) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        inFlightRef.current = true
        setRefreshing(true)
        const generation = ++generationRef.current
        const controller = new AbortController()
        abortRef.current = controller
        const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
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
            if (generation === generationRef.current) { inFlightRef.current = false; if (mountedRef.current) setRefreshing(false) }
        }
    }, [baseUrl, token])

    useEffect(() => {
        mountedRef.current = true
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
        return () => {
            mountedRef.current = false
            generationRef.current += 1
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('focus', tick)
            window.removeEventListener('orchestra:changed', tick)
            abortRef.current?.abort()
            abortRef.current = null
            inFlightRef.current = false
        }
    }, [load])

    return { snapshot, connection, receivedAt, refreshing, load, setConnection, mountedRef }
}
