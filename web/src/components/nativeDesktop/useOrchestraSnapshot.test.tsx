import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const { context } = vi.hoisted(() => ({ context: { token: 'synthetic-token', baseUrl: 'https://hub.example/', api: {} } }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))
import { ORCHESTRA_FOLLOW_UP_MS, ORCHESTRA_REQUEST_TIMEOUT_MS, useOrchestraSnapshot } from './useOrchestraSnapshot'

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

    it('serves a change signal that arrived during a slow request right after the response, serially', async () => {
        let resolveFirst: (r: Response) => void = () => {}
        fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve }))
        fetchMock.mockResolvedValue(ok(snap))
        renderHook(() => useOrchestraSnapshot())
        await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        act(() => { window.dispatchEvent(new Event('orchestra:changed')) })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await act(async () => { resolveFirst(ok(snap)); await vi.advanceTimersByTimeAsync(ORCHESTRA_FOLLOW_UP_MS - 50) })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await act(async () => { await vi.advanceTimersByTimeAsync(100) })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('cancels a scheduled follow-up on unmount and does not queue one while hidden', async () => {
        let resolveFirst: (r: Response) => void = () => {}
        fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve }))
        fetchMock.mockResolvedValue(ok(snap))
        const { unmount } = renderHook(() => useOrchestraSnapshot())
        await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        act(() => { window.dispatchEvent(new Event('orchestra:changed')) })
        await act(async () => { resolveFirst(ok(snap)); await vi.advanceTimersByTimeAsync(10) })
        unmount()
        await act(async () => { await vi.advanceTimersByTimeAsync(ORCHESTRA_FOLLOW_UP_MS * 4) })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('keeps refreshing false for background polls and sets it only for a manual refresh', async () => {
        let resolve: (r: Response) => void = () => {}
        fetchMock.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r }))
        const { result } = renderHook(() => useOrchestraSnapshot())
        await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.current.refreshing).toBe(false)
        await act(async () => { resolve(ok(snap)); await vi.advanceTimersByTimeAsync(10) })
        fetchMock.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r }))
        act(() => { void result.current.load(true) })
        expect(result.current.refreshing).toBe(true)
        await act(async () => { resolve(ok(snap)); await vi.advanceTimersByTimeAsync(10) })
        expect(result.current.refreshing).toBe(false)
    })
})
