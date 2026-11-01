import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'

const { context } = vi.hoisted(() => ({
    context: { token: 'PRIVATE_TOKEN', baseUrl: 'https://hub.example/', api: {} }
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))

import { OrchestraBoard, type OrchestraSnapshot, type OrchestraTask } from './OrchestraBoard'

const BACK_HREF = '/desktop?app=codex&thread=01a19339-39e6-7081-8920-82db9992402a'
const EXTERNAL_LABEL = '11月1日13:27历史快照 未接管'

function makeTask(overrides: Partial<OrchestraTask> = {}): OrchestraTask {
    return {
        id: 'T009',
        title: '实现只读任务总控看板',
        goal: '用户打开 Desktop 就能看到队列、进展、工作链接和交付。',
        deliverables: ['OrchestraBoard.tsx', 'orchestra.ts'],
        acceptance: ['390px 无横向溢出'],
        ownership: ['web/src/components/nativeDesktop/OrchestraBoard.tsx'],
        authorization: '2026-11-02 用户授权只读展示',
        threadId: '01a19339-39e6-7081-8920-82db9992402a',
        host: 'local',
        createdAt: '2026-11-01T16:00:00.000Z',
        checkpoint: '后端路由与前端看板完成',
        expectedAt: '2026-11-02T02:15:00.000+08:00',
        execution: 'running',
        review: 'pending',
        archive: 'none',
        observedAt: '2026-11-01T16:57:00.000Z',
        sourceAt: '2026-11-01T16:56:00.000Z',
        progress: '正在实现只读快照路由和看板。',
        latestAction: '读取任务队列',
        evidence: ['bun test hub/src/web/routes/orchestra.test.ts'],
        stale: false,
        attention: false,
        external: false,
        ...overrides
    }
}

function makeSnapshot(tasks: OrchestraTask[], overrides: Partial<OrchestraSnapshot> = {}): OrchestraSnapshot {
    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        controllerThreadId: '01a19339-39e6-7081-8920-82db9992402a',
        collector: { connected: true, stale: false, lastSuccessAt: new Date().toISOString() },
        tasks,
        notices: [],
        operations: [],
        ...overrides
    }
}

function jsonResponse(value: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => value
    } as Response
}

const fetchMock = vi.fn()

function setVisibility(value: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
}

function resetVisibility() {
    delete (document as unknown as { visibilityState?: string }).visibilityState
}

async function dispatchVisibility() {
    await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await Promise.resolve()
    })
}

describe('OrchestraBoard', () => {
    beforeEach(() => {
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
        setVisibility('visible')
    })
    afterEach(() => {
        cleanup()
        vi.useRealTimers()
        vi.unstubAllGlobals()
        resetVisibility()
    })

    it('reads the authenticated snapshot with no-store and renders the working contract', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({ id: 'T009', title: '运行中的执行任务', execution: 'running', createdAt: '2026-11-01T16:00:00.000Z' }),
            makeTask({
                id: 'T010', title: '等待验收的阻塞任务', execution: 'blocked', review: 'awaiting', attention: true,
                threadId: '01b19339-39e6-7081-8920-82db9992402a', createdAt: '2026-11-01T16:20:00.000Z'
            }),
            makeTask({
                id: 'T011', title: '已验收归档任务', execution: 'reported', review: 'accepted', archive: 'archived',
                createdAt: '2026-11-01T16:10:00.000Z'
            }),
            makeTask({ id: 'H001', title: '历史导入任务', external: true, stale: true, execution: 'unknown', review: 'pending' })
        ])))
        render(<OrchestraBoard />)
        expect(await screen.findByText('任务总控')).toBeInTheDocument()
        expect(await screen.findByText('等待验收的阻塞任务')).toBeInTheDocument()

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('https://hub.example/api/orchestra/snapshot')
        expect(init).toMatchObject({
            method: 'GET',
            cache: 'no-store',
            headers: { accept: 'application/json', authorization: 'Bearer PRIVATE_TOKEN' }
        })
        expect(init.signal).toBeInstanceOf(AbortSignal)
        expect(document.body.innerHTML).not.toContain('PRIVATE_TOKEN')

        expect(screen.getByRole('link', { name: /返回总控对话/ })).toHaveAttribute('href', BACK_HREF)
        const cards = Array.from(document.querySelectorAll<HTMLElement>('.ob-card'))
        expect(cards.map(card => card.querySelector('h2')?.textContent)).toEqual([
            '等待验收的阻塞任务', '运行中的执行任务', '已验收归档任务', '历史导入任务'
        ])
        const blocked = cards[0]
        expect(within(blocked).getByText('执行 · 已阻塞')).toBeInTheDocument()
        expect(within(blocked).getByText('验收 · 待验收')).toBeInTheDocument()
        expect(within(blocked).getByText('归档 · 未归档')).toBeInTheDocument()
        expect(within(blocked).getByRole('link', { name: '工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=01b19339-39e6-7081-8920-82db9992402a')

        const archived = cards[2]
        expect(within(archived).getByText('执行 · 已回报')).toBeInTheDocument()
        expect(within(archived).getByText('验收 · 已验收')).toBeInTheDocument()
        expect(within(archived).getByText('归档 · 已归档')).toBeInTheDocument()

        expect(within(document.body).getByRole('button', { name: /全部/ }).textContent).toBe('全部3')
        expect(within(document.body).getByRole('button', { name: /需处理/ }).textContent).toBe('需处理1')
        expect(within(document.body).getByRole('button', { name: /排队/ }).textContent).toBe('排队0')
        expect(within(document.body).getByRole('button', { name: /运行中/ }).textContent).toBe('运行中1')
        expect(within(document.body).getByRole('button', { name: /待验收/ }).textContent).toBe('待验收1')
        expect(within(document.body).getByRole('button', { name: /已归档/ }).textContent).toBe('已归档1')

        expect(screen.getByRole('heading', { name: EXTERNAL_LABEL })).toBeInTheDocument()
        const external = cards[3]
        expect(within(external).getByText('历史快照 · 未接管')).toBeInTheDocument()
        expect(within(external).getByRole('link', { name: '原对话（未接管）' })).toHaveAttribute('href', '/desktop?app=codex&thread=01a19339-39e6-7081-8920-82db9992402a')
    })

    it('keeps the last good snapshot and marks the collector disconnected on failure', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(makeSnapshot([makeTask({ title: '保留的任务' })])))
            .mockRejectedValueOnce(new Error('PRIVATE network detail'))
        render(<OrchestraBoard />)
        await screen.findByText('保留的任务')
        await dispatchVisibility()
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(document.querySelector('.ob-banner')).not.toBeNull())
        expect(screen.getByText('保留的任务')).toBeInTheDocument()
        const banner = document.querySelector('.ob-banner')!
        expect(banner.textContent).toContain('采集器已断开')
        expect(banner.textContent).toContain('显示上次成功快照，实时状态暂停更新。')
        expect(document.body.innerHTML).not.toContain('PRIVATE network detail')
    })

    it('does not overlap polls while a request is still in flight', async () => {
        let resolveFetch: (response: Response) => void = () => {}
        fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
        render(<OrchestraBoard />)
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        await dispatchVisibility()
        await dispatchVisibility()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await act(async () => { resolveFetch(jsonResponse(makeSnapshot([makeTask()]))) })
        await screen.findByText('实现只读任务总控看板')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('polls every 5 seconds only while the document is visible', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-11-02T01:00:00.000Z'))
        fetchMock.mockImplementation(async () => jsonResponse(makeSnapshot([makeTask()])))
        render(<OrchestraBoard />)
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        expect(fetchMock).toHaveBeenCalledTimes(1)

        await act(async () => { await vi.advanceTimersByTimeAsync(4_999) })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await act(async () => { await vi.advanceTimersByTimeAsync(1) })
        expect(fetchMock).toHaveBeenCalledTimes(2)

        setVisibility('hidden')
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
        expect(fetchMock).toHaveBeenCalledTimes(2)

        setVisibility('visible')
        await dispatchVisibility()
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('does not fetch while hidden and resumes immediately when visible', async () => {
        setVisibility('hidden')
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask()])))
        render(<OrchestraBoard />)
        await act(async () => { await Promise.resolve() })
        expect(fetchMock).not.toHaveBeenCalled()
        setVisibility('visible')
        await dispatchVisibility()
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    })

    it('aborts a stuck request after the finite client timeout', async () => {
        vi.useFakeTimers()
        fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }))
        render(<OrchestraBoard />)
        await act(async () => {
            vi.advanceTimersByTime(4_000)
            await Promise.resolve()
        })
        expect(screen.getByText('任务总控数据暂时不可用')).toBeInTheDocument()
    })

    it('does not replace good data with an invalid snapshot', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ version: 2, tasks: [] }))
        render(<OrchestraBoard />)
        expect(await screen.findByText('任务总控数据暂时不可用')).toBeInTheDocument()
        expect(document.querySelector('.ob-card')).toBeNull()
    })

    it('escapes every displayed value and never injects HTML', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            title: '<img src=x onerror="alert(1)">',
            progress: '<script>alert(1)</script>',
            latestAction: '<b>action</b>',
            deliverables: ['<b>bold deliverable</b>'],
            evidence: ['<iframe src="https://example.invalid"></iframe>']
        })])))
        render(<OrchestraBoard />)
        expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument()
        expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
        expect(document.querySelector('.ob-card img')).toBeNull()
        expect(document.querySelector('.ob-card script')).toBeNull()
        expect(document.querySelector('.ob-card iframe')).toBeNull()
    })

    it('marks a collector that reports itself disconnected as stale without hiding data', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({ title: '仍然可见的任务' })], {
            collector: { connected: false, stale: false }
        })))
        render(<OrchestraBoard />)
        await screen.findByText('仍然可见的任务')
        expect(await screen.findByText('采集器未连接')).toBeInTheDocument()
        expect(screen.getByText('仍然可见的任务')).toBeInTheDocument()
    })
})
