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
    await screen.findByRole('table')
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

describe('restored task queue', () => {
    beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }) })
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
    function queueRow(id: string) { const result = screen.getAllByTestId('ob-table-row').find(node => node.dataset.taskId === id); if (!result) throw Error('Missing task row'); return result }

    it('restores the original queue, keeps only current tasks by default, and does not render indexed chats or receipts', async () => {
        await show(snapshot([task({ id: 'current' }), task({ id: 'ended', presentation: presentation({ phaseState: 'ended' }) }), task({ id: 'external', external: true })], {
            notices: ['Internal completed', 'Internal interrupted'], projectCatalog: catalog({ threads: Array.from({ length: 410 }, (_, i) => thread(`history-${i}`)) })
        }))
        expect(screen.getAllByTestId('ob-table-row')).toHaveLength(1)
        expect(queueRow('current')).toBeVisible()
        expect(screen.getByRole('table')).toBeVisible()
        expect(screen.queryByText('Internal completed')).not.toBeInTheDocument()
        expect(screen.queryByText('Synthetic index history-0')).not.toBeInTheDocument()
        expect(document.querySelector('.ob-project-tree,.daily-heatmap,.ob-notices')).toBeNull()
        expect(document.querySelector('[data-testid="ob-tree"]')?.hasAttribute('open')).toBe(false)
        expect(screen.queryByRole('link', { name: /工作对话|责任对话/ })).not.toBeInTheDocument()
    })

    it('shows every current Task as a short connected node, without chat leaves or old history', async () => {
        const tasks = Array.from({ length: 11 }, (_, i) => task({ id: `current-${i}`, title: `Task ${i}` }))
        await show(snapshot([...tasks, task({ id: 'old', archive: 'archived' })]))
        const tree = screen.getByTestId('ob-tree') as HTMLDetailsElement
        fireEvent.click(tree.querySelector('summary')!)
        expect(screen.getAllByTestId('ob-tree-node')).toHaveLength(11)
        expect(tree.querySelector('.ob-tree-root')).not.toBeNull()
        expect(tree.querySelectorAll('.ob-tree-row')).toHaveLength(6)
        expect(tree.querySelector('a')).toBeNull()
        expect(tree.querySelector('[data-task-id="old"]')).toBeNull()
        expect(within(tree).queryByText('Synthetic progress')).not.toBeInTheDocument()
    })

    it('opens the same compact task detail from a tree node and keeps original chat links secondary', async () => {
        await show(snapshot([task({ id: 'one', title: 'One Task', sessions: [session()] })]))
        const tree = screen.getByTestId('ob-tree') as HTMLDetailsElement
        fireEvent.click(tree.querySelector('summary')!)
        const node = screen.getByTestId('ob-tree-node'); fireEvent.click(node)
        const detail = screen.getByTestId('ob-detail')
        expect(within(detail).getByRole('heading', { name: 'One Task' })).toBeVisible()
        const record = within(detail).getByTestId('ob-record') as HTMLDetailsElement
        expect(record.open).toBe(false)
        fireEvent.click(record.querySelector('summary')!)
        expect(within(detail).getByRole('link', { name: '当前责任对话' }).getAttribute('href')).toBe('/desktop?app=codex&thread=thread-owner')
        fireEvent.click(within(detail).getByRole('button', { name: '关闭任务详情' }))
        expect(screen.queryByTestId('ob-detail')).toBeNull()
        expect(document.activeElement).toBe(node)
    })

    it('keeps task history in the existing History tab without adding it to the current tree', async () => {
        await show(snapshot([task({ id: 'current', title: 'Current Task' }), task({ id: 'old', title: 'Old Task', presentation: presentation({ title: 'Old Task', phaseState: 'ended' }) })]))
        fireEvent.click(screen.getByRole('button', { name: /^历史/ }))
        expect(queueRow('old')).toBeVisible()
        expect(document.querySelector('[data-testid="ob-table-row"][data-task-id="current"]')).toBeNull()
        expect(document.querySelector('[data-testid="ob-tree-node"][data-task-id="old"]')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: /^当前/ }))
        expect(queueRow('current')).toBeVisible()
    })

    it('uses only prepared artifact indexes, reads the result in task details and omits unavailable buttons', async () => {
        await show(snapshot([task({ id: 'ready', title: 'Prepared Task', artifacts: [{ index: 3, name: 'Reviewed result', preparedAt: NOW }] }), task({ id: 'empty', title: 'No result' })]))
        expect(within(queueRow('empty')).queryByRole('button', { name: '查看成果' })).toBeNull()
        fetchMock.mockResolvedValue(response({ name: 'Reviewed result', content: 'Verified result body' }))
        fireEvent.click(within(queueRow('ready')).getByRole('button', { name: '查看成果' }))
        await screen.findByText('Verified result body')
        expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('https://hub.example/api/orchestra/artifact?task=ready&index=3')
        expect(fetchMock.mock.calls.at(-1)?.[1].headers.authorization).toBe('Bearer synthetic-token')
    })

    it('does not call stage acceptance whole-goal completion and retains an unfinished interrupted task', async () => {
        await show(snapshot([task({ id: 'stage', review: 'accepted', execution: 'reported', artifacts: [{ index: 0, name: 'Stage result', preparedAt: NOW }] }), task({ id: 'unfinished', execution: 'interrupted' })]))
        expect(queueRow('stage').querySelector('[data-tone="done"]')).toBeNull()
        expect(queueRow('unfinished')).toBeVisible()
        expect(within(queueRow('unfinished')).getByText('已中断')).toBeVisible()
    })

    it('keeps actual input wait yellow and never fabricates investment or healthy running from stale reads', async () => {
        await show(snapshot([task({ id: 'wait', execution: 'blocked', presentation: presentation({ waitingOn: 'Confirm endpoint' }) })], { collector: { connected: false, stale: true } }))
        expect(screen.getByTestId('ob-running-chip')).toHaveTextContent('运行中 — 项')
        expect(queueRow('wait').querySelector('[data-tone="waiting"]')).not.toBeNull()
        fireEvent.click(within(queueRow('wait')).getByRole('button', { name: 'Prepared task title' }))
        expect(screen.getByTestId('ob-detail')).toHaveTextContent('Token 未知')
    })

    it('retains the authenticated refresh and updates task state without adding an index view', async () => {
        await show(snapshot([task({ id: 'one', title: 'Original Task' })]))
        fetchMock.mockResolvedValue(response(snapshot([task({ id: 'one', title: 'Updated Task' })])))
        fireEvent.click(screen.getByRole('button', { name: /^刷新$/ }))
        await screen.findByRole('button', { name: 'Updated Task' })
        expect(fetchMock.mock.calls.at(-1)?.[1].headers.authorization).toBe('Bearer synthetic-token')
        expect(screen.getAllByRole('table')).toHaveLength(1)
    })

    it('restores baseline queue CSS and real connector styles with a wrapping mobile layout', () => {
        const css = readFileSync(resolve(__dirname, 'OrchestraBoard.css'), 'utf8')
        expect(css).toContain('.ob-table-wrap')
        expect(css).toContain('.ob-tree-branches')
        expect(css).toContain('::before')
        expect(css).toContain('@media (max-width: 600px)')
        expect(css).toContain('prefers-reduced-motion')
    })
})
