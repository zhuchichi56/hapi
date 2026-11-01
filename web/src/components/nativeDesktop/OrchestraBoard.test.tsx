import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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

function fieldText(root: HTMLElement, name: string): string {
    const node = root.querySelector(`[data-field="${name}"]`)
    if (!node) throw Error(`telemetry field ${name} missing`)
    return node.textContent ?? ''
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

    it('keeps the current non-main responsibility link through running -> unknown -> reported', async () => {
        const ownerRole = 'ToB在线OSM修复与交付证据负责人；已验证修复，保留其余未完职责，不新增执行'
        const evidenceRole = 'A3B原评测来源及长期状态证据；先只读，不重复派单'
        const task = (ownerExecution: Session['execution']) => makeTask({
            id: 'EXT004',
            title: '当前责任链接',
            threadId: 'thread-main',
            execution: ownerExecution,
            sessions: [
                makeSession({ sessionId: 'main', threadId: 'thread-main', role: 'primary', isMain: true, execution: 'unknown' }),
                makeSession({ sessionId: 'owner', threadId: 'thread-owner', role: ownerRole, execution: ownerExecution }),
                makeSession({ sessionId: 'evidence', threadId: 'thread-evidence', role: evidenceRole, execution: 'reported' })
            ]
        })
        let current = makeSnapshot([task('running')])
        fetchMock.mockImplementation(async () => jsonResponse(current))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        const link = () => within(rowFor('EXT004')).getByRole('link', { name: '工作对话' })
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 1 项')
        expect(link()).toHaveAttribute('href', '/desktop?app=codex&thread=thread-owner')

        const refresh = () => document.dispatchEvent(new Event('visibilitychange'))
        current = makeSnapshot([task('unknown')])
        refresh()
        await waitFor(() => expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 0 项'))
        expect(within(rowFor('EXT004')).getByText('待核实')).toBeInTheDocument()
        expect(link()).toHaveAttribute('href', '/desktop?app=codex&thread=thread-owner')

        current = makeSnapshot([task('reported')])
        refresh()
        await waitFor(() => expect(within(rowFor('EXT004')).getByText('已回报')).toBeInTheDocument())
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 0 项')
        expect(link()).toHaveAttribute('href', '/desktop?app=codex&thread=thread-owner')
    })

    it('moves the primary link to the current main when a non-main responsibility ended', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            id: 'EXT005',
            title: '已结束责任',
            threadId: 'thread-main',
            execution: 'unknown',
            sessions: [
                makeSession({ sessionId: 'main', threadId: 'thread-main', role: 'primary', isMain: true, execution: 'unknown' }),
                makeSession({ sessionId: 'old-owner', threadId: 'thread-ended', role: '旧负责人', execution: 'reported', responsibilityStatus: 'ended' }),
                makeSession({ sessionId: 'evidence', threadId: 'thread-evidence', role: 'A3B原评测来源及长期状态证据；先只读，不重复派单', execution: 'reported' })
            ]
        })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(within(rowFor('EXT005')).getByRole('link', { name: '主工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-main')
        expect(within(rowFor('EXT005')).queryByText('旧负责人')).not.toBeInTheDocument()
        expect(within(rowFor('EXT005')).getByText('另 1 个')).toBeInTheDocument()
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 0 项')
    })

    it('keeps a primary-only task linked to its main conversation', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            id: 'T004',
            title: '只有主会话',
            threadId: 'thread-main-only',
            execution: 'running',
            sessions: [makeSession({ sessionId: 'main', threadId: 'thread-main-only', role: 'primary', isMain: true, execution: 'running' })]
        })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 1 项')
        expect(within(rowFor('T004')).getByText('进行中')).toBeInTheDocument()
        expect(within(rowFor('T004')).getByRole('link', { name: '主工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-main-only')
    })

    it('never makes a source-only/read-only session the primary link', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            id: 'T031',
            title: '只读来源',
            threadId: 'thread-main',
            execution: 'unknown',
            sessions: [
                makeSession({ sessionId: 'main', threadId: 'thread-main', role: 'primary', isMain: true, execution: 'unknown' }),
                makeSession({ sessionId: 'source', threadId: 'thread-source', role: 'A3B原评测来源及长期状态证据；先只读，不重复派单', execution: 'reported' })
            ]
        })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        expect(within(rowFor('T031')).getByRole('link', { name: '主工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-main')
        expect(within(rowFor('T031')).queryByRole('link', { name: '工作对话' })).not.toBeInTheDocument()
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 0 项')
    })

    it('renders task telemetry honestly: zero is a value and null/missing is unknown or uncollected', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({
                id: 'T010', title: '遥测零值', sessions: [makeSession({ threadId: 'thread-010' })],
                telemetry: {
                    runtimeSeconds: 0,
                    phase: 'running',
                    lastProgressAt: NOW,
                    lastProgressBasis: 'native_public_event',
                    waitReason: null,
                    tokenRate: 0,
                    tokenRateWindowSeconds: 30,
                    tokenRateBasis: 'native_generation_window',
                    outputTokens: 0,
                    coarseOutputTokensPerSecond: null,
                    observedAt: NOW,
                    stale: false
                }
            }),
            makeTask({ id: 'T011', title: '遥测空值', sessions: [makeSession({ threadId: 'thread-011' })], telemetry: null }),
            makeTask({ id: 'T012', title: '遥测缺失', sessions: [makeSession({ threadId: 'thread-012' })] })
        ])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')

        const zero = rowFor('T010')
        expect(fieldText(zero, 'runtime')).toBe('运行时长：0 秒')
        expect(fieldText(zero, 'phase')).toBe('阶段：运行中')
        expect(fieldText(zero, 'wait')).toBe('等待：待采集')
        expect(fieldText(zero, 'generation-rate')).toBe('生成速度：0 tok/s（窗口 30 秒）')
        expect(fieldText(zero, 'coarse-rate')).toBe('粗略·含工具等待：未知')
        expect(fieldText(zero, 'output')).toBe('输出：0 tokens')
        expect(fieldText(zero, 'progress')).toContain('原生公开事件')

        for (const id of ['T011', 'T012']) {
            const empty = rowFor(id)
            expect(fieldText(empty, 'runtime')).toBe('运行时长：待采集')
            expect(fieldText(empty, 'phase')).toBe('阶段：未知')
            expect(fieldText(empty, 'wait')).toBe('等待：待采集')
            expect(fieldText(empty, 'generation-rate')).toBe('生成速度：未知')
            expect(fieldText(empty, 'output')).toBe('输出：待采集')
        }
    })

    it('separates native generation rate from coarse wall-clock rate and suppresses stale rates', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([
            makeTask({
                id: 'T020', title: '原生速度', sessions: [makeSession({ threadId: 'thread-020' })],
                telemetry: {
                    runtimeSeconds: 90, phase: 'running', lastProgressAt: NOW, lastProgressBasis: 'native_public_event',
                    tokenRate: 12.5, tokenRateWindowSeconds: 20, tokenRateBasis: 'native_generation_window',
                    coarseOutputTokensPerSecond: 3.5, outputTokens: 250, stale: false
                }
            }),
            makeTask({
                id: 'T021', title: '粗略速度', sessions: [makeSession({ threadId: 'thread-021' })],
                telemetry: {
                    runtimeSeconds: 120, phase: 'tool', lastProgressAt: NOW, lastProgressBasis: 'native_public_event',
                    tokenRate: 8, tokenRateBasis: 'final_usage_wall_clock_coarse',
                    coarseOutputTokensPerSecond: 2, outputTokens: 240, stale: false
                }
            }),
            makeTask({
                id: 'T022', title: '过期速度', sessions: [makeSession({ threadId: 'thread-022' })],
                telemetry: {
                    runtimeSeconds: 60, phase: 'running', lastProgressAt: NOW,
                    tokenRate: 9, tokenRateBasis: 'native_generation_window', stale: true
                }
            }),
            makeTask({
                id: 'T023', title: '无依据速度', sessions: [makeSession({ threadId: 'thread-023' })],
                telemetry: { runtimeSeconds: 10, phase: 'running', tokenRate: 7, tokenRateBasis: null, stale: false }
            })
        ])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')

        expect(fieldText(rowFor('T020'), 'generation-rate')).toBe('生成速度：12.5 tok/s（窗口 20 秒）')
        expect(fieldText(rowFor('T020'), 'coarse-rate')).toBe('粗略·含工具等待：3.5 tok/s')
        expect(fieldText(rowFor('T021'), 'generation-rate')).toBe('生成速度：未知')
        expect(fieldText(rowFor('T021'), 'coarse-rate')).toBe('粗略·含工具等待：2 tok/s')
        expect(fieldText(rowFor('T022'), 'generation-rate')).toBe('生成速度：已过期，待重新采集')
        expect(fieldText(rowFor('T022'), 'coarse-rate')).toBe('粗略·含工具等待：未知')
        expect(rowFor('T022').querySelector('[data-testid="ob-telemetry"]')).toHaveAttribute('data-stale', 'true')
        expect(rowFor('T022')).toHaveTextContent('运行数据（已过期）')
        expect(fieldText(rowFor('T023'), 'generation-rate')).toBe('生成速度：未知')
        expect(rowFor('T023')).not.toHaveTextContent('7 tok/s')
    })

    it('marks collector-stale telemetry as outdated without faking live running', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            id: 'T024', title: '采集器过期', execution: 'running',
            sessions: [makeSession({ threadId: 'thread-024' })],
            telemetry: {
                runtimeSeconds: 60, phase: 'running', lastProgressAt: NOW,
                tokenRate: 20, tokenRateBasis: 'native_generation_window',
                coarseOutputTokensPerSecond: 5, stale: false
            }
        })], { collector: { connected: true, stale: true } })))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        const chip = screen.getByTestId('ob-running-chip')
        expect(chip).toHaveAttribute('data-live', 'false')
        expect(within(rowFor('T024')).getByText('更新中')).toBeInTheDocument()
        const details = rowFor('T024').querySelector('[data-testid="ob-telemetry"]')
        expect(details).toHaveAttribute('data-stale', 'true')
        expect(details).toHaveTextContent('运行数据（已过期）')
        expect(fieldText(rowFor('T024'), 'generation-rate')).toBe('生成速度：已过期，待重新采集')
        expect(rowFor('T024')).not.toHaveTextContent('20 tok/s')
    })

    it('records task and session telemetry in the task detail and keeps the current link', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            id: 'T030', title: '遥测详情', threadId: 'thread-main', execution: 'unknown',
            telemetry: {
                runtimeSeconds: 65, phase: 'waiting_approval', waitReason: 'approval',
                lastProgressAt: NOW, lastProgressBasis: 'native_turn_time',
                tokenRate: 3, tokenRateWindowSeconds: 15, tokenRateBasis: 'native_generation_window',
                coarseOutputTokensPerSecond: null, outputTokens: 45, stale: false
            },
            sessions: [
                makeSession({ sessionId: 'main', threadId: 'thread-main', role: 'primary', isMain: true, execution: 'unknown', telemetry: { runtimeSeconds: 0, phase: 'running' } }),
                makeSession({ sessionId: 'owner', threadId: 'thread-owner', role: '当前排空、测速及基线恢复交接负责人', execution: 'unknown', telemetry: null }),
                makeSession({ sessionId: 'evidence', threadId: 'thread-evidence', role: 'A3B原评测来源及长期状态证据；先只读，不重复派单', execution: 'reported', telemetry: { runtimeSeconds: 5, phase: 'tool', lastProgressAt: NOW, lastProgressBasis: 'observed_state_change' } })
            ]
        })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        fireEvent.click(within(rowFor('T030')).getByRole('button', { name: '遥测详情' }))
        const detail = screen.getByTestId('ob-detail')
        expect(within(detail).getByRole('link', { name: '当前责任对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-owner')
        const taskTelemetry = within(detail).getByTestId('ob-detail-telemetry')
        expect(fieldText(taskTelemetry, 'runtime')).toBe('运行时长：1 分 5 秒')
        expect(fieldText(taskTelemetry, 'phase')).toBe('阶段：等待审批')
        expect(fieldText(taskTelemetry, 'wait')).toBe('等待：审批')
        expect(fieldText(taskTelemetry, 'generation-rate')).toBe('生成速度：3 tok/s（窗口 15 秒）')
        expect(fieldText(taskTelemetry, 'coarse-rate')).toBe('粗略·含工具等待：未知')
        const sessionTelemetry = within(detail).getAllByTestId('ob-session-telemetry')
        expect(sessionTelemetry).toHaveLength(3)
        expect(sessionTelemetry[0]).toHaveTextContent('运行 0 秒')
        expect(sessionTelemetry[0]).toHaveTextContent('阶段 运行中')
        expect(sessionTelemetry[1]).toHaveTextContent('运行数据：待采集')
        expect(sessionTelemetry[2]).toHaveTextContent('运行 5 秒')
        expect(sessionTelemetry[2]).toHaveTextContent('阶段 工具执行中')
        expect(sessionTelemetry[2]).toHaveTextContent('观测状态变化')
    })

    it('keeps the tree/sidebar and five-column table unaffected by telemetry', async () => {
        fetchMock.mockResolvedValue(jsonResponse(makeSnapshot([makeTask({
            id: 'T040', title: '遥测不影响导航', sessions: [makeSession({ threadId: 'thread-040' })],
            telemetry: { runtimeSeconds: 10, phase: 'running', lastProgressAt: NOW, lastProgressBasis: 'native_public_event' }
        })])))
        render(<OrchestraBoard />)
        await screen.findByRole('table')
        const tree = screen.getByTestId('ob-tree')
        expect(within(tree).getAllByTestId('ob-tree-node')).toHaveLength(1)
        expect(within(tree).queryByText(/运行时长/)).not.toBeInTheDocument()
        expect(within(tree).getByText('遥测不影响导航')).toBeInTheDocument()
        expect(within(screen.getByRole('table')).getAllByRole('columnheader')).toHaveLength(5)
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 1 项')
        expect(rowFor('T040').querySelector('[data-testid="ob-telemetry-inline"]')).toHaveTextContent('运行中 · 运行 10 秒')
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

    it('stacks the narrow table with 100% cells, a label column and the fifth action cell', () => {
        const css = readFileSync(resolve(process.cwd(), 'src/components/nativeDesktop/OrchestraBoard.css'), 'utf8')
        const mobile = css.slice(css.lastIndexOf('@media (max-width: 600px)'))
        expect(mobile).toContain('.ob-table {')
        expect(mobile).toContain('min-width: 0;')
        expect(mobile).toContain('grid-template-columns: 70px minmax(0, 1fr);')
        expect(mobile).toContain('width: 100%;')
        expect(mobile).toContain('.ob-table td.ob-cell-task {')
        expect(mobile).toContain('.ob-cell-brief .ob-brief-text')
        expect(mobile).toContain('.ob-artifact-button { justify-self: start; }')
        expect(mobile).toContain('.ob-table td:nth-child(5) { display: grid; }')
        for (const column of [1, 2, 3, 4, 5]) expect(mobile).toContain(`.ob-table td:nth-child(${column})`)
        expect(mobile).not.toContain('min-width: 580px')
        expect(mobile).not.toContain('width: 22%')
        expect(mobile).not.toContain('width: 32%')
        expect(mobile).not.toContain('width: 21%')
        expect(mobile).not.toContain('width: 13%')
        expect(css).toContain('.ob-table th:nth-child(5) { display: table-cell; }')
        // Desktop keeps the table-cell clamp for the brief cell.
        expect(css).toContain('.ob-table td.ob-cell-brief { display: table-cell; overflow: visible; -webkit-line-clamp: unset; }')
    })
})
