import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const { context } = vi.hoisted(() => ({ context: { token: 'synthetic-token', baseUrl: 'https://hub.example/', api: {} } }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))
import { OrchestraBoard, taskHoverInfo, type OrchestraSnapshot, type OrchestraTask, type OrchestraTaskUsage } from './OrchestraBoard'

const NOW = new Date().toISOString()
const fetchMock = vi.fn()
const usage: OrchestraTaskUsage = {
    available: true, sourceAt: NOW,
    model: { scope: 'task_cumulative', sourceAt: NOW, coverage: 'partial', responsePending: true, toolCalls: 316,
        steps: { completed: 325, coverage: 'partial' },
        tokens: { input: 50433642, output: 223249, cacheRead: 48978496, cacheWrite: 1454171, nativeTotal: 50656891, derivedTotal: 50656891 } },
    executor: { scope: 'observed_executor_invocations_only', sourceAt: NOW, coverage: 'partial', executionSeconds: 872, gap: 'only round 2 recorded',
        tokensSourceAt: NOW, steps: { completed: null }, tokens: { input: 2566242, output: 80736, cacheRead: 2448650, cacheWrite: 117460, nativeTotal: null, derivedTotal: 2646978 } },
    result: { metric: 'local reader median', before: 0.26368208, after: 0.107675, unit: 'ms' }
}
function task(overrides: Partial<OrchestraTask> = {}): OrchestraTask {
    return { id: 'T9', title: 'Hover task', goal: '把任务总控做到可观测。', deliverables: [], acceptance: [], ownership: [], authorization: '', threadId: 't',
        host: 'h', createdAt: NOW, checkpoint: '', expectedAt: null, execution: 'running', review: 'pending', archive: 'none', observedAt: NOW, sourceAt: NOW,
        progress: '', latestAction: '', evidence: [], stale: false, attention: false, external: false,
        presentation: { title: 'Hover task', delivery: '', summary: '已完成接线。', summaryAt: NOW, nextStep: '随后提交审阅。' }, ...overrides }
}
const snap = (tasks: OrchestraTask[]): OrchestraSnapshot => ({ version: 1, generatedAt: NOW, controllerThreadId: 'c', collector: { connected: true, stale: false }, tasks })
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response

describe('task usage on the hover card', () => {
    beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
    afterEach(() => { cleanup(); vi.unstubAllGlobals() })

    it('groups steps + Token + duration of the same model scope; duration is unknown, executor runtime is not mixed in', () => {
        const info = taskHoverInfo(task({ investment: { taskUsage: usage } }))
        expect(info.invest).toBe('历时未知 ｜ 325 步 ｜ 50,656,891 Token')
        expect(info.invest).not.toContain('872')
        expect(info.invest).not.toContain('14m')
        const executor = info.investDetails.find(item => item.label.startsWith('执行者'))!
        expect(executor.value).toContain('14 分 32 秒')
        expect(executor.value).toContain('步数未知')
        expect(executor.value).toContain('2,646,978（推算）')
    })

    it('keeps input/cache/coverage/source time in details and unknown values unknown', () => {
        const info = taskHoverInfo(task({ investment: { taskUsage: { available: true, model: { scope: 'task_cumulative', coverage: 'partial', steps: { completed: null }, tokens: null } } } }))
        expect(info.invest).toBe('历时未知 ｜ 步数未知 ｜ Token 未知')
        expect(info.investDetails[0].value).toContain('更新时间未知')
        const full = taskHoverInfo(task({ investment: { taskUsage: usage } })).investDetails[0].value
        expect(full).toContain('输入 50,433,642（含缓存读 48,978,496 / 缓存写 1,454,171）')
        expect(full).toContain('当前响应用量待记录')
        expect(full).toContain('工具调用 316 次')
        expect(taskHoverInfo(task({ investment: { taskUsage: { available: false, model: usage.model } } })).invest).toBe('')
    })

    it('renders 目标/当前结果/下一步/投入 with details collapsed, and never shows the local benchmark', async () => {
        fetchMock.mockResolvedValue(ok(snap([task({ investment: { taskUsage: usage } })])))
        render(<OrchestraBoard />)
        fireEvent.mouseEnter(await screen.findByTestId('ob-tree-node'))
        const card = screen.getByTestId('ob-hovercard')
        for (const word of ['目标', '当前结果', '下一步']) expect(card).toHaveTextContent(word)
        expect(card).toHaveTextContent('已完成接线。')
        expect(card.querySelector('[data-field="invest"]')).toHaveTextContent('历时未知 ｜ 325 步 ｜ 50,656,891 Token')
        const details = card.querySelector('details[data-field="invest-details"]') as HTMLDetailsElement
        expect(details).toBeTruthy()
        expect(details.open).toBe(false)
        expect(details).toHaveTextContent('缓存读')
        expect(card).not.toHaveTextContent('0.26')
        expect(card).not.toHaveTextContent('0.107')
        expect(card).not.toHaveTextContent('ms')
        expect(card).not.toHaveTextContent('用量与耗时暂未接入')
    })

    it('shows an independent executor main line when there is no model usage, without raw English gap text', () => {
        const info = taskHoverInfo(task({ investment: { taskUsage: { available: true, executor: usage.executor } } }))
        expect(info.invest).toBe('执行者 耗时 14m32s ｜ 步数未知 ｜ 2,646,978 Token')
        expect(JSON.stringify(info.investDetails)).not.toContain('only round 2')
    })

    it('no legacy dl under 投入, current observation lives in collapsed details, only four main sections', async () => {
        const t = task({ investment: { taskUsage: usage, phaseMetrics: { usage: { total: 5 }, coverage: 'complete' } } })
        fetchMock.mockResolvedValue(ok(snap([t])))
        render(<OrchestraBoard />)
        fireEvent.mouseEnter(await screen.findByTestId('ob-tree-node'))
        const card = screen.getByTestId('ob-hovercard')
        expect(card.querySelector('[data-field="tokens"]')).toBeNull()
        expect(card.querySelector('[data-field="execution"]')).toBeNull()
        for (const p of Array.from(card.querySelectorAll(':scope > p[data-field]'))) expect(['goal', 'progress', 'next', 'invest']).toContain(p.getAttribute('data-field'))
        const current = card.querySelector('[data-field="current"]')
        if (current) expect(current.closest('details')).toBeTruthy()
    })

    it('leaving the node into the card keeps it open; focus into details stays; Escape closes', async () => {
        fetchMock.mockResolvedValue(ok(snap([task({ investment: { taskUsage: usage } })])))
        render(<OrchestraBoard />)
        const node = await screen.findByTestId('ob-tree-node')
        fireEvent.mouseEnter(node)
        const card = screen.getByTestId('ob-hovercard')
        fireEvent.mouseLeave(node, { relatedTarget: card })
        expect(screen.queryByTestId('ob-hovercard')).toBeTruthy()
        const summary = card.querySelector('summary') as HTMLElement
        fireEvent.blur(node, { relatedTarget: summary })
        expect(screen.queryByTestId('ob-hovercard')).toBeTruthy()
        fireEvent.keyDown(summary, { key: 'Escape' })
        expect(screen.queryByTestId('ob-hovercard')).toBeNull()
        fireEvent.mouseEnter(node)
        fireEvent.mouseLeave(node, { relatedTarget: document.body })
        expect(screen.queryByTestId('ob-hovercard')).toBeNull()
    })

    it('uses elapsed time only when the producer labels it with the same model scope', () => {
        const same = taskHoverInfo(task({ investment: { taskUsage: { ...usage, wall: { seconds: 3600, scope: 'task_cumulative' } } } }))
        expect(same.invest).toBe('历时 1h ｜ 325 步 ｜ 50,656,891 Token')
        const other = taskHoverInfo(task({ investment: { taskUsage: { ...usage, wall: { seconds: 3600, scope: 'planner_turn' } } } }))
        expect(other.invest).toContain('历时未知')
    })

    it('keeps curated T020 goal/result and shows 投入 beside it', () => {
        const info = taskHoverInfo(task({ id: 'T020', investment: { taskUsage: usage } }))
        expect(info.want).toBe('查清总控派工和验收为什么慢')
        expect(info.result).not.toContain('ms')
        expect(info.invest).toContain('325 步')
    })

    it('puts the one-line footer last (time ｜ steps ｜ Token, exact figures), result first, and invents no plan', async () => {
        const wall = { seconds: 28 * 3600 + 12 * 60, scope: 'task_cumulative' }
        const big = { ...usage, wall, model: { ...usage.model!, steps: { completed: 362 }, tokens: { nativeTotal: 55591897 } } }
        fetchMock.mockResolvedValue(ok(snap([task({ acceptance: ['✅ 验收一', '⌛ 验收二'], investment: { taskUsage: big } })])))
        render(<OrchestraBoard />)
        fireEvent.mouseEnter(await screen.findByTestId('ob-tree-node'))
        const card = screen.getByTestId('ob-hovercard')
        const footer = card.querySelector('[data-field="invest"]') as HTMLElement
        expect(footer.textContent).toBe('历时 28h12m ｜ 362 步 ｜ 55,591,897 Token')
        expect(card.lastElementChild).toBe(footer)
        expect((card.firstElementChild as HTMLElement).getAttribute('data-field')).toBe('progress')
        expect(card).not.toHaveTextContent('验收一')
        expect(card).not.toHaveTextContent('✅')
        expect(card.querySelector('[data-field="next"]')).toHaveTextContent('随后提交审阅。')
    })

    it('legacy phase metrics collapse into one footer without a visible main dl; wall explanation sits in details', async () => {
        const legacy = task({ progress: '正在执行已记录的步骤。', investment: { phaseMetrics: { usage: { total: 1500 }, duration: { phaseElapsedSeconds: 3660 }, coverage: 'partial' } } })
        fetchMock.mockResolvedValue(ok(snap([legacy])))
        render(<OrchestraBoard />)
        fireEvent.mouseEnter(await screen.findByTestId('ob-tree-node'))
        const card = screen.getByTestId('ob-hovercard')
        expect(card.querySelector('[data-field="legacy-footer"]')!.textContent).toBe('历时 1h1m ｜ 步数未知 ｜ 1,500 Token')
        for (const dl of Array.from(card.querySelectorAll('dl'))) expect(dl.closest('details')).toBeTruthy()
        expect(card.querySelectorAll('details')).toHaveLength(1)
        const wall = taskHoverInfo(task({ investment: { taskUsage: { ...usage, wall: { seconds: 3600, scope: 'task_cumulative' } } } }))
        expect(JSON.stringify(wall.investDetails)).toContain('含空闲/等待审批')
    })
})
