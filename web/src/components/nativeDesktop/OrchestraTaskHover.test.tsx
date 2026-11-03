import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { context } = vi.hoisted(() => ({ context: { token: 'synthetic-token', baseUrl: 'https://hub.example/', api: {} } }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))
import { OrchestraBoard, taskHoverInfo, type OrchestraSnapshot, type OrchestraTask } from './OrchestraBoard'

const NOW = new Date().toISOString()
const fetchMock = vi.fn()
function task(overrides: Partial<OrchestraTask> = {}): OrchestraTask {
    return { id: 'T9', title: 'Hover task', goal: '把任务总控做到可观测。', deliverables: [], acceptance: [], ownership: [], authorization: '', threadId: 't',
        host: 'h', createdAt: NOW, checkpoint: '', expectedAt: null, execution: 'running', review: 'pending', archive: 'none', observedAt: NOW, sourceAt: NOW,
        progress: '', latestAction: '', evidence: [], stale: false, attention: false, external: false,
        presentation: { title: 'Hover task', delivery: '', summary: '正在补齐测试。', summaryAt: NOW, nextStep: '随后提交审阅。' }, ...overrides }
}
function snap(tasks: OrchestraTask[]): OrchestraSnapshot {
    return { version: 1, generatedAt: NOW, controllerThreadId: 'c', collector: { connected: true, stale: false }, tasks }
}
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response

describe('task hover details', () => {
    beforeEach(() => {
        fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock)
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    })
    afterEach(() => { cleanup(); vi.unstubAllGlobals() })

    it('separates active execution, observed turn time and wall elapsed, with token coverage', () => {
        const info = taskHoverInfo(task({ investment: { phaseMetrics: {
            duration: { phaseElapsedSeconds: 3600, observedTurnWallSeconds: 600, activeExecutionSeconds: null },
            usage: { input: 1000, output: 500 }, coverage: 'partial', sourceAt: NOW } } }))
        expect(info.goal).toBe('把任务总控做到可观测。')
        expect(info.progress).toBe('正在补齐测试。')
        expect(info.nextStep).toBe('随后提交审阅。')
        expect(info.wall).toContain('1 小时')
        expect(info.execution).toContain('未知')
        expect(info.execution).toContain('非实际执行')
        expect(info.tokens).toBe('1500（覆盖不完整，仅已观测部分）')
        const known = taskHoverInfo(task({ investment: { phaseMetrics: { duration: { activeExecutionSeconds: 120 }, usage: { total: 9 }, coverage: 'complete' } } }))
        expect(known.execution).toBe('2 分')
        expect(known.tokens).toBe('9（覆盖完整）')
        expect(known.wall).toBe('未知')
        expect(taskHoverInfo(task()).tokens).toBe('未知（覆盖未知）')
    })

    it('shows the card on hover/focus and hides it on leave', async () => {
        fetchMock.mockResolvedValue(ok(snap([task()])))
        render(<OrchestraBoard />)
        const node = await screen.findByTestId('ob-tree-node')
        expect(screen.queryByTestId('ob-hovercard')).toBeNull()
        fireEvent.mouseEnter(node)
        const card = screen.getByTestId('ob-hovercard')
        expect(card).toHaveTextContent('总目标')
        expect(card).toHaveTextContent('累计 Token')
        expect(card).toHaveTextContent('实际执行')
        expect(card).toHaveTextContent('墙钟经过')
        fireEvent.mouseLeave(node)
        expect(screen.queryByTestId('ob-hovercard')).toBeNull()
        fireEvent.focus(node)
        expect(screen.getByTestId('ob-hovercard')).toBeTruthy()
    })

    it('keeps true tree statuses and separates reconnect from stale after a failed poll', async () => {
        fetchMock.mockResolvedValueOnce(ok(snap([task()])))
        render(<OrchestraBoard />)
        const node = await screen.findByTestId('ob-tree-node')
        expect(node.dataset.treeStatus).toBe('running')
        fetchMock.mockRejectedValue(new Error('timeout'))
        fireEvent.click(screen.getByText('刷新'))
        await screen.findByText('连接中断，正在重连')
        expect(screen.getByTestId('ob-tree-node').dataset.treeStatus).toBe('running')
        expect(screen.queryByText('数据可能已过期')).toBeNull()
    })

    it('keeps the recorded brief and separately exposes new native progress (T015 shape)', async () => {
        const t15 = task({ id: 'T015', execution: 'running', brief: '旧恢复报告：桥接已恢复。', briefAsOf: '2026-11-03T13:07:30+08:00',
            progress: '同步检查：桥接已恢复，正在验证看板能否自动显示这条新进展。', observedAt: NOW, sourceAt: null,
            presentation: { title: 'T015', delivery: '交付目标', summary: '', summaryAt: null, nextStep: '等待授权', waitingOn: 'Mac mini auth' } as OrchestraTask['presentation'] })
        const info = taskHoverInfo(t15)
        expect(info.progress).toBe('旧恢复报告：桥接已恢复。')
        expect(info.current).toContain('正在验证看板能否自动显示这条新进展')
        expect(info.current).toContain('采集')
        fetchMock.mockResolvedValue(ok(snap([t15])))
        render(<OrchestraBoard />)
        const row = await screen.findByTestId('ob-table-row')
        expect(row).toHaveTextContent('旧恢复报告')
        expect(screen.getByTestId('ob-current-activity')).toHaveTextContent('当前观测：同步检查：桥接已恢复，正在验证看板能否自动显示这条新进展')
        fireEvent.click(within(row).getByRole('button', { name: /T015/ }))
        expect(screen.getByTestId('ob-detail-current')).toHaveTextContent('当前观测')
    })

    it('does not add current activity to interrupted or reported tasks without running sessions', () => {
        for (const execution of ['interrupted', 'reported'] as const) {
            const info = taskHoverInfo(task({ execution, progress: 'Synthetic progress', brief: '最终结论。', sessions: [] }))
            expect(info.current).toBe('')
        }
    })

    it('shows current activity for a fresh linked running session using the snapshot reference time', () => {
        const linked = task({ execution: 'unknown', progress: '链接会话正在验证。', brief: '记录的结论。',
            sessions: [{ sessionId: 's1', threadId: 'th1', role: '当前交付负责人', execution: 'running', review: 'pending', responsibilityStatus: 'active', isMain: false, observedAt: NOW }] })
        expect(taskHoverInfo(linked, Date.parse(NOW)).current).toContain('链接会话正在验证')
        expect(taskHoverInfo(linked, null).current).toBe('')
    })

    it('shows source collection time separately from page refresh and refreshes on online', async () => {
        const at = new Date(Date.now() - 600_000).toISOString()
        fetchMock.mockResolvedValue(ok({ ...snap([task()]), collector: { connected: true, stale: false, lastSuccessAt: at } }))
        render(<OrchestraBoard />)
        await screen.findByTestId('ob-tree-node')
        expect(document.querySelector('.ob-last-success')).toHaveTextContent(/数据源最近采集：.*页面上次刷新：/)
        const calls = fetchMock.mock.calls.length
        window.dispatchEvent(new Event('online'))
        await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls))
    })
})
