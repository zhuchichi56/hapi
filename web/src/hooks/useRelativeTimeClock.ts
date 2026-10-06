import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let tick = 0
const snapshot = () => tick
const refresh = () => {
    if (document.visibilityState === 'hidden') return
    tick += 1
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (listeners.size === 1) {
        timer = setInterval(refresh, 30_000)
        document.addEventListener('visibilitychange', refresh)
    }
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
            clearInterval(timer)
            timer = undefined
            document.removeEventListener('visibilitychange', refresh)
        }
    }
}

/** All session rows share one visible-tab clock, including mention tooltips. */
export function useRelativeTimeClock(): void {
    useSyncExternalStore(subscribe, snapshot, snapshot)
}
