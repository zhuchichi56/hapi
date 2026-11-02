import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { context } = vi.hoisted(() => ({
    context: { token: 'synthetic-token', baseUrl: 'https://hub.example/', api: {} }
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))
import { buildProjectEntries, OrchestraBoard, type OrchestraTask, type OrchestraSnapshot, type ProjectCatalog, type CatalogThread } from './OrchestraBoard'

type Session = NonNullable<OrchestraTask['sessions']>[number]
type Presentation = NonNullable<OrchestraTask['presentation']>
function presentation(overrides: Partial<Presentation> = {}): Presentation {
    return { title: 'Prepared task title', delivery: 'Deliver the reviewed interface', summary: 'The interface is ready for review.', summaryAt: NOW, nextStep: '', ...overrides }
}
const NOW = new Date().toISOString()
const REFERENCE = Date.parse(NOW)
const fetchMock = vi.fn()

function session(overrides: Partial<Session> = {}): Session {
    return { sessionId: 'session-owner', threadId: 'thread-owner', role: '当前交付负责人', execution: 'running',
        review: 'pending', responsibilityStatus: 'active', isMain: false, observedAt: NOW, ...overrides }
}
function task(overrides: Partial<OrchestraTask> = {}): OrchestraTask {
    return { id: 'task-example', title: 'Synthetic task', goal: 'Synthetic goal', deliverables: ['synthetic-report.md'],
        acceptance: ['Synthetic acceptance'], ownership: [], authorization: 'Synthetic authorization', threadId: 'thread-original',
        host: 'synthetic', createdAt: NOW, checkpoint: '', expectedAt: null, execution: 'unknown', review: 'pending', archive: 'none',
        observedAt: NOW, sourceAt: NOW, progress: 'Synthetic progress', latestAction: '', evidence: [], stale: false,
        attention: false, external: false, ...overrides }
}
function thread(id: string, overrides: Partial<CatalogThread> = {}): CatalogThread {
    return { id, title: `Synthetic index ${id}`, updatedAt: NOW, archived: false, source: 'synthetic-index', ...overrides }
}
function catalog(overrides: Partial<ProjectCatalog> = {}): ProjectCatalog {
    return { version: 1, asOf: NOW, coverage: { indexed: 0, emitted: 0, truncated: false },
        projects: [
            { id: 'project-a', name: 'Synthetic project A', directions: [{ id: 'alpha', name: 'Direction Alpha' }] },
            { id: 'project-b', name: 'Synthetic project B', directions: [{ id: 'beta', name: 'Direction Beta' }] },
            { id: 'learning-from-deployment', name: 'Learning from Deployment', directions: [{ id: 'general', name: 'General' }] },
            { id: 'deepswe', name: 'DeepSWE', directions: [{ id: 'evaluation', name: 'Evaluation' }] }
        ], assignments: {}, taskAssignments: {}, threads: [], ...overrides }
}
const a = { projectId: 'project-a', directionId: 'alpha', evidence: 'Synthetic explicit assignment A' }
const b = { projectId: 'project-b', directionId: 'beta', evidence: 'Synthetic explicit assignment B' }
function snapshot(tasks: OrchestraTask[], overrides: Partial<OrchestraSnapshot> = {}): OrchestraSnapshot {
    return { version: 1, generatedAt: NOW, controllerThreadId: 'thread-controller', collector: { connected: true, stale: false }, tasks, ...overrides }
}
function response(data: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => data } as Response
}
async function show(value: OrchestraSnapshot) {
    fetchMock.mockResolvedValue(response(value))
    render(<OrchestraBoard />)
    await screen.findByRole('searchbox')
}
function rows() { return screen.queryAllByTestId('ob-task-row') }
function row(id = 'task-example') {
    const found = rows().find(element => element.dataset.taskId === id)
    if (!found) throw Error(`Missing synthetic row ${id}`)
    return found
}
function branch(label: string, root: HTMLElement = screen.getByTestId('ob-tree')): HTMLDetailsElement {
    const found = Array.from(root.querySelectorAll('details')).find(element => element.querySelector(':scope > summary')?.textContent?.startsWith(label))
    if (!found) throw Error(`Missing branch ${label}`)
    return found
}
async function toggle(element: HTMLDetailsElement) {
    fireEvent.click(element.querySelector(':scope > summary')!)
    await waitFor(() => expect(element.open).toBe(true))
}

describe('explicit project model', () => {
    it('uses explicit task mapping before original thread, main session and linked owner mappings', () => {
        const item = task({ sessions: [session({ isMain: true, threadId: 'thread-main' }), session()] })
        const input = catalog({ taskAssignments: { 'task-example': a }, assignments: { 'thread-original': b, 'thread-main': b, 'thread-owner': b } })
        expect(buildProjectEntries([item], input, REFERENCE)[0]).toMatchObject({ projectId: 'project-a', directionId: 'alpha' })
        delete input.taskAssignments['task-example']
        expect(buildProjectEntries([item], input, REFERENCE)[0].projectId).toBe('project-b')
        input.assignments['thread-main'] = a
        expect(buildProjectEntries([item], input, REFERENCE)[0].projectId).toBe('project-b')
        delete input.assignments['thread-original']
        expect(buildProjectEntries([item], input, REFERENCE)[0].projectId).toBe('project-a')
    })

    it('keeps unknown and invalid metadata in misc without title classification', () => {
        const items = [task({ title: 'DeepSWE Learning from Deployment UrbanClaw' })]
        expect(buildProjectEntries(items, catalog(), REFERENCE)[0].projectId).toBe('misc')
        expect(buildProjectEntries(items, catalog({ taskAssignments: { 'task-example': { ...a, directionId: 'invalid' } } }), REFERENCE)[0].projectId).toBe('misc')
        expect(buildProjectEntries(items, undefined, REFERENCE)[0].projectId).toBe('misc')
    })

    it('keeps Learning from Deployment and DeepSWE separate even when titles suggest the other project', () => {
        const entries = buildProjectEntries([
            task({ id: 'task-learning', title: 'Synthetic DeepSWE title' }),
            task({ id: 'task-eval', title: 'Synthetic Learning from Deployment title' })
        ], catalog({ taskAssignments: {
            'task-learning': { projectId: 'learning-from-deployment', directionId: 'general', evidence: 'Synthetic explicit mapping' },
            'task-eval': { projectId: 'deepswe', directionId: 'evaluation', evidence: 'Synthetic explicit mapping' }
        } }), REFERENCE)
        expect(entries.map(entry => entry.projectId)).toEqual(['learning-from-deployment', 'deepswe'])
    })

    it('dedupes task IDs and every original, owner, ended, source and session identity from the index', () => {
        const item = task({ sessions: [session(), session({ sessionId: 'session-ended', threadId: 'thread-ended', responsibilityStatus: 'ended' }),
            session({ sessionId: 'session-source', threadId: 'thread-source', role: '只读来源' }), session({ sessionId: 'session-native', threadId: null })] })
        const entries = buildProjectEntries([item, item], catalog({ threads: [
            ...['thread-original', 'thread-owner', 'thread-ended', 'thread-source', 'session-native', 'session-owner'].map(id => thread(id)),
            thread('thread-index-only'), thread('thread-index-only')
        ] }), REFERENCE)
        expect(entries).toHaveLength(2)
        expect(entries.filter(entry => entry.thread).map(entry => entry.thread!.id)).toEqual(['thread-index-only'])
    })

    it('keeps indexed native archive separate from ledger completion and supports project-only metadata', () => {
        const entries = buildProjectEntries([], catalog({ threads: [thread('thread-archived', { archived: true, projectId: 'project-a' }), thread('thread-idle')] }), REFERENCE)
        expect(entries[0]).toMatchObject({ projectId: 'project-a', directionId: null, historical: true })
        expect(entries[0].task).toBeUndefined()
        expect(entries[1]).toMatchObject({ projectId: 'misc', historical: false })
    })
})

describe('project tree board', () => {
    beforeEach(() => {
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    })
    afterEach(() => {
        cleanup()
        vi.useRealTimers()
        vi.unstubAllGlobals()
        delete (document as unknown as { visibilityState?: string }).visibilityState
    })

    it('shows all matched projects and more than eight entries, with one tree and no duplicate flat table', async () => {
        const tasks = Array.from({ length: 10 }, (_, i) => task({ id: `task-${i}`, title: `Synthetic task ${i}`, threadId: `thread-${i}` }))
        await show(snapshot(tasks, { projectCatalog: catalog({ taskAssignments: Object.fromEntries(tasks.map((item, i) => [item.id, i % 2 ? a : b])) }) }))
        expect(rows()).toHaveLength(10)
        expect(screen.getByText('Synthetic project A')).toBeInTheDocument()
        expect(screen.getByText('Synthetic project B')).toBeInTheDocument()
        expect(screen.queryByText('Learning from Deployment')).not.toBeInTheDocument()
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
        expect(screen.queryByText('当前未完成工作 · 历史另存')).not.toBeInTheDocument()
    })

    it('renders persistent nested directions and current conversation leaves with folded former owners', async () => {
        const old = session({ sessionId: 'old', threadId: 'thread-old', isMain: true, execution: 'interrupted', nativeArchived: true })
        const current = session({ sessionId: 'replacement', threadId: 'thread-replacement', isMain: false })
        const item = task({ threadId: 'thread-old', execution: 'interrupted', sessions: [old, current] })
        const groups = catalog({ projects: [{ id: 'project-a', name: 'Project', directions: [
            { id: 'root', name: 'Statistics' }, { id: 'nested', name: 'Phase metrics', parentId: 'root' }
        ] }], taskAssignments: { 'task-example': { projectId: 'project-a', directionId: 'nested', evidence: 'Explicit synthetic hierarchy' } },
        threads: [thread('thread-old', { archived: true })] })
        await show(snapshot([item], { projectCatalog: groups }))
        expect(branch('Statistics').contains(branch('Phase metrics'))).toBe(true)
        const leaves = row().querySelector('.ob-task-sessions')!
        const owner = within(leaves as HTMLElement).getByRole('link', { name: '当前负责对话' })
        expect(owner).toHaveAttribute('href', '/desktop?app=codex&thread=thread-replacement')
        expect(within(row()).getByText('进行中')).toBeVisible()
        const history = branch('已结束对话', row())
        expect(history.open).toBe(false)
        expect(row().querySelector('[data-session-thread="thread-old"]')).not.toBeInTheDocument()
        await toggle(history)
        expect(within(history).getByText('已归档')).toBeVisible()
        expect(within(history).getByRole('link', { name: '原主对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-old')
    })

    it('does not end a task when its replacement owner finishes one round after an interrupted original', async () => {
        const item = task({ execution: 'interrupted', threadId: 'original-archived', sessions: [
            session({ isMain: true, threadId: 'original-archived', execution: 'interrupted', nativeArchived: true }),
            session({ sessionId: 'replacement', threadId: 'replacement-round', execution: 'reported', isMain: false })
        ] })
        const index = catalog({ threads: [thread('original-archived', { archived: true })] })
        expect(buildProjectEntries([item], index, REFERENCE)[0].historical).toBe(false)
        await show(snapshot([item], { projectCatalog: index }))
        expect(within(row()).getByText('交付待核对')).toBeVisible()
        expect(within(row()).getByText('本轮结束')).toBeVisible()
        expect(within(row()).queryByText('已完成')).not.toBeInTheDocument()
        expect(within(row()).getByRole('link', { name: '当前负责对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=replacement-round')
    })

    it('does not mount completed leaves until opened and searches hidden project and misc history', async () => {
        await show(snapshot([
            task({ id: 'active', title: 'Synthetic current', deliverables: [] }),
            task({ id: 'done-project', title: 'Needle project history', review: 'accepted', execution: 'reported', archive: 'archived' }),
            task({ id: 'done-misc', title: 'Needle misc history', review: 'accepted', execution: 'reported' })
        ], { projectCatalog: catalog({ taskAssignments: { active: a, 'done-project': a } }) }))
        expect(rows().map(item => item.dataset.taskId)).toEqual(['active'])
        expect(branch('已结束与归档').open).toBe(false)
        expect(branch('历史').open).toBe(false)
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Needle' } })
        expect(await screen.findByRole('button', { name: 'Needle project history' })).toBeVisible()
        expect(screen.getByRole('button', { name: 'Needle misc history' })).toBeVisible()
        expect(rows()).toHaveLength(2)
        expect(screen.queryByRole('button', { name: 'Synthetic current' })).not.toBeInTheDocument()
    })

    it('omits collapsed project leaves from the DOM and permits native summary focus', async () => {
        await show(snapshot([task()], { projectCatalog: catalog({ taskAssignments: { 'task-example': a } }) }))
        const project = branch('Synthetic project A')
        const summary = project.querySelector(':scope > summary') as HTMLElement
        summary.focus()
        expect(summary).toHaveFocus()
        fireEvent.click(summary)
        await waitFor(() => expect(rows()).toHaveLength(0))
        expect(project.open).toBe(false)
        await toggle(project)
        await waitFor(() => expect(rows()).toHaveLength(1))
    })

    it('allows collapsing a search match and reveals its path again for a new query', async () => {
        await show(snapshot([task({ review: 'accepted', title: 'Synthetic hidden match' })], { projectCatalog: catalog({ taskAssignments: { 'task-example': a } }) }))
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hidden' } })
        expect(await screen.findByRole('button', { name: 'Synthetic hidden match' })).toBeVisible()
        fireEvent.click(branch('Synthetic project A').querySelector(':scope > summary')!)
        await waitFor(() => expect(rows()).toHaveLength(0))
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'match' } })
        expect(await screen.findByRole('button', { name: 'Synthetic hidden match' })).toBeVisible()
    })

    it('renders index unknown state and original links without fabricating tasks or completion', async () => {
        await show(snapshot([], { projectCatalog: catalog({ threads: [thread('thread-idle', { title: 'Synthetic idle entry' }),
            thread('thread-native', { title: 'Synthetic native archive', archived: true })] }) }))
        expect(rows()).toHaveLength(0)
        await toggle(branch('杂项'))
        await toggle(branch('未分类'))
        await toggle(branch('相关对话'))
        const indexed = screen.getByTestId('ob-index-row')
        expect(within(indexed).getByText('索引 · 状态未知')).toBeInTheDocument()
        expect(within(indexed).getByRole('link', { name: '原对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-idle')
        await toggle(branch('历史'))
        await screen.findByText('原生已归档')
        expect(screen.getAllByText('索引 · 状态未知')).toHaveLength(2)
        expect(screen.queryByText('已完成')).not.toBeInTheDocument()
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 0 项')
    })

    it('retains the current responsibility link while original thread metadata determines grouping', async () => {
        await show(snapshot([task({ sessions: [session({ sessionId: 'main', threadId: 'thread-original', isMain: true, execution: 'unknown' }), session()] })],
            { projectCatalog: catalog({ assignments: { 'thread-original': a, 'thread-owner': b }, threads: [thread('thread-original'), thread('thread-owner')] }) }))
        expect(rows()).toHaveLength(1)
        expect(screen.queryAllByTestId('ob-index-row')).toHaveLength(0)
        expect(branch('Synthetic project A')).toContainElement(row())
        expect(within(row()).getByText('进行中')).toBeInTheDocument()
        expect(within(row()).getByRole('link', { name: '工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-owner')
    })

    it.each(['unknown', 'reported'] as const)('keeps explicit responsibility through running -> %s without inventing running', async execution => {
        await show(snapshot([task({ sessions: [session({ execution }), session({ sessionId: 'main', threadId: 'thread-original', isMain: true, execution: 'unknown' })] })]))
        expect(within(row()).getByRole('link', { name: '工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-owner')
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 0 项')
        expect(within(row()).queryByText('进行中')).not.toBeInTheDocument()
    })

    it('keeps accepted work current when fresh linked responsibility resumes it', async () => {
        await show(snapshot([task({ review: 'accepted', execution: 'reported', sessions: [session()] })], { projectCatalog: catalog({ taskAssignments: { 'task-example': a } }) }))
        expect(within(row()).getByText('进行中')).toBeInTheDocument()
        expect(screen.queryByText('已结束与归档')).not.toBeInTheDocument()
    })

    it('retains native archive and review state in details without proving acceptance', async () => {
        await show(snapshot([task({ archive: 'archived', execution: 'unknown', review: 'pending', title: 'Synthetic archived unreviewed task' })]))
        expect(rows()).toHaveLength(0)
        await toggle(branch('历史'))
        const trigger = await screen.findByRole('button', { name: 'Synthetic archived unreviewed task' })
        expect(within(row()).getByText('已归档')).toBeInTheDocument()
        expect(within(row()).queryByText('已完成')).not.toBeInTheDocument()
        fireEvent.click(trigger)
        fireEvent.click(within(screen.getByTestId('ob-detail')).getByText('技术记录'))
        expect(screen.getByTestId('ob-detail').querySelector('[data-field="native-status"]')).toHaveTextContent('执行 · 未知；验收 · 未开始验收；归档 · 已归档')
    })

    it('preserves collector stale meaning without exposing lifetime telemetry as investment', async () => {
        await show(snapshot([task({ attention: true, stale: true, sessions: [session()], telemetry: { runtimeSeconds: 30, phase: 'running', tokenRate: 42, tokenRateBasis: 'native_generation_window' } })],
            { collector: { connected: true, stale: true } }))
        expect(screen.getByTestId('ob-running-chip')).toHaveAttribute('data-live', 'false')
        expect(within(row()).getAllByText('状态暂不可用').length).toBeGreaterThan(0)
        expect(within(row()).queryByText('等待你决定')).not.toBeInTheDocument()
        expect(within(row()).getByText('已过期')).toBeInTheDocument()
        expect(within(row()).queryByText('进行中')).not.toBeInTheDocument()
        expect(screen.queryByTestId('ob-telemetry-inline')).not.toBeInTheDocument()
        expect(within(row()).getByText('未采集')).toBeInTheDocument()
        expect(screen.queryByText('42 tok/s')).not.toBeInTheDocument()
    })

    it('filters running work and resets filtering when searching across all history', async () => {
        await show(snapshot([task({ id: 'live', sessions: [session()] }), task({ id: 'waiting', title: 'Synthetic waiting', review: 'awaiting', execution: 'reported' }),
            task({ id: 'done', title: 'Searchable old entry', review: 'accepted', execution: 'reported' })]))
        fireEvent.click(screen.getByTestId('ob-running-chip'))
        expect(rows().map(item => item.dataset.taskId)).toEqual(['live'])
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Searchable' } })
        expect(await screen.findByRole('button', { name: 'Searchable old entry' })).toBeVisible()
        expect(rows()).toHaveLength(1)
    })

    it('opens accessible details and safe artifact preview, then returns focus to the trigger', async () => {
        fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.includes('/artifact')
            ? { name: 'synthetic-report.md', content: '# Synthetic result\n\n[Unsafe](file:///synthetic.txt)\n\n[Safe](https://example.com)' }
            : snapshot([task({ sessions: [session()], artifacts: [{ index: 4, name: 'synthetic-report.md', preparedAt: NOW }] })]))))
        render(<OrchestraBoard />)
        await screen.findByRole('searchbox')
        const trigger = within(row()).getByRole('button', { name: 'Synthetic task' })
        fireEvent.click(trigger)
        const detail = screen.getByTestId('ob-detail')
        expect(detail).toHaveFocus()
        expect(screen.getByTestId('ob-record')).not.toHaveAttribute('open')
        fireEvent.click(within(detail).getByText('技术记录'))
        expect(within(detail).getByRole('link', { name: '当前责任对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-owner')
        fireEvent.click(within(detail).getByRole('button', { name: 'synthetic-report.md' }))
        await screen.findByText('Synthetic result')
        expect(screen.queryByRole('link', { name: 'Unsafe' })).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Safe' })).toHaveAttribute('href', 'https://example.com')
        fireEvent.click(within(detail).getByRole('button', { name: '关闭任务详情' }))
        expect(trigger).toHaveFocus()
        expect(screen.queryByTestId('ob-detail')).not.toBeInTheDocument()
    })

    it('keeps external history folded, searchable and distinct from managed running work', async () => {
        await show(snapshot([task({ id: 'external', title: 'Synthetic external archive', external: true, execution: 'running', sessions: [session()] })]))
        expect(rows()).toHaveLength(0)
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'external archive' } })
        expect(await screen.findByText('历史快照 · 未接管')).toBeVisible()
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 0 项')
    })

    it('shows catalog error while preserving original tasks and shows explicit truncation coverage', async () => {
        await show(snapshot([task()], { projectCatalogError: 'catalog_unavailable_or_invalid',
            projectCatalog: catalog({ coverage: { indexed: 250, emitted: 180, truncated: true } }) }))
        expect(row()).toBeInTheDocument()
        expect(screen.getByRole('alert')).toHaveTextContent('项目目录读取失败')
        expect(screen.getByText('目录覆盖 180/250 对话')).toBeInTheDocument()
    })

    it('searches collapsed indexed summaries and metadata across all 250 entries', async () => {
        const threads = Array.from({ length: 250 }, (_, i) => thread(`thread-${i}`, { archived: true, summary: i === 249 ? 'Synthetic hidden needle' : 'Synthetic summary' }))
        await show(snapshot([], { projectCatalog: catalog({ threads }) }))
        expect(screen.queryAllByTestId('ob-index-row')).toHaveLength(0)
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hidden needle' } })
        expect(await screen.findByRole('link', { name: 'Synthetic index thread-249' })).toBeVisible()
        expect(screen.getAllByTestId('ob-index-row')).toHaveLength(1)
    })

    it('gates results on prepared artifacts and passes each exact index, including zero', async () => {
        fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.includes('/artifact')
            ? { name: 'prepared.md', content: '# Prepared result' }
            : snapshot([task({ artifacts: [{ index: 7, name: 'Review report', preparedAt: NOW }, { index: 0, name: 'Overview', preparedAt: NOW }] }),
                task({ id: 'planned', title: 'Planned only', deliverables: ['planned.md'], artifacts: [] }),
                task({ id: 'invalid', title: 'Not prepared', artifacts: [{ index: 3, name: '', preparedAt: NOW }, { index: 2, name: 'Missing time', preparedAt: '' }] })]))))
        render(<OrchestraBoard />)
        await screen.findByRole('searchbox')
        expect(within(row('planned')).getByText('尚未交付')).toBeInTheDocument()
        expect(within(row('planned')).getAllByRole('button')).toHaveLength(1)
        expect(within(row('invalid')).getByText('尚未交付')).toBeInTheDocument()
        fireEvent.click(within(row()).getByRole('button', { name: 'Review report' }))
        await screen.findByText('Prepared result')
        expect(fetchMock.mock.calls.some(([url]) => new URL(url).searchParams.get('index') === '7')).toBe(true)
        fireEvent.click(within(screen.getByTestId('ob-detail')).getByRole('button', { name: 'Overview' }))
        await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => new URL(url).searchParams.get('index') === '0')).toBe(true))
    })

    it('keeps the default detail compact, uses presentation in search, and folds technical prose', async () => {
        await show(snapshot([task({ presentation: presentation({ nextStep: 'Review the layout.' }),
            progress: 'Long technical progress', checkpoint: 'Internal checkpoint', authorization: 'Internal authorization',
            telemetry: { runtimeSeconds: 9999, outputTokens: 12345 } })]))
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reviewed interface' } })
        expect(rows()).toHaveLength(1)
        fireEvent.click(within(row()).getByRole('button', { name: 'Prepared task title' }))
        const detail = screen.getByTestId('ob-detail')
        expect(within(detail).getByText('Deliver the reviewed interface')).toBeVisible()
        expect(within(detail).getByText('The interface is ready for review.')).toBeVisible()
        expect(within(detail).getByText('Review the layout.')).toBeVisible()
        expect(within(detail).getByText(/耗时 未采集/)).toBeVisible()
        expect(within(detail).queryByRole('button', { name: 'synthetic-report.md' })).not.toBeInTheDocument()
        expect(within(detail).getByText('Internal authorization', { exact: false })).not.toBeVisible()
        expect(within(detail).getByText('Internal checkpoint', { exact: false })).not.toBeVisible()
        expect(within(detail).getByText('Long technical progress', { exact: false })).not.toBeVisible()
        expect(screen.getByTestId('ob-record')).not.toHaveAttribute('open')
        fireEvent.keyDown(detail, { key: 'Escape' })
        expect(screen.queryByTestId('ob-detail')).not.toBeInTheDocument()
        expect(within(row()).getByRole('button', { name: 'Prepared task title' })).toHaveFocus()
    })

    it('uses public fallback prose while retaining authorization only in technical records', async () => {
        await show(snapshot([task({ brief: '授权：内部审批要求\n已完成界面布局。', briefAsOf: NOW, goal: '交付可用的任务看板' })]))
        expect(within(row()).getByText('已完成界面布局。')).toBeVisible()
        expect(within(row()).queryByText(/内部审批/)).not.toBeInTheDocument()
        expect(within(row()).getByText('交付可用的任务看板')).toBeVisible()
        expect(within(row()).getByText(/观测/)).toBeVisible()
    })

    it('keeps blocked reported/rejected work current, ends phases in history, and lets fresh owners resume', async () => {
        const blocked = task({ id: 'blocked', execution: 'reported', review: 'rejected', presentation: presentation({ title: 'Blocked task', phaseState: 'blocked' }) })
        const ended = task({ id: 'ended', execution: 'unknown', presentation: presentation({ title: 'Closed task', phaseState: 'ended', phaseEvidence: '用户已明确关闭此阶段。', summary: 'The delivery target remains unmet.' }) })
        const resumed = task({ id: 'resumed', execution: 'reported', review: 'accepted', sessions: [session()], presentation: presentation({ title: 'Resumed task', phaseState: 'ended' }) })
        const staleOwner = task({ id: 'stale-owner', execution: 'reported', sessions: [session({ observedAt: new Date(REFERENCE - 31000).toISOString() })], presentation: presentation({ title: 'Stale ended task', phaseState: 'ended' }) })
        expect(buildProjectEntries([blocked, ended, resumed, staleOwner], catalog(), REFERENCE).map(entry => entry.historical)).toEqual([false, true, false, true])
        await show(snapshot([blocked, ended, resumed, staleOwner, task({ id: 'queued', execution: 'queued', title: 'Queued task' })]))
        expect(rows().map(item => item.dataset.taskId)).toEqual(['resumed', 'queued', 'blocked'])
        expect(within(row('blocked')).getByText('受阻')).toBeVisible()
        expect(within(row('blocked')).queryByText('等待你决定')).not.toBeInTheDocument()
        expect(within(row('resumed')).getByText('进行中')).toBeVisible()
        await toggle(branch('历史'))
        expect(within(row('ended')).getByText('已取消')).toBeVisible()
        expect(within(row('ended')).getByText('The delivery target remains unmet.')).toBeVisible()
        expect(within(row('stale-owner')).queryByText('进行中')).not.toBeInTheDocument()
    })

    it.each([
        ['accepted', 'reported', '已完成'], ['rejected', 'reported', '未达标'], ['pending', 'failed', '未达标'], ['pending', 'interrupted', '已取消']
    ] as const)('renders historical %s/%s as %s', async (review, execution, label) => {
        await show(snapshot([task({ review, execution })]))
        await toggle(branch('历史'))
        expect(within(row()).getByText(label)).toBeVisible()
    })

    it('requires explicit user-action flags and never infers attention from review or prose', async () => {
        await show(snapshot([task({ execution: 'blocked', review: 'awaiting', progress: '等待用户确认授权。' }),
            task({ id: 'explicit', title: 'Explicit decision', execution: 'blocked', needsUserAction: true })]))
        expect(within(row()).queryByText('等待你决定')).not.toBeInTheDocument()
        expect(within(row('explicit')).getByText('等待你决定')).toBeVisible()
        expect(row()).not.toHaveAttribute('data-attention')
        expect(row('explicit')).toHaveAttribute('data-attention', 'true')
    })

    it('does not duplicate running rows and prioritizes running project and direction paths', async () => {
        await show(snapshot([task({ id: 'idle', title: 'Idle task' }), task({ id: 'live', title: 'Live task', sessions: [session()] })],
            { projectCatalog: catalog({ taskAssignments: { idle: a, live: b } }) }))
        expect(rows().map(item => item.dataset.taskId)).toEqual(['live', 'idle'])
        expect(screen.getAllByRole('button', { name: 'Live task' })).toHaveLength(1)
        expect(screen.queryByRole('region', { name: '进行中' })).not.toBeInTheDocument()
    })

    it('keeps 2s visible polling, visibility/focus/change refresh, and busy manual refresh', async () => {
        vi.useFakeTimers()
        let visibility = 'visible'
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
        fetchMock.mockResolvedValue(response(snapshot([task()])))
        await act(async () => { render(<OrchestraBoard />) })
        expect(screen.getByRole('searchbox')).toBeInTheDocument()
        const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
        const count = fetchMock.mock.calls.length
        await advance(2000)
        expect(fetchMock).toHaveBeenCalledTimes(count + 1)
        visibility = 'hidden'
        await advance(4000)
        fireEvent(window, new Event('focus'))
        fireEvent(window, new Event('orchestra:changed'))
        expect(fetchMock).toHaveBeenCalledTimes(count + 1)
        visibility = 'visible'
        fireEvent(document, new Event('visibilitychange'))
        await advance(0)
        expect(fetchMock).toHaveBeenCalledTimes(count + 2)
        fireEvent(window, new Event('focus'))
        await advance(0)
        fireEvent(window, new Event('orchestra:changed'))
        await advance(0)
        expect(fetchMock).toHaveBeenCalledTimes(count + 4)
        let resolveRefresh!: (value: Response) => void
        fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveRefresh = resolve }))
        fireEvent.click(screen.getByRole('button', { name: '刷新' }))
        expect(screen.getByRole('button', { name: '刷新中…' })).toBeDisabled()
        expect(screen.getByRole('button', { name: '刷新中…' })).toHaveAttribute('aria-busy', 'true')
        await act(async () => { resolveRefresh(response(snapshot([task({ brief: 'Updated public observation' })]))) })
        expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
        expect(within(row()).getByText('Updated public observation')).toBeVisible()
    })

    it('ships wrapping mobile rows and reduced-motion styles without fixed-width tables', () => {
        const css = readFileSync(resolve(__dirname, 'OrchestraBoard.css'), 'utf8')
        expect(css).toContain('@media (max-width: 600px)')
        expect(css).toContain('min-width: 0')
        expect(css).toContain('overflow-wrap: anywhere')
        expect(css).toContain('flex-wrap: wrap')
        expect(css).toContain('prefers-reduced-motion: reduce')
        expect(css).not.toMatch(/min-width:\s*(?:580|660)px/)
        // Geometry at 390px still requires the source app/browser checks.
    })
})
