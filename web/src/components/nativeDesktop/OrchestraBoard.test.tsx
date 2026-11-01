import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { context } = vi.hoisted(() => ({
    context: { token: 'PRIVATE_TOKEN', baseUrl: 'https://hub.example/', api: {} }
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))

import { publicProgress, OrchestraBoard, type OrchestraSnapshot, type OrchestraTask } from './OrchestraBoard'

const BACK_HREF = '/desktop?app=codex&thread=01a19339-39e6-7081-8920-82db9992402a'
const EXTERNAL_LABEL = '11月1日13:27历史快照 未接管'

function makeTask(overrides: Partial<OrchestraTask> = {}): OrchestraTask {
    return {
        id: 'T003',
        title: '首用体验报告',
        goal: '让新用户首用就知道下一步。',
        deliverables: ['首用体验报告.md'],
        acceptance: ['线上首用体验偏邀测，案例引导缺失'],
        ownership: ['web/src/components/nativeDesktop/OrchestraBoard.tsx'],
        authorization: '2026-11-02 用户授权只读展示',
        threadId: '01a19339-39e6-7081-8920-82db9992402a',
        host: 'local',
        createdAt: '2026-11-01T16:00:00.000Z',
        checkpoint: '报告已产出',
        expectedAt: '2026-11-02T02:15:00.000+08:00',
        execution: 'running',
        review: 'pending',
        archive: 'none',
        observedAt: '2026-11-01T16:57:00.000Z',
        sourceAt: '2026-11-01T16:56:00.000Z',
        progress: '线上首用体验偏邀测，案例引导缺失；同版本完整旅程旁证4/6走完。',
        latestAction: '完成首用体验报告',
        evidence: ['首用体验报告.md'],
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
    return { ok: status >= 200 && status < 300, status, json: async () => value } as Response
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

function cards(): HTMLElement[] {
    return screen.getAllByTestId('ob-table-row')
}

function treeNodes(): HTMLElement[] {
    return within(screen.getByTestId('ob-tree')).getAllByTestId('ob-tree-node').filter(node => !node.closest('.ob-tree-archive'))
}

function artifactResponse(content = '# 报告\n\n[线上报告](https://example.test/report)\n\n[本地记录](docs/report.md)') {
    return jsonResponse({ name: '首用体验报告.md', content })
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

    it('renders a minimal main task list, a collapsed optional tree and isolated external history', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({ id: 'T003', title: '首用体验报告', execution: 'running' }),
            makeTask({ id: 'T010', title: '等待验收任务', execution: 'blocked', review: 'awaiting', attention: true, createdAt: '2026-11-01T16:20:00.000Z' }),
            makeTask({ id: 'H001', title: '历史导入任务', external: true, stale: true })
        ])))
        render(<OrchestraBoard />)
        await screen.findByText('任务总控')
        await screen.findByTestId('ob-tree')

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('https://hub.example/api/orchestra/snapshot')
        expect(init).toMatchObject({ method: 'GET', cache: 'no-store', headers: { accept: 'application/json', authorization: 'Bearer PRIVATE_TOKEN' } })
        expect(document.body.innerHTML).not.toContain('PRIVATE_TOKEN')

        expect(screen.getByRole('link', { name: /返回总控对话/ })).toHaveAttribute('href', BACK_HREF)
        expect(screen.getByTestId('ob-tree')).not.toHaveAttribute('open')
        expect(treeNodes().map(node => node.querySelector('.ob-node-title')?.textContent)).toEqual(['等待验收任务', '首用体验报告'])

        expect(cards().map(card => card.querySelector('.ob-row-title')?.textContent)).toEqual(['等待验收任务', '首用体验报告'])
        expect(within(cards()[0]).getByText('待验收')).toBeInTheDocument()
        expect(within(cards()[1]).getByText('进行中')).toBeInTheDocument()
        expect(within(cards()[1]).getByText('线上首用体验偏邀测，案例引导缺失；同版本完整旅程旁证4/6走完。')).toBeInTheDocument()
        expect(within(cards()[1]).getByRole('button', { name: '查看成果' })).toBeInTheDocument()
        expect(within(cards()[1]).getByRole('link', { name: '原工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=01a19339-39e6-7081-8920-82db9992402a')

        expect(cards().some(card => card.dataset.taskId === 'H001')).toBe(false)
        expect(document.querySelector('.ob-external')).not.toHaveAttribute('open')
        expect(screen.getByRole('heading', { name: EXTERNAL_LABEL })).toBeInTheDocument()
        expect(screen.getByTestId('ob-external-card')).toHaveTextContent('历史导入任务')
    })

    it('opens the minimal card and one record entry, then loads the registered report through the artifact API', async () => {
        fetchMock.mockImplementation(async (url: string) => String(url).includes('/api/orchestra/artifact')
            ? artifactResponse()
            : jsonResponse(makeSnapshot([makeTask({ id: 'T003', title: '首用体验报告' })])))
        render(<OrchestraBoard />)
        await screen.findByTestId('ob-table-row')
        fireEvent.click(within(cards()[0]).getByRole('button', { name: /首用体验报告/ }))

        const detail = screen.getByTestId('ob-detail')
        expect(within(detail).getByRole('heading', { name: '首用体验报告' })).toBeInTheDocument()
        expect(within(detail).getByText('进行中')).toBeInTheDocument()
        expect(within(detail).getByText('线上首用体验偏邀测，案例引导缺失；同版本完整旅程旁证4/6走完。', { selector: '.ob-mini-brief' })).toBeInTheDocument()
        expect(within(detail).getByTestId('ob-record')).toBeInTheDocument()
        expect(detail.querySelectorAll('details')).toHaveLength(1)
        expect(within(detail).getByText('2026-11-02 用户授权只读展示')).toBeInTheDocument()

        fireEvent.click(within(detail).getByRole('button', { name: '查看成果' }))
        expect(await within(detail).findByText('线上报告')).toBeInTheDocument()
        expect(within(detail).getByRole('link', { name: '线上报告' })).toHaveAttribute('href', 'https://example.test/report')
        expect(within(detail).getByText('本地记录')).toHaveAttribute('title', '附件请从原工作对话查看')

        const call = fetchMock.mock.calls.find(([value]) => String(value).includes('/api/orchestra/artifact')) as [string, RequestInit]
        expect(call[0]).toBe('https://hub.example/api/orchestra/artifact?task=T003&index=0')
        expect(call[1]).toMatchObject({ cache: 'no-store', headers: { accept: 'application/json', authorization: 'Bearer PRIVATE_TOKEN' } })
    })

    it('shows 成果暂不可用 and keeps the original conversation entry when artifact loading fails', async () => {
        fetchMock.mockImplementation(async (url: string) => String(url).includes('/api/orchestra/artifact')
            ? Promise.reject(new Error('PRIVATE artifact detail'))
            : jsonResponse(makeSnapshot([makeTask({ id: 'T003', title: '失败成果任务' })])))
        render(<OrchestraBoard />)
        await screen.findByTestId('ob-table-row')
        fireEvent.click(within(cards()[0]).getByRole('button', { name: /失败成果任务/ }))
        const detail = screen.getByTestId('ob-detail')
        fireEvent.click(within(detail).getByRole('button', { name: '查看成果' }))
        expect(await within(detail).findByText('成果暂不可用。')).toBeInTheDocument()
        expect(within(detail).getByRole('link', { name: '原工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=01a19339-39e6-7081-8920-82db9992402a')
        expect(document.body.innerHTML).not.toContain('PRIVATE artifact detail')
    })

    it('suppresses stale warnings for archived accepted history but warns on truly stale active work', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({ id: 'T003', title: '活跃过期任务', stale: true }),
            makeTask({ id: 'T900', title: '已验收归档任务', execution: 'reported', review: 'accepted', archive: 'archived', stale: true })
        ])))
        render(<OrchestraBoard />)
        await screen.findAllByTestId('ob-table-row')
        const archivedCard = cards().find(card => card.dataset.taskId === 'T900')!
        const activeCard = cards().find(card => card.dataset.taskId === 'T003')!
        expect(within(archivedCard).queryByText('观测过期')).not.toBeInTheDocument()
        expect(within(activeCard).getByText('观测过期')).toBeInTheDocument()

        fireEvent.click(within(activeCard).getByRole('button', { name: /活跃过期任务/ }))
        expect(within(screen.getByTestId('ob-detail')).getByText('观测数据已过期，以下为上次快照。')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: '关闭任务详情' }))
        fireEvent.click(within(archivedCard).getByRole('button', { name: /已验收归档任务/ }))
        expect(within(screen.getByTestId('ob-detail')).queryByText('观测数据已过期，以下为上次快照。')).not.toBeInTheDocument()
    })

    it('syncs tree selection to the task card and refreshes the open mini card after polling', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(makeSnapshot([makeTask({ id: 'T003', title: '轮询任务', progress: '旧简报：正在整理。' })])))
            .mockResolvedValueOnce(jsonResponse(makeSnapshot([makeTask({ id: 'T003', title: '轮询任务', execution: 'reported', review: 'awaiting', progress: '新简报：报告已提交验收。' })])))
        render(<OrchestraBoard />)
        await screen.findByTestId('ob-table-row')
        fireEvent.click(treeNodes()[0])
        expect(within(cards()[0]).getByRole('button', { name: /轮询任务/ })).toHaveAttribute('aria-pressed', 'true')
        expect(within(screen.getByTestId('ob-detail')).getByText('进行中')).toBeInTheDocument()

        await dispatchVisibility()
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(within(screen.getByTestId('ob-detail')).getAllByText('新简报：报告已提交验收。').length).toBeGreaterThan(0))
        const detail = screen.getByTestId('ob-detail')
        expect(within(detail).getByText('待验收')).toBeInTheDocument()
        expect(within(cards().find(card => card.dataset.taskId === 'T003')!).getByText('待验收')).toBeInTheDocument()
    })

    it('keeps the last good snapshot on failure and still refreshes every 5 seconds while visible', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-11-02T01:00:00.000Z'))
        fetchMock
            .mockResolvedValueOnce(jsonResponse(makeSnapshot([makeTask({ title: '保留的任务' })])))
            .mockRejectedValueOnce(new Error('PRIVATE network detail'))
        render(<OrchestraBoard />)
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await act(async () => { await vi.advanceTimersByTimeAsync(4_999) })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await act(async () => { await vi.advanceTimersByTimeAsync(1) })
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(document.querySelector('.ob-banner')?.textContent).toContain('采集器已断开')
        expect(screen.getAllByText('保留的任务').length).toBeGreaterThan(0)
        expect(document.body.innerHTML).not.toContain('PRIVATE network detail')
    })

    it('does not replace data with an invalid snapshot and keeps public summaries natural', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ version: 2, tasks: [] }))
        const { unmount } = render(<OrchestraBoard />)
        expect(await screen.findByText('任务总控数据暂时不可用')).toBeInTheDocument()
        expect(document.querySelector('.ob-task-card')).toBeNull()
        unmount()
        cleanup()
        expect(publicProgress('mtime 2026-11-02\n已完成体验报告。').summary).toBe('已完成体验报告。')
        expect(publicProgress('/tmp/report.md\n首用体验完成。').summary).toBe('首用体验完成。')
    })

    it('ships narrow, light-glass, mobile and reduced-motion rules', () => {
        const css = readFileSync(resolve(process.cwd(), 'src/components/nativeDesktop/OrchestraBoard.css'), 'utf8')
        expect(css).toContain('max-width: 780px')
        expect(css).toContain('@media (max-width: 600px)')
        expect(css).toContain('.ob-task-card {')
        expect(css).toContain('-webkit-line-clamp: 2')
        expect(css).toContain('@media (prefers-reduced-motion: reduce)')
        expect(css).toContain(':focus-visible')
        expect(css).toContain('@supports ((backdrop-filter')
        expect(css).toContain('backdrop-filter: blur(10px) saturate(1.08)')
        expect(css).toContain('overflow-x: hidden')
    })
    it('prefers the explicit controller brief and separates pending task and running session counts', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeSnapshot([makeTask({
            brief: '仍有一项等待负责人修复。', briefAsOf: '2026-11-02T04:20:00+08:00',
            progress: '全部完成（旧公开进度）',
        })], { pendingTaskCount: 6, runningSessionCount: 3 })))
        render(<OrchestraBoard />)
        expect(await screen.findAllByText('仍有一项等待负责人修复。')).not.toHaveLength(0)
        expect(screen.getByText('6 项待办 · 3 个对话运行')).toBeInTheDocument()
        expect(document.querySelector('.ob-task-brief')?.textContent).not.toContain('全部完成')
    })

})
