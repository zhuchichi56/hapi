import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { context } = vi.hoisted(() => ({ context: { token: 'synthetic-token', baseUrl: 'https://hub.example/', api: {} } }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))
import { OrchestraBoard, clipChars, taskDelivery, taskHoverInfo, whyText, type OrchestraSnapshot, type OrchestraTask } from './OrchestraBoard'

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
        expect(card).toHaveTextContent('目标')
        expect(card).toHaveTextContent('当前结果')
        expect(card).toHaveTextContent('下一步')
        expect(card.querySelectorAll('.ob-muted')).toHaveLength(1)
        expect(card).toHaveTextContent('用量与耗时暂未接入')
        expect(card).not.toHaveTextContent('累计 Token')
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
        await waitFor(() => expect(document.querySelector('.ob-connection')).toHaveTextContent('同步中'))
        expect(screen.getByTestId('ob-tree-node').dataset.treeStatus).toBe('running')
        // A failed poll or stale source is shown by a quiet dot only: no banner, no warning copy.
        expect(document.querySelector('.ob-banner')).toBeNull()
        for (const word of ['连接中断', '数据可能已过期', '状态待更新', '重连']) expect(document.body).not.toHaveTextContent(word)
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

    it('T020 exact public facts (incl. 审批/权限 words): numbers, goal/title and remaining survive; metrics collapse to one muted sentence', async () => {
        const t20 = task({ id: 'T020', execution: 'reported', title: '复盘总控一天的接单与派遣效率',
            goal: '从实际用户请求到派发、承接、交付、验收、历史收尾逐项复盘过去约一天，量化漏派、重复、审批卡住、时延、任务边界和成果可访问性，给出有证据的改进。',
            brief: '一天复盘已完成并通过核验：139条消息中80条为候选用户输入；18组交付到验收记录中位8分1秒、最长7小时1分。已定位验收积压、权限不一致和旧新会话状态冲突；改进尚未实施，完整Token及首token仍缺测。',
            progress: '已交付[完整复盘与证据](/Users/zhuhe/Documents/Codex/2026-11-02/orchestra-daily-retrospective/outputs/交付索引.md)及[合同副本](/Users/zhuhe/Documents/Codex/2026-11-02/orchestra-daily-retrospective/outputs/合同.json)，并同步至合同指定目录。\n\n- 139 条消息：80 条用户候选输入、57 次巡检、2 条协调。\n- 18 组交付→验收：中位 **8分1秒**，最长 **7小时1分**。\n- 重点问题：审批权限、旧新会话状态冲突、验收积压、成果副本陈旧。\n\n复算、哈希和关键证据核验通过。漏派/重复未确认项已单列；Token、首 token 仍缺测。改进建议尚未实施。',
            presentation: { title: '复盘总控接单与派遣效率', delivery: '真实样本、耗时统计与改进建议', summary: '', summaryAt: null, nextStep: '' }, investment: null, telemetry: null })
        const info = taskHoverInfo(t20)
        expect(info.want).toBe('查清总控派工和验收为什么慢')
        expect(info.want).not.toContain('真实样本')
        expect(info.result).toBe('复盘18组交付，交付到验收中位8分1秒、最长7小时1分')
        expect(info.remaining).toBe('改进建议尚未实施')
        expect(info.current).toBe('')
        expect(info.metricsKnown).toBe(false)
        fetchMock.mockResolvedValue(ok(snap([t20])))
        render(<OrchestraBoard />)
        fireEvent.mouseEnter(await screen.findByTestId('ob-tree-node'))
        const card = screen.getByTestId('ob-hovercard')
        expect(card).toHaveTextContent('中位8分1秒、最长7小时1分')
        expect(card).toHaveTextContent('目标查清总控派工和验收为什么慢')
        expect(card.querySelectorAll('dl, dt')).toHaveLength(0)
        expect(card.querySelectorAll('.ob-muted')).toHaveLength(1)
        expect(card).not.toHaveTextContent('未知')
        const known = taskHoverInfo(task({ investment: { phaseMetrics: { duration: { phaseElapsedSeconds: 60 }, usage: { total: 5 }, coverage: 'complete' } } }))
        expect(known.metricsKnown).toBe(true)
        expect(known.tokens).toBe('5（覆盖完整）')
    })

    it('EXT003 curated hover: goal/result/next, no old technical copy, no current-activity paragraph', async () => {
        const ext = task({ id: 'EXT003', execution: 'running', progress: 'PR44 同协议 长任务 硬交接 合同 ACK 技术细节正在推进。', brief: 'PR44同协议长任务硬交接合同ACK。' })
        const info = taskHoverInfo(ext)
        expect(info.want).toBe('让UrbanClaw工作台打开和操作更顺畅，减少偶尔约14秒的等待')
        expect(info.result).toBe('网站访问和证书已恢复，卡顿问题尚未修好')
        expect(info.remaining).toBe('找出等待原因，修复后对比实际耗时')
        expect(info.current).toBe('')
        fetchMock.mockResolvedValue(ok(snap([ext])))
        render(<OrchestraBoard />)
        fireEvent.mouseEnter(await screen.findByTestId('ob-tree-node'))
        const card = screen.getByTestId('ob-hovercard')
        for (const word of ['PR44', '同协议', '硬交接', 'ACK']) expect(card).not.toHaveTextContent(word)
        expect(card.querySelector('[data-field="current"]')).toBeNull()
        expect(card.querySelectorAll('.ob-muted')).toHaveLength(1)
    })

    it('recap card: 交付 and 初衷 come from recorded fields and the whole card stays within 400 characters', async () => {
        expect(taskDelivery(task({ execution: 'reported', review: 'awaiting' }))).toEqual({ label: '已交付，待验收', tone: 'wait' })
        expect(taskDelivery(task({ execution: 'reported', review: 'accepted', archive: 'archived' }))).toEqual({ label: '已通过验收，已归档', tone: 'done' })
        expect(taskDelivery(task({ execution: 'reported', review: 'rejected' })).tone).toBe('stop')
        expect(taskDelivery(task({ execution: 'running' })).label).toBe('进行中，未交付')
        expect(taskDelivery(task({ execution: 'queued' })).label).toBe('排队，未开始')
        expect(taskDelivery(task({ execution: 'blocked' })).label).toBe('受阻，未交付')
        expect(whyText('保留现有流程。先解决总控只在用户发言时才醒，原因是回执最久等了14.5小时。完成标准：可见。')).toBe('解决总控只在用户发言时才醒，原因是回执最久等了14.5小时。')
        expect(whyText('目标一句。第二句没有给出缘由。')).toBe('')
        expect(whyText('先解决X，原因是PR44的commit abc 没合入。')).toBe('')
        expect(clipChars('一二三四五六七八九十', 5)).toBe('一二三四…')
        const long = '很长的描述'.repeat(60)
        const worst = task({ id: 'T77', execution: 'reported', review: 'awaiting', title: '最坏情况任务',
            goal: `${'目标句'.repeat(30)}。先解决某问题，原因是${'原因'.repeat(60)}。`,
            brief: `${long}。尚未完成${long}`, progress: long,
            presentation: { title: '最坏情况任务', delivery: long, summary: long, summaryAt: NOW, nextStep: long } })
        fetchMock.mockResolvedValue(ok(snap([worst])))
        render(<OrchestraBoard />)
        fireEvent.mouseEnter(await screen.findByTestId('ob-tree-node'))
        const card = screen.getByTestId('ob-hovercard')
        for (const field of ['progress', 'delivery', 'goal', 'why', 'next']) expect(card.querySelector(`[data-field="${field}"]`)).not.toBeNull()
        expect(card.querySelector('[data-field="delivery"]')).toHaveTextContent('已交付，待验收')
        expect(card.querySelector('[data-field="why"]')).toHaveTextContent('初衷')
        expect((card.textContent ?? '').length).toBeLessThanOrEqual(400)
    })

    it('shows 未记录 when the goal gives no reason, instead of inventing one', async () => {
        fetchMock.mockResolvedValue(ok(snap([task()])))
        render(<OrchestraBoard />)
        fireEvent.mouseEnter(await screen.findByTestId('ob-tree-node'))
        expect(screen.getByTestId('ob-hovercard').querySelector('[data-field="why"]')).toHaveTextContent('初衷未记录')
    })

    it('watchdog strip: real counts, dash before the first check, tag by mode, never a warning', async () => {
        const watchdog = { mode: 'live', liveTasks: ['T026'], checks: 12, silentAbsorbed: 2, wakes: null, observedWakes: null, lastCheckAt: NOW, enabledAt: NOW }
        fetchMock.mockResolvedValue(ok({ ...snap([task()]), watchdog }))
        render(<OrchestraBoard />)
        const strip = await screen.findByTestId('ob-watchdog')
        expect(strip).toHaveTextContent('巡检 12 次')
        expect(strip).toHaveTextContent('静默处理 2 次')
        expect(strip).toHaveTextContent('叫醒总控 0 次')
        expect(strip).toHaveTextContent('试运行 T026')
        cleanup()
        fetchMock.mockResolvedValue(ok({ ...snap([task()]), watchdog: { mode: 'observe', checks: null, silentAbsorbed: null, wakes: null, lastCheckAt: null } }))
        render(<OrchestraBoard />)
        const empty = await screen.findByTestId('ob-watchdog')
        expect(empty).toHaveTextContent('巡检 — 次')
        expect(empty).toHaveTextContent('静默处理 — 次')
        expect(empty).toHaveTextContent('叫醒总控 — 次')
        expect(empty).toHaveTextContent('观察模式')
        cleanup()
        fetchMock.mockResolvedValue(ok(snap([task()])))
        render(<OrchestraBoard />)
        await screen.findByTestId('ob-tree-node')
        expect(screen.queryByTestId('ob-watchdog')).toBeNull()
    })

    it('lights the scan dot once per real scan and not on unchanged polls', async () => {
        const first = { mode: 'live', checks: 1, lastCheckAt: '2026-11-04T06:00:00Z' }
        fetchMock.mockResolvedValueOnce(ok({ ...snap([task()]), watchdog: first }))
        fetchMock.mockResolvedValue(ok({ ...snap([task()]), watchdog: first }))
        render(<OrchestraBoard />)
        const strip = await screen.findByTestId('ob-watchdog')
        expect(strip.querySelector('.ob-wd-pulse')).not.toHaveAttribute('data-pulse')
        window.dispatchEvent(new Event('orchestra:changed'))
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(screen.getByTestId('ob-watchdog').querySelector('.ob-wd-pulse')).not.toHaveAttribute('data-pulse')
        fetchMock.mockResolvedValue(ok({ ...snap([task()]), watchdog: { ...first, checks: 2, lastCheckAt: '2026-11-04T06:01:00Z' } }))
        window.dispatchEvent(new Event('orchestra:changed'))
        await waitFor(() => expect(screen.getByTestId('ob-watchdog').querySelector('.ob-wd-pulse')).toHaveAttribute('data-pulse', 'true'), { timeout: 3000 })
        expect(screen.getByTestId('ob-watchdog')).toHaveTextContent('巡检 2 次')
    })

    it('does not flash 刷新中 on background polls', async () => {
        fetchMock.mockResolvedValue(ok(snap([task()])))
        render(<OrchestraBoard />)
        await screen.findByTestId('ob-tree-node')
        window.dispatchEvent(new Event('orchestra:changed'))
        expect(screen.queryByText('刷新中…')).toBeNull()
        expect(screen.getByText('刷新')).not.toBeDisabled()
    })

    it('a controller that fails its wake turns shows as a quiet tag plus one 需要你 line, and clears when it responds', async () => {
        const base = { mode: 'live', liveTasks: ['T026'], checks: 5, silentAbsorbed: 0, wakes: 3, wakesFailed: 3, lastCheckAt: NOW }
        fetchMock.mockResolvedValue(ok({ ...snap([task()]), watchdog: { ...base, controller: 'failing' } }))
        render(<OrchestraBoard />)
        expect(await screen.findByTestId('ob-wd-controller')).toHaveTextContent('总控未响应')
        expect(screen.getByTestId('ob-needs-you')).toHaveTextContent('总控对话被叫醒后模型调用失败')
        expect(document.querySelector('.ob-banner')).toBeNull()
        cleanup()
        fetchMock.mockResolvedValue(ok({ ...snap([task()]), watchdog: { ...base, controller: 'responsive' } }))
        render(<OrchestraBoard />)
        await screen.findByTestId('ob-watchdog')
        expect(screen.queryByTestId('ob-wd-controller')).toBeNull()
        expect(screen.queryByTestId('ob-needs-you')).toBeNull()
    })
})
