import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { context } = vi.hoisted(() => ({
    context: { token: 'synthetic-token', baseUrl: 'https://hub.example/', api: {} }
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => context }))
import { buildProjectEntries, firstSentence, OrchestraBoard, type OrchestraTask, type OrchestraSnapshot, type ProjectCatalog, type CatalogThread } from './OrchestraBoard'

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

describe('firstSentence', () => {
    it.each([
        ['', ''], ['  \n ', ''], ['结论： ', ''],
        ['没有标点', '没有标点'], ['结论: 已完成。接下来我会交付。', '已完成。'],
        [' 结论：已验证！仍有缺项。', '已验证！'], ['可用？尚未验收。', '可用？'],
        ['模块已交；接入未完成。', '模块已交；接入未完成。'], ['首行\n次行', '首行'], ['首行\r\n次行', '首行'],
        ['Result ready. More detail.', 'Result ready.'], ['Ready! Next.', 'Ready!'],
        ['Ready? Next.', 'Ready?'], ['Ready; Next.', 'Ready; Next.'],
        ['结论: Result ready！Next.', 'Result ready！'],
        ['Latency improved 32.8346%. More detail.', 'Latency improved 32.8346%.']
    ])('extracts %j as %j', (input, expected) => {
        expect(firstSentence(input)).toBe(expected)
    })

    it('truncates the first sentence at 60 Unicode characters and supports a custom limit', () => {
        expect(firstSentence('长'.repeat(61) + '。其余结论。')).toBe('长'.repeat(60) + '…')
        expect(firstSentence('长'.repeat(60))).toBe('长'.repeat(60))
        expect(firstSentence('😀'.repeat(61))).toBe('😀'.repeat(60) + '…')
        expect(firstSentence('abcdef', 3)).toBe('abc…')
    })
})

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

    it('groups every current Task by its catalog project without chat leaves, directions or old history', async () => {
        const tasks = Array.from({ length: 11 }, (_, i) => task({ id: `current-${i}`, title: `Task ${i}` }))
        await show(snapshot([...tasks, task({ id: 'old', archive: 'archived' })], { projectCatalog: catalog({
            taskAssignments: Object.fromEntries(tasks.map((task, i) => [task.id, i < 7 ? a : b])),
            threads: [thread('unrelated-chat')]
        }) }))
        const tree = screen.getByTestId('ob-tree') as HTMLDetailsElement
        expect(tree.open).toBe(false)
        await toggle(tree)
        expect(screen.getAllByTestId('ob-tree-node')).toHaveLength(11)
        expect(screen.getByTestId('ob-tree-root')).toHaveTextContent('总控11 项')
        const projects = within(tree).getAllByTestId('ob-tree-project')
        expect(projects).toHaveLength(2)
        expect(projects.map(project => project.dataset.projectId)).toEqual(['project-a', 'project-b'])
        expect(projects.map(project => within(project).getAllByTestId('ob-tree-node').length)).toEqual([7, 4])
        expect(projects[0].querySelector('.ob-tree-project')).toHaveTextContent('Synthetic project A7 项')
        expect(tree.querySelectorAll('.ob-tree-row')).toHaveLength(0)
        expect(within(tree).queryByText('Direction Alpha')).toBeNull()
        expect(within(tree).queryByText('Synthetic index unrelated-chat')).toBeNull()
        expect(within(tree).getAllByTestId('ob-tree-node').map(node => node.dataset.taskId).sort())
            .toEqual(screen.getAllByTestId('ob-table-row').map(row => row.dataset.taskId).sort())
        expect(tree.querySelector('a')).toBeNull()
        expect(tree.querySelector('[data-task-id="old"]')).toBeNull()
        expect(within(tree).queryByText('Synthetic progress')).not.toBeInTheDocument()
    })

    it('puts unassigned or invalid projects in misc and ignores conversation assignment fallbacks', async () => {
        await show(snapshot([
            task({ id: 'assigned', title: 'Assigned' }), task({ id: 'unassigned', title: 'UrbanClaw DeepSWE' }),
            task({ id: 'invalid-project' }), task({ id: 'invalid-direction' })
        ], { projectCatalog: catalog({ taskAssignments: {
            assigned: a, 'invalid-project': { ...a, projectId: 'missing' }, 'invalid-direction': { ...a, directionId: 'missing' }
        }, assignments: { 'thread-original': b } }) }))
        const groups = screen.getAllByTestId('ob-tree-project')
        expect(groups.map(group => group.dataset.projectId)).toEqual(['project-a', 'misc'])
        expect(within(groups[0]).getAllByTestId('ob-tree-node').map(node => node.dataset.taskId)).toEqual(['assigned', 'invalid-direction'])
        expect(groups[1].querySelector('.ob-tree-project')).toHaveTextContent('杂项2 项')
        expect(within(groups[1]).getAllByTestId('ob-tree-node').map(node => node.dataset.taskId).sort()).toEqual(['invalid-project', 'unassigned'])
    })

    it('folds more than one completed task within each project and shows a lone completion directly', async () => {
        const tasks = [task({ id: 'done-a1', review: 'accepted' }), task({ id: 'done-a2', review: 'accepted' }),
            task({ id: 'active', execution: 'running' }), task({ id: 'done-b', review: 'accepted' })]
        await show(snapshot(tasks, { projectCatalog: catalog({ taskAssignments: {
            'done-a1': a, 'done-a2': a, active: a, 'done-b': b
        } }) }))
        await toggle(screen.getByTestId('ob-tree') as HTMLDetailsElement)
        const fold = screen.getByTestId('ob-tree-completed') as HTMLDetailsElement
        expect(fold.open).toBe(false)
        expect(fold.querySelector('summary')).toHaveTextContent('已完成 2 · 展开')
        const nodes = within(fold).getAllByTestId('ob-tree-node')
        for (const node of nodes) expect(node).not.toBeVisible()
        expect(document.querySelector('[data-testid="ob-tree-node"][data-task-id="done-b"]')).toBeVisible()
        expect(document.querySelector('[data-testid="ob-tree-node"][data-task-id="active"]')).toBeVisible()
        await toggle(fold)
        await waitFor(() => expect(fold.querySelector('summary')).toHaveTextContent('已完成 2 · 收起'))
        for (const node of nodes) expect(node).toBeVisible()
        fireEvent.click(fold.querySelector('summary')!)
        await waitFor(() => expect(fold.querySelector('summary')).toHaveTextContent('已完成 2 · 展开'))
        expect(screen.getAllByTestId('ob-table-row')).toHaveLength(4)
    })

    it('maps only ledger execution/review into five tree states and keeps unknown samples hollow', async () => {
        const cases: [string, Partial<OrchestraTask>, string][] = [
            ['accepted', { execution: 'interrupted', review: 'accepted' }, 'done'],
            ['rejected', { execution: 'running', review: 'rejected' }, 'blocked'],
            ['interrupted', { execution: 'interrupted' }, 'blocked'],
            ['running', { execution: 'running' }, 'running'],
            ['reported-pending', { execution: 'reported', review: 'pending' }, 'running'],
            ['queued', { execution: 'queued', observedAt: null }, 'queued'],
            ['unknown', { execution: 'unknown', progress: '全部完成，已验收', presentation: presentation({ summary: '已经全部完成' }) }, 'unknown'],
            ['reported-awaiting', { execution: 'reported', review: 'awaiting', sessions: [session()] }, 'unknown'],
            ['failed', { execution: 'failed' }, 'unknown'],
            ['blocked', { execution: 'blocked' }, 'unknown'],
            ['stale', { execution: 'running', stale: true }, 'unknown'],
            ['old', { execution: 'running', observedAt: new Date(REFERENCE - 30_001).toISOString() }, 'unknown'],
            ['missing', { execution: 'running', observedAt: null }, 'unknown'],
            ['stale-accepted', { review: 'accepted', stale: true }, 'unknown']
        ]
        await show(snapshot(cases.map(([id, fields]) => task({ id, ...fields }))))
        for (const [id, , status] of cases) {
            const node = document.querySelector(`[data-testid="ob-tree-node"][data-task-id="${id}"]`)!
            expect(node).toHaveAttribute('data-tree-status', status)
            expect(node.querySelector('.ob-tree-dot')).toHaveAttribute('data-tree-status', status)
        }
        const legend = screen.getByLabelText('任务状态图例')
        expect(legend.textContent).toBe('进行中已完成卡住排队未知')
        const segments = document.querySelectorAll('.ob-tree-bar > span')
        expect([...segments].map(segment => Number(segment.getAttribute('data-count'))).reduce((a, b) => a + b, 0)).toBe(cases.length)
        expect([...segments].map(segment => segment.getAttribute('data-tree-status'))).toEqual(['running', 'done', 'blocked', 'queued', 'unknown'])
    })

    it('marks tree states unknown when the snapshot collector is stale without altering queue wording', async () => {
        await show(snapshot([task({ id: 'accepted', review: 'accepted' }), task({ id: 'queued', execution: 'queued' })], { collector: { connected: false, stale: true } }))
        expect(screen.getAllByTestId('ob-tree-node').every(node => node.dataset.treeStatus === 'unknown')).toBe(true)
        expect(queueRow('queued')).toHaveTextContent('排队中')
    })

    it('keeps the existing queue columns, filters and tab state unchanged while opening tree branches', async () => {
        await show(snapshot([task({ id: 'one', review: 'accepted' }), task({ id: 'two', review: 'accepted' }), task({ id: 'queued', execution: 'queued' })]))
        const queue = document.querySelector('.ob-table-section')!
        expect(within(queue as HTMLElement).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['任务', '状态', '正在做什么', '成果'])
        fireEvent.click(within(screen.getByRole('navigation', { name: '任务筛选' })).getByRole('button', { name: /^排队/ }))
        const originalQueue = queue.outerHTML
        await toggle(screen.getByTestId('ob-tree') as HTMLDetailsElement)
        await toggle(screen.getByTestId('ob-tree-completed') as HTMLDetailsElement)
        expect(screen.getAllByTestId('ob-tree-node')).toHaveLength(3)
        expect(queue.outerHTML).toBe(originalQueue)
        expect(screen.getAllByTestId('ob-table-row').map(row => row.dataset.taskId)).toEqual(['queued'])
        fireEvent.click(screen.getByRole('button', { name: /^历史/ }))
        expect(screen.getAllByTestId('ob-tree-node')).toHaveLength(3)
        expect(screen.getByRole('button', { name: /^历史/ })).toHaveAttribute('aria-pressed', 'true')
    })

    it('explains rejected reviews and interrupted executions in the shared task detail', async () => {
        await show(snapshot([task({ id: 'rejected', review: 'rejected' }), task({ id: 'interrupted', execution: 'interrupted' })]))
        await toggle(screen.getByTestId('ob-tree') as HTMLDetailsElement)
        fireEvent.click(document.querySelector('[data-testid="ob-tree-node"][data-task-id="rejected"]')!)
        expect(screen.getByTestId('ob-tree-blocked-reason')).toHaveTextContent('验收被驳回')
        fireEvent.click(within(queueRow('interrupted')).getByRole('button'))
        expect(screen.getByTestId('ob-tree-blocked-reason')).toHaveTextContent('当前无人在做')
    })

    it('shows one read-only archive reminder and counts only explicit pending user decisions', async () => {
        const decision = { decisionId: 'one', taskId: 'one', revision: 1, state: 'pending', waitingOn: 'user',
            decisionRequired: true, test: false, revoked: false }
        await show(snapshot([task({ id: 'one', review: 'accepted' }), task({ id: 'two', review: 'accepted' }),
            task({ id: 'archived', review: 'accepted', archive: 'archived' })], { systemDecisions: {
            version: 1, projection: 'T022-public-safe/v1', safeDisplay: true, decisions: [
                decision, { ...decision }, { ...decision, decisionId: 'two' },
                { ...decision, decisionId: 'controller', waitingOn: 'controller' },
                { ...decision, decisionId: 'authority-only', waitingOn: null, authority: 'user' },
                { ...decision, decisionId: 'decided', state: 'decided' },
                { ...decision, decisionId: 'test', test: true }, { ...decision, decisionId: 'revoked', revoked: true },
                { ...decision, decisionId: 'notification', decisionRequired: false },
                { ...decision, decisionId: 'old' }, { ...decision, decisionId: 'old', revision: 2, state: 'verified' }
            ]
        } }))
        const prompt = screen.getByTestId('ob-needs-you')
        expect(prompt).toHaveTextContent('2 项决策等待你回复；2 项已完成，待你确认归档')
        expect(within(prompt).getAllByText(/待你确认归档/)).toHaveLength(1)
        expect(prompt).toHaveTextContent('在总控对话里回复即可')
        expect(prompt.querySelector('button,a,input')).toBeNull()
        expect(prompt.nextElementSibling).toBe(screen.getByTestId('ob-tree'))
        expect(fetchMock.mock.calls).toHaveLength(1)
        expect(fetchMock.mock.calls[0][1].method).toBe('GET')
    })

    it('hides the needs-you prompt entirely when nothing explicitly needs the user', async () => {
        await show(snapshot([task({ waitingForUser: true, needsUserAction: true, brief: '等待用户确认' })], {
            systemDecisions: { version: 1, projection: 'T022-public-safe/v1', safeDisplay: true, decisions: [{
                decisionId: 'controller', taskId: 'one', revision: 1, state: 'pending', waitingOn: 'controller', decisionRequired: true, test: false, revoked: false
            }] }
        }))
        expect(screen.queryByTestId('ob-needs-you')).toBeNull()
        expect(document.querySelector('.ob-needs-you')).toBeNull()
    })

    it('ignores malformed projections and conflicting decision revisions rather than guessing user decisions', async () => {
        const decision = { decisionId: 'one', taskId: 'one', revision: 1, state: 'pending', waitingOn: 'user',
            decisionRequired: true, test: false, revoked: false }
        await show(snapshot([task()], { systemDecisions: {
            version: 1, projection: 'T022-public-safe/v1', safeDisplay: false, decisions: [decision]
        } }))
        expect(screen.queryByTestId('ob-needs-you')).toBeNull()
        cleanup()
        await show(snapshot([task()], { systemDecisions: {
            version: 1, projection: 'T022-public-safe/v1', safeDisplay: true,
            decisions: [decision, { ...decision, waitingOn: 'controller' }]
        } }))
        expect(screen.queryByTestId('ob-needs-you')).toBeNull()
    })

    it('keeps archive and user-decision reminders independently visible', async () => {
        await show(snapshot([task({ review: 'accepted' })]))
        expect(screen.getByTestId('ob-needs-you')).toHaveTextContent('1 项已完成，待你确认归档')
        expect(screen.getByTestId('ob-needs-you')).not.toHaveTextContent('决策等待')
        cleanup()
        await show(snapshot([task()], { systemDecisions: {
            version: 1, projection: 'T022-public-safe/v1', safeDisplay: true, decisions: [{
                decisionId: 'user', taskId: 'one', revision: 1, state: 'pending', waitingOn: 'user', decisionRequired: true, test: false, revoked: false
            }]
        } }))
        expect(screen.getByTestId('ob-needs-you')).toHaveTextContent('1 项决策等待你回复')
        expect(screen.getByTestId('ob-needs-you')).not.toHaveTextContent('待你确认归档')
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
        expect(record.querySelector(':scope > summary')).toHaveTextContent(/^更多$/)
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
        expect(screen.getByTestId('ob-detail').querySelector('.ob-compact-metrics')).toHaveTextContent(/^耗时与 Token 暂无数据$/)
    })

    it('shows only the first conclusion, metrics, artifacts and one-line actions before More', async () => {
        const summary = '结论：模块已交并通过90项测试；collector接入仍未完成。接下来我会继续交付。'
        await show(snapshot([task({
            id: 'recap', execution: 'interrupted',
            presentation: presentation({ summary, nextStep: '接入collector。补齐Token采集。' }),
            artifacts: [{ index: 0, name: 'Report.md', preparedAt: NOW }]
        })]))
        fireEvent.click(within(queueRow('recap')).getByRole('button', { name: 'Prepared task title' }))
        const detail = screen.getByTestId('ob-detail')
        const more = within(detail).getByTestId('ob-record') as HTMLDetailsElement
        const main = detail.cloneNode(true) as HTMLElement
        main.querySelector('.ob-record')!.remove()
        expect(main.querySelector('.ob-mini-brief')).toHaveTextContent(/^结论：模块已交并通过90项测试；collector接入仍未完成。 · /)
        expect(main).not.toHaveTextContent(/交付目标|覆盖未知|接下来|我会|[（()）]/)
        expect([...main.children].map(node => node.className)).toEqual([
            'ob-detail-head', 'ob-mini-brief', 'ob-compact-metrics', 'ob-task-actions', 'ob-next-step', 'ob-next-step'
        ])
        expect(main.querySelectorAll('.ob-next-step')[0]).toHaveTextContent('卡住原因：当前无人在做')
        expect(main.querySelectorAll('.ob-next-step')[1]).toHaveTextContent('下一步：接入collector。')
        expect(more.open).toBe(false)
        expect(within(more).getByText('交付目标：').parentElement).not.toBeVisible()
        expect(within(more).getByText('完整结论：').parentElement?.textContent).toBe(`完整结论：${summary}`)
        await toggle(more)
        expect(within(more).getByText('完整下一步：').parentElement).toHaveTextContent('补齐Token采集。')
        fetchMock.mockResolvedValue(response({ name: 'Report.md', content: '成果正文\n\n![Result](https://example.test/result.png)' }))
        fireEvent.click(within(detail).getByRole('button', { name: 'Report.md' }))
        await within(detail).findByText('成果正文')
        expect(within(detail).getByRole('img', { name: 'Result' })).toHaveAttribute('src', 'https://example.test/result.png')
        expect(detail.querySelector('.ob-task-actions')?.nextElementSibling).toBe(within(detail).getByTestId('ob-result'))
        expect(within(detail).getByTestId('ob-result').nextElementSibling).toBe(within(detail).getByTestId('ob-tree-blocked-reason'))
    })

    it.each([
        [{ duration: { phaseElapsedSeconds: 65 } }, '耗时 1 分 5 秒 · Token —'],
        [{ usage: { total: 1234 } }, '耗时 — · Token 1234'],
        [{ duration: { phaseElapsedSeconds: 0 }, usage: { input: 0, output: 0 } }, '耗时 0 秒 · Token 0'],
        [{ coverage: 'partial', duration: { phaseElapsedSeconds: 65 }, usage: { total: 1234 } }, '耗时与 Token 暂无数据']
    ] satisfies [NonNullable<OrchestraTask['investment']>['phaseMetrics'], string][])('keeps unknown metrics concise and preserves full coverage explanations (%j)', async (metrics, expected) => {
        await show(snapshot([task({ investment: { phaseMetrics: { coverage: 'complete', ...metrics } } })]))
        fireEvent.click(within(queueRow('task-example')).getByRole('button', { name: 'Synthetic task' }))
        const detail = screen.getByTestId('ob-detail')
        const line = detail.querySelector('.ob-compact-metrics')!
        expect(line.textContent?.trim()).toBe(expected)
        expect(line).not.toHaveTextContent(/[（()）]|未知/)
        expect(line.getAttribute('title')).toMatch(/（.*）/)
        expect(within(detail).getByTestId('ob-record')).toHaveTextContent(line.getAttribute('title')!)
        if (expected === '耗时与 Token 暂无数据') expect(line).toHaveAttribute('data-empty', 'true')
    })

    it('places a small gray snapshot timestamp beside status and leaves More collapsed', async () => {
        await show(snapshot([task({ stale: true, observedAt: '2026-11-03T07:38:00Z' })]))
        fireEvent.click(within(queueRow('task-example')).getByRole('button', { name: 'Synthetic task' }))
        const detail = screen.getByTestId('ob-detail')
        const stale = within(detail).getByRole('status')
        expect(stale.tagName).toBe('SPAN')
        expect(stale).toHaveTextContent(/^上次快照 15:38$/)
        expect(stale.previousElementSibling).toHaveClass('ob-status')
        expect(stale.closest('header')).toBe(detail.querySelector('.ob-detail-head'))
        expect(detail).not.toHaveTextContent('观测数据已过期，以下为上次快照。')
        const css = readFileSync(resolve(__dirname, 'OrchestraBoard.css'), 'utf8')
        expect(css).toMatch(/\.ob-detail-stale \{ color: var\(--ob-muted\); font-size: 10px; white-space: nowrap; \}/)
    })

    it('omits empty and process-only recap lines and retains unabridged text in More', async () => {
        await show(snapshot([task({ id: 'empty', progress: '', brief: '', presentation: presentation({ summary: '', nextStep: '' }) }),
            task({ id: 'process', execution: 'reported', presentation: presentation({ summary: '接下来我会交付结果。', nextStep: '正在核对（覆盖未知）。' }) })]))
        fireEvent.click(within(queueRow('empty')).getByRole('button', { name: 'Prepared task title' }))
        expect(screen.getByTestId('ob-detail').querySelector('.ob-mini-brief')).toBeNull()
        expect(screen.getByTestId('ob-detail').querySelector('.ob-next-step')).toBeNull()
        fireEvent.click(within(queueRow('process')).getByRole('button', { name: 'Prepared task title' }))
        const detail = screen.getByTestId('ob-detail')
        expect(detail.querySelector('.ob-mini-brief')).toBeNull()
        expect(detail.querySelector('.ob-next-step')).toBeNull()
        expect(detail.querySelector('.ob-detail-head')).toHaveTextContent('待核验')
        expect(within(detail).getByTestId('ob-record')).toHaveTextContent('接下来我会交付结果。')
        expect(within(detail).getByTestId('ob-record')).toHaveTextContent('正在核对（覆盖未知）。')
    })

    it('keeps the truncated part of a long first sentence in the full conclusion', async () => {
        const summary = '长'.repeat(65) + '。其余句子完整保留。'
        await show(snapshot([task({ presentation: presentation({ summary }) })]))
        fireEvent.click(within(queueRow('task-example')).getByRole('button', { name: 'Prepared task title' }))
        const detail = screen.getByTestId('ob-detail')
        expect(detail.querySelector('.ob-mini-brief')).toHaveTextContent(`结论：${'长'.repeat(60)}…`)
        expect(detail.querySelector('.ob-full-summary')?.textContent).toBe(`完整结论：${summary}`)
    })

    it('retains every existing technical record field and conversation under More', async () => {
        await show(snapshot([task({
            id: 'all-records', presentation: presentation({ phaseAt: NOW, phaseEvidence: ['Phase proof'] }),
            brief: 'Full briefing', briefAsOf: NOW, progress: 'Full progress', latestAction: 'Latest action',
            checkpoint: 'Checkpoint', evidence: ['Evidence A', 'Evidence B'], ownership: ['Owner A', 'Owner B'], expectedAt: NOW,
            telemetry: { runtimeSeconds: 90, phase: 'running', lastProgressAt: NOW, observedAt: NOW, outputTokens: 10 },
            sessions: [session({ isMain: true, sessionId: 'main', threadId: 'thread-main' }),
                session({ responsibilityStatus: 'ended', telemetry: { runtimeSeconds: 20 } }),
                session({ sessionId: 'unlinked', threadId: null, role: 'Offline worker', execution: 'interrupted' })]
        })]))
        fireEvent.click(within(queueRow('all-records')).getByRole('button', { name: 'Prepared task title' }))
        const more = screen.getByTestId('ob-record') as HTMLDetailsElement
        expect(more.open).toBe(false)
        await toggle(more)
        for (const content of [
            '任务 ID：all-records', '执行 ·', '验收 ·', '归档 ·', '原始目标：Synthetic goal',
            '授权：Synthetic authorization', '检查点：Checkpoint', '计划交付：synthetic-report.md',
            '验收：Synthetic acceptance', '完整简报：Full briefing', '完整进展：Full progress', '最新动作：Latest action',
            '证据：Evidence A；Evidence B', '阶段依据：Phase proof', '阶段观测：', '简报截至：',
            '工作对话与分工', '主关联', '职责已结束', '运行 20 秒', 'Offline worker',
            '预计交付：', '观测：', '来源：synthetic', '所有权：Owner A；Owner B'
        ]) expect(more).toHaveTextContent(content)
        expect(within(more).getByRole('link', { name: '主工作对话' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-main')
        expect(within(more).getByRole('link', { name: '当前交付负责人' })).toHaveAttribute('href', '/desktop?app=codex&thread=thread-owner')
        const telemetry = within(more).getByTestId('ob-detail-telemetry') as HTMLDetailsElement
        await toggle(telemetry)
        expect(telemetry).toHaveTextContent('运行时长：1 分 30 秒')
        expect(telemetry).toHaveTextContent('输出：10 tokens')
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
        expect(css).toContain('.ob-tree-kids')
        expect(css).toContain('::before')
        expect(css).toContain('@media (max-width: 600px)')
        expect(css).toContain('@media (max-width: 560px)')
        expect(css).toContain('.ob-tree-dot[data-tree-status="unknown"] { background: transparent; }')
        expect(css).toContain('prefers-reduced-motion')
    })
})
