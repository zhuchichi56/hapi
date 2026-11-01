import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const { context } = vi.hoisted(() => ({
    context: { token: 'PRIVATE_TOKEN', baseUrl: 'https://hub.example/', api: {} }
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))

import { publicProgress, OrchestraBoard, type OrchestraSnapshot, type OrchestraTask } from './OrchestraBoard'

type Session = NonNullable<OrchestraTask['sessions']>[number]

const NOW = new Date().toISOString()

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        sessionId: 'session-1',
        threadId: 'thread-running',
        role: '当前交付负责人',
        execution: 'running',
        review: 'pending',
        responsibilityStatus: 'active',
        isMain: false,
        observedAt: NOW,
        ...overrides
    }
}

function makeTask(overrides: Partial<OrchestraTask> = {}): OrchestraTask {
    return {
        id: 'T003',
        title: '首用体验报告',
        goal: '让新用户首用就知道下一步。',
        deliverables: ['首用体验报告.md'],
        acceptance: ['线上首用体验偏邀测，案例引导缺失'],
        ownership: ['web/src/components/nativeDesktop/OrchestraBoard.tsx'],
        authorization: '2026-11-02 用户授权只读展示',
        threadId: 'thread-main',
        host: 'local',
        createdAt: '2026-11-01T16:00:00.000Z',
        checkpoint: '报告已产出',
        expectedAt: '2026-11-02T02:15:00.000+08:00',
        execution: 'unknown',
        review: 'pending',
        archive: 'none',
        observedAt: NOW,
        sourceAt: NOW,
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
        generatedAt: NOW,
        controllerThreadId: 'thread-main',
        collector: { connected: true, stale: false, lastSuccessAt: NOW },
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

function rows(): HTMLElement[] {
    return screen.queryAllByTestId('ob-table-row')
}

function rowFor(taskId: string): HTMLElement {
    const row = rows().find(item => item.dataset.taskId === taskId)
    if (!row) throw Error(`row ${taskId} missing`)
    return row
}

function resetVisibility() {
    delete (document as unknown as { visibilityState?: string }).visibilityState
}

describe('OrchestraBoard compact current/history board', () => {
    beforeEach(() => {
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    })
    afterEach(() => {
        cleanup()
        vi.useRealTimers()
        vi.unstubAllGlobals()
        resetVisibility()
    })

    it('renders the compact five-column table by default and dedupes three sessions to one task', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            threadId: 'thread-main',
            sessions: [
                makeSession({ sessionId: 'main', threadId: 'thread-main', isMain: true, execution: 'unknown', role: 'primary' }),
                makeSession({ sessionId: 'owner', threadId: 'thread-owner', role: '当前排空、测速及基线恢复交接负责人' }),
                makeSession({ sessionId: 'evidence', threadId: 'thread-evidence', role: 'A3B原评测来源及长期状态证据；先只读，不重复派单' })
            ]
        })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')

        const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map(item => item.textContent)
        expect(headers).toEqual(['任务', '状态', '正在做什么', '工作对话', '成果'])
        expect(rows()).toHaveLength(1)
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 1 项')
        expect(screen.getByTestId('ob-running-chip')).toHaveAttribute('data-live', 'true')
        expect(within(rowFor('T003')).getByText('进行中')).toBeInTheDocument()
        expect(within(rowFor('T003')).getByRole('link', { name: '工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-owner')
        expect(within(rowFor('T003')).getByText('另 2 个')).toBeInTheDocument()
    })

    it('lets a fresh responsible linked running session override an old unknown main', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            execution: 'unknown',
            threadId: 'thread-main',
            sessions: [
                makeSession({ sessionId: 'main', threadId: 'thread-main', execution: 'unknown', isMain: true, role: 'primary' }),
                makeSession({ sessionId: 'linked', threadId: 'thread-linked', execution: 'running' })
            ]
        })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 1 项')
        expect(within(rowFor('T003')).getByText('进行中')).toBeInTheDocument()
        expect(within(rowFor('T003')).getByRole('link', { name: '工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-linked')
    })

    it('does not treat active responsibility or a completed turn as running work', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({
                id: 'T020', title: '等待验收任务', execution: 'reported', review: 'awaiting',
                sessions: [makeSession({ threadId: 'thread-reported', execution: 'reported', responsibilityStatus: 'active', review: 'awaiting' })]
            }),
            makeTask({
                id: 'T021', title: '活跃但未执行', execution: 'reported', review: 'pending',
                sessions: [makeSession({ threadId: 'thread-idle', execution: 'reported', responsibilityStatus: 'active' })]
            })
        ])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 0 项')
        expect(screen.queryByText('进行中')).not.toBeInTheDocument()
        expect(within(rowFor('T020')).getByText('待验收')).toBeInTheDocument()
    })

    it('subdues running status when the collector is stale instead of showing fake green live work', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            execution: 'running',
            sessions: [makeSession({ threadId: 'thread-running' })]
        })], { collector: { connected: true, stale: true } })))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        const chip = screen.getByTestId('ob-running-chip')
        expect(chip).toHaveTextContent('运行中 1 项')
        expect(chip).toHaveTextContent('状态待更新')
        expect(chip).toHaveAttribute('data-live', 'false')
        expect(within(rowFor('T003')).getByText('更新中')).toBeInTheDocument()
        expect(within(rowFor('T003')).queryByText('进行中')).not.toBeInTheDocument()
        expect(rowFor('T003').querySelector('.ob-status-dot')).toBeNull()
    })

    it('keeps current unfinished work separate from accepted/archived history, external snapshots and review-only sessions', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({ id: 'T003', title: '当前工作', sessions: [makeSession({ threadId: 'thread-current' })] }),
            makeTask({ id: 'T901', title: '退回任务', execution: 'reported', review: 'rejected', attention: true }),
            makeTask({
                id: 'TQ1', title: '仅验收会话', execution: 'running',
                sessions: [makeSession({ sessionId: 'qa', threadId: 'thread-qa', role: 'qa' })]
            }),
            makeTask({ id: 'T900', title: '已验收归档', execution: 'reported', review: 'accepted', archive: 'archived', threadId: 'thread-old' }),
            makeTask({ id: 'H001', title: '历史导入任务', external: true, stale: true, execution: 'unknown' })
        ])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')

        expect(rowFor('T003')).toBeInTheDocument()
        expect(rowFor('T901')).toBeInTheDocument()
        expect(within(rowFor('T901')).getByText('需处理')).toBeInTheDocument()
        expect(rowFor('TQ1')).toBeInTheDocument()
        expect(within(rowFor('TQ1')).queryByText('进行中')).not.toBeInTheDocument()
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 1 项')
        expect(rows().some(item => item.dataset.taskId === 'T900')).toBe(false)
        expect(rows().some(item => item.dataset.taskId === 'H001')).toBe(false)

        fireEvent.click(screen.getByRole('button', { name: /历史/ }))
        expect(rowFor('T900')).toBeInTheDocument()
        expect(rows().some(item => item.dataset.taskId === 'T003')).toBe(false)
        expect(rows().some(item => item.dataset.taskId === 'H001')).toBe(false)
    })

    it('filters the table from the clickable running count and restores all current work', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({ id: 'T003', title: '运行任务', sessions: [makeSession({ threadId: 'thread-running' })] }),
            makeTask({ id: 'T004', title: '排队任务', execution: 'queued' })
        ])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(rows()).toHaveLength(2)

        const chip = screen.getByTestId('ob-running-chip')
        fireEvent.click(chip)
        expect(chip).toHaveAttribute('aria-pressed', 'true')
        expect(rows().map(item => item.dataset.taskId)).toEqual(['T003'])
        fireEvent.click(chip)
        expect(chip).toHaveAttribute('aria-pressed', 'false')
        expect(rows()).toHaveLength(2)
    })

    it('keeps task detail and artifact reading available from the table', async () => {
        fetchMock.mockImplementation(async (url: string) => String(url).includes('/api/orchestra/artifact')
            ? jsonResponse({ name: '报告.md', content: '# 报告\n\n[线上报告](https://example.test/report)\n\n[本地记录](docs/report.md)' })
            : jsonResponse(makeSnapshot([makeTask({ sessions: [makeSession({ threadId: 'thread-running' })] })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        fireEvent.click(within(rowFor('T003')).getByRole('button', { name: '首用体验报告' }))
        const detail = screen.getByTestId('ob-detail')
        expect(within(detail).getByText('进行中')).toBeInTheDocument()
        fireEvent.click(within(rowFor('T003')).getByRole('button', { name: '查看成果' }))
        expect(await within(detail).findByText('线上报告')).toBeInTheDocument()
        expect(within(detail).getByRole('link', { name: '线上报告' })).toHaveAttribute('href', 'https://example.test/report')
        expect(within(detail).getByText('本地记录')).toHaveAttribute('title', '附件请从原工作对话查看')
        const call = fetchMock.mock.calls.find(([value]) => String(value).includes('/api/orchestra/artifact')) as [string, RequestInit]
        expect(call[0]).toBe('https://hub.example/api/orchestra/artifact?task=T003&index=0')
    })

    it('keeps an accepted old main current and blue when a fresh linked responsibility is running', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            id: 'T012', title: '验收后继续工作', review: 'accepted', execution: 'reported', threadId: 'thread-main',
            sessions: [
                makeSession({ sessionId: 'main', threadId: 'thread-main', isMain: true, execution: 'reported', review: 'accepted', role: 'primary' }),
                makeSession({ sessionId: 'resumed', threadId: 'thread-resumed', execution: 'running', role: '当前排空、测速及基线恢复交接负责人' })
            ]
        })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(rowFor('T012')).toBeInTheDocument()
        expect(within(rowFor('T012')).getByText('进行中')).toBeInTheDocument()
        expect(within(rowFor('T012')).queryByText('已完成')).not.toBeInTheDocument()
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 1 项')
        expect(within(rowFor('T012')).getByRole('link', { name: '工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-resumed')

        fireEvent.click(screen.getByRole('button', { name: /历史/ }))
        expect(rows().some(item => item.dataset.taskId === 'T012')).toBe(false)
    })

    it('dedupes duplicate task IDs before counting and rendering', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({ id: 'T003', title: '重复任务旧行', sessions: [makeSession({ sessionId: 'one', threadId: 'thread-one' })] }),
            makeTask({ id: 'T003', title: '重复任务新行', sessions: [makeSession({ sessionId: 'two', threadId: 'thread-two' })] })
        ])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(rows()).toHaveLength(1)
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 1 项')
        expect(within(rowFor('T003')).getByText('进行中')).toBeInTheDocument()
    })

    it('excludes QA-prefixed tasks from running even with synthetic running execution', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            id: 'QA008-1', title: '验收测试：看板状态', execution: 'running',
            sessions: [makeSession({ sessionId: 'qa-008', threadId: 'thread-qa-008', execution: 'running', role: '验收执行' })]
        })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 0 项')
        expect(within(rowFor('QA008-1')).queryByText('进行中')).not.toBeInTheDocument()
        expect(within(rowFor('QA008-1')).queryByText('更新中')).not.toBeInTheDocument()
    })

    it('uses yellow only for explicit wait-user evidence; other waiting states stay neutral', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({ id: 'T020', title: '待验收但无用户动作', execution: 'reported', review: 'awaiting' }),
            makeTask({ id: 'T021', title: '明确等待用户验收', execution: 'reported', review: 'awaiting', progress: '等待用户确认验收结果。' }),
            makeTask({ id: 'T022', title: '普通阻塞', execution: 'blocked' }),
            makeTask({ id: 'T023', title: '等待负责人处理', execution: 'blocked', progress: '等待负责人处理权限阻塞。' })
        ])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(within(rowFor('T020')).getByText('待验收')).toHaveAttribute('data-tone', 'pending')
        expect(within(rowFor('T021')).getByText('待验收')).toHaveAttribute('data-tone', 'waiting')
        expect(within(rowFor('T022')).getByText('需处理')).toHaveAttribute('data-tone', 'pending')
        expect(within(rowFor('T023')).getByText('需处理')).toHaveAttribute('data-tone', 'attention')
    })

    it('ships a narrow light-glass table, blue breathing running dot and reduced-motion fallback', () => {
        const css = readFileSync(resolve(process.cwd(), 'src/components/nativeDesktop/OrchestraBoard.css'), 'utf8')
        expect(css).toContain('max-width: 780px')
        expect(css).toContain('.ob-table {')
        expect(css).toContain('.ob-running-chip')
        expect(css).toContain('@keyframes ob-breathe')
        expect(css).toContain('opacity: .28')
        expect(css).toContain('@media (prefers-reduced-motion: reduce)')
        expect(css).toContain('.ob-live-dot, .ob-status-dot { animation: none; opacity: .8; }')
        expect(css).toContain('-webkit-line-clamp: 2')
        expect(publicProgress('mtime 2026-11-02\n已完成体验报告。').summary).toBe('已完成体验报告。')
    })
})
