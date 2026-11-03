import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const { context } = vi.hoisted(() => ({ context: { token: 'synthetic-token', baseUrl: 'https://hub.example/', api: {} } }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))
import { ORCHESTRA_REQUEST_TIMEOUT_MS, useOrchestraSnapshot } from './useOrchestraSnapshot'

const fetchMock = vi.fn()
const snap = { version: 1, generatedAt: '2026-11-03T00:00:00Z', controllerThreadId: 'c', collector: {}, tasks: [{ id: 'T1' }] }
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response

describe('useOrchestraSnapshot', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    })
    afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

    it('allows slow cold snapshots beyond the old 4s abort', async () => {
        expect(ORCHESTRA_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(12_000)
        let signal: AbortSignal | undefined
        fetchMock.mockImplementation((_url: string, init: RequestInit) => {
            signal = init.signal as AbortSignal
            return new Promise<Response>(resolve => setTimeout(() => resolve(ok(snap)), 9_500))
        })
        const { result } = renderHook(() => useOrchestraSnapshot())
        await act(async () => { await vi.advanceTimersByTimeAsync(9_600) })
        expect(signal?.aborted).toBe(false)
        expect(result.current.connection).toBe('online')
        expect(result.current.snapshot?.tasks).toHaveLength(1)
        // 1s polling must stay serialized: exactly one request during the slow response.
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('aborts after the request budget and keeps the last valid snapshot while offline', async () => {
        fetchMock.mockResolvedValueOnce(ok(snap))
        const { result } = renderHook(() => useOrchestraSnapshot())
        await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        expect(result.current.connection).toBe('online')
        const received = result.current.receivedAt
        fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')))
        }))
        await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
        expect(result.current.connection).toBe('online')
        await act(async () => { await vi.advanceTimersByTimeAsync(ORCHESTRA_REQUEST_TIMEOUT_MS + 100) })
        expect(result.current.connection).toBe('offline')
        expect(result.current.snapshot?.tasks[0]).toMatchObject({ id: 'T1' })
        expect(result.current.receivedAt).toBe(received)
    })
})
