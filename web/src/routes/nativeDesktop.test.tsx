import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const { command, api } = vi.hoisted(() => {
    const command = vi.fn()
    return { command, api: { nativeDesktopCommand: command } }
})
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api }) }))
const routing = vi.hoisted(() => ({ search: { app: 'codex' as 'codex' | 'claude', thread: undefined as string | undefined }, listeners: new Set<() => void>() }))
vi.mock('@tanstack/react-router', async () => {
    const React = await import('react')
    return {
        Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
        useSearch: () => React.useSyncExternalStore(listener => { routing.listeners.add(listener); return () => { routing.listeners.delete(listener) } }, () => routing.search),
        useNavigate: () => (options: { search: typeof routing.search }) => { routing.search = options.search; routing.listeners.forEach(listener => listener()); return Promise.resolve() },
    }
})
vi.mock('@/components/nativeDesktop/attachments', () => ({ prepareImage: async (file: File) => ({ name: file.name, data: 'data:image/png;base64,aW1hZ2U=' }) }))
vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }))
import NativeDesktopPage from './nativeDesktop'
import { parseNativeSearch } from '@/components/nativeDesktop/navigation'
const view = {
    id: 'original', title: 'Original desktop chat', status: 'idle', live: true, historyComplete: true,
    hasEarlier: true, before: 'cursor', revision: 'one', windowStart: 80, requests: [],
    turns: [{ id: 'native-turn', status: 'completed', items: [
        { id: 'ask', key: 'ask-key', role: 'user', text: 'Question' },
        { id: 'tool', key: 'tool-key', role: 'tool', text: 'Bash tool', hasDetail: true },
        { id: 'reply', key: 'reply-key', role: 'assistant', text: 'Readable reply' }
    ] }]
}
let nativeArchived = false, nativePinned = false
describe('desktop reading experience', () => {
    beforeEach(() => {
        routing.search = { app: 'codex', thread: undefined }
        localStorage.removeItem('hapi-native-pins-v1')
        localStorage.removeItem('hapi-native-archives-v1')
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
        nativeArchived = false; nativePinned = false
        sessionStorage.clear()
        command.mockReset()
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: (value.archived ? nativeArchived : !nativeArchived) ? [{ id: 'original', title: 'Original desktop chat', status: 'idle', archived: !!value.archived, pinned: nativePinned }] : [] }
            : value.op === 'pin' ? (nativePinned = !!value.pinned, { id: value.id, pinned: value.pinned, native: true })
            : value.op === 'archive' ? (nativeArchived = !!value.archived, { id: value.id, archived: value.archived, native: true })
            : value.itemKey ? { item: { id: 'tool', key: 'tool-key', role: 'tool', text: 'Bash tool', output: 'Detailed original output' } }
            : value.before ? { ...view, revision: 'older', hasEarlier: false, before: 'older-cursor', turns: [{ id: 'earlier-native-turn', status: 'completed', items: [{ id: 'early', key: 'early-key', role: 'assistant', text: 'Earlier original message' }] }] }
            : value.since ? { id: 'original', revision: 'one', unchanged: true }
            : view
        }))
    })
    afterEach(cleanup)
    it('shows the last native lists immediately when switching Apps while refresh is slow', async () => {
        let stalled = false
        command.mockImplementation(async value => {
            if (value.op === 'list') {
                if (stalled) return new Promise(() => {})
                return { ok: true, result: { threads: [{ id: `${value.app}-cached`, title: `${value.app} cached original`, status: 'idle' }] } }
            }
            return { ok: true, result: view }
        })
        render(<NativeDesktopPage />)
        await screen.findByRole('button', { name: /^codex cached original/ })
        await waitFor(() => expect(command.mock.calls.some(([value]) => value.op === 'list' && value.app === 'claude')).toBe(true))
        stalled = true
        fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
        expect(screen.getByRole('button', { name: /^claude cached original/ })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
        expect(screen.getByRole('button', { name: /^codex cached original/ })).toBeInTheDocument()
        expect(command.mock.calls.some(([value]) => ['send', 'create', 'pin', 'archive'].includes(value.op))).toBe(false)
    })
    it('shows the conversation without downloading tool output and fetches details only on expansion', async () => {
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Original desktop chat/ }))
        await screen.findByText('Readable reply')
        expect(screen.queryByText('Detailed original output')).toBeNull()
        expect(command.mock.calls.some(([value]) => value.itemKey)).toBe(false)
        expect(screen.queryByText('Bash tool')).toBeNull()
        const group = screen.getByText('工具记录').closest('details')!
        group.open = true
        fireEvent(group, new Event('toggle'))
        expect(command.mock.calls.some(([value]) => value.itemKey)).toBe(false)
        const details = screen.getByText('Bash tool').closest('details')!
        details.open = true
        fireEvent(details, new Event('toggle'))
        await screen.findByText('Detailed original output')
        expect(command.mock.calls.some(([value]) => value.id === 'original' && value.itemKey === 'tool-key')).toBe(true)
    })
    it('adds older messages while retaining the current original reply', async () => {
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Original desktop chat/ }))
        fireEvent.click(await screen.findByRole('button', { name: /更早的消息/ }))
        await screen.findByText('Earlier original message')
        expect(screen.getByText('Readable reply')).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByRole('button', { name: /更早的消息/ })).toBeNull())
    })
    it('groups adjacent Claude call/result records across native message boundaries and retains prose', async () => {
        const claudeView = { ...view, hasEarlier: false, turns: [
            { id: 'native-question', status: 'completed', items: [{ id: 'question', key: 'claude-q', role: 'user', text: 'Original Claude question' }] },
            { id: 'call-message', status: 'completed', items: [{ id: 'call', key: 'claude-call', role: 'tool', text: 'Bash' }] },
            { id: 'result-message', status: 'completed', items: [{ id: 'result', key: 'claude-result', role: 'tool', text: '工具结果' }] },
            { id: 'second-call-message', status: 'completed', items: [{ id: 'call2', key: 'claude-call2', role: 'tool', text: 'Read' }] },
            { id: 'second-result-message', status: 'completed', items: [{ id: 'result2', key: 'claude-result2', role: 'tool', text: '工具结果' }] },
            { id: 'native-reply', status: 'completed', items: [{ id: 'reply', key: 'claude-reply', role: 'assistant', text: 'Original Claude reply' }] },
            { id: 'after-reply-call', status: 'completed', items: [{ id: 'call3', key: 'claude-call3', role: 'tool', text: 'Write' }] },
        ] }
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'original-claude', title: 'Original Claude chat', status: 'idle' }] }
            : value.itemKey ? { item: { id: 'call', key: 'claude-call', role: 'tool', text: 'Bash', output: 'Original Claude tool output' } }
            : value.since ? { id: 'original-claude', revision: 'one', unchanged: true } : claudeView
        }))
        render(<NativeDesktopPage />)
        fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
        fireEvent.click(await screen.findByRole('button', { name: /^Original Claude chat/ }))
        await screen.findByText('Original Claude reply')
        const groups = [...document.querySelectorAll<HTMLDetailsElement>('.nd-activity')]
        expect(groups).toHaveLength(2)
        expect(groups[0].open).toBe(false)
        expect(groups[0].querySelector('.nd-count')).toHaveTextContent('4')
        expect(screen.getByText('Original Claude question')).toBeInTheDocument()
        expect(screen.queryByText('Bash')).toBeNull()
        expect(command.mock.calls.some(([value]) => value.itemKey)).toBe(false)
        groups[0].open = true
        fireEvent(groups[0], new Event('toggle'))
        const tool = screen.getByText('Bash').closest('details')!
        expect(command.mock.calls.some(([value]) => value.itemKey)).toBe(false)
        tool.open = true
        fireEvent(tool, new Event('toggle'))
        await screen.findByText('Original Claude tool output')
        expect(command.mock.calls.some(([value]) => value.app === 'claude' && value.id === 'original-claude' && value.itemKey === 'claude-call')).toBe(true)
        groups[0].open = false
        fireEvent(groups[0], new Event('toggle'))
        groups[0].open = true
        fireEvent(groups[0], new Event('toggle'))
        expect(screen.getByText('Original Claude tool output')).toBeInTheDocument()
        expect(screen.getByText('Original Claude reply')).toBeInTheDocument()
    })
    it('pins and unpins the original App conversation across browser remounts', async () => {
        let entries = [{ id: 'original', title: 'Original desktop chat', status: 'idle', pinned: false }, { id: 'later', title: 'Later desktop chat', status: 'idle', pinned: false }]
        command.mockImplementation(async value => {
            if (value.op === 'pin') {
                entries = entries.map(entry => entry.id === value.id ? { ...entry, pinned: value.pinned } : entry)
                return { ok: true, result: { id: value.id, pinned: value.pinned, native: true } }
            }
            return { ok: true, result: { threads: entries } }
        })
        const page = render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Later desktop chat' }))
        fireEvent.click(await screen.findByRole('button', { name: '置顶：Later desktop chat' }))
        await screen.findByText('已同步置顶到桌面 App')
        expect([...document.querySelectorAll('.nd-thread-title')].map(el => el.textContent)).toEqual(['Later desktop chat', 'Original desktop chat'])
        expect(localStorage.getItem('hapi-native-pins-v1')).toBeNull()
        page.unmount()
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Later desktop chat' }))
        fireEvent.click(await screen.findByRole('button', { name: '取消置顶：Later desktop chat' }))
        await screen.findByText('已在桌面 App 取消置顶')
        expect(command.mock.calls.filter(([value]) => value.op === 'pin').map(([value]) => value.pinned)).toEqual([true, false])
    })
    it('keeps native pin state when the original App rejects the operation', async () => {
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => value.op === 'pin' ? { ok: false, error: 'Native pin failed' } : original(value))
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Original desktop chat' }))
        fireEvent.click(await screen.findByRole('button', { name: '置顶：Original desktop chat' }))
        await screen.findByText('Native pin failed')
        fireEvent.click(screen.getByRole('button', { name: '更多操作：Original desktop chat' }))
        expect(await screen.findByRole('button', { name: '置顶：Original desktop chat' })).toBeInTheDocument()
        expect(localStorage.getItem('hapi-native-pins-v1')).toBeNull()
    })
    it('restores a compact composer after clearing a long draft', async () => {
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Original desktop chat/ }))
        const input = await screen.findByRole('textbox', { name: '消息' }) as HTMLTextAreaElement
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 300 })
        fireEvent.change(input, { target: { value: 'A long draft' } })
        expect(input.style.height).toBe('180px')
        fireEvent.change(input, { target: { value: '' } })
        expect(input.style.height).toBe('auto')
    })
    it('archives and restores the original App conversation across browser remounts', async () => {
        const page = render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Original desktop chat' }))
        fireEvent.click(await screen.findByRole('button', { name: '归档会话' }))
        await screen.findByText('已同步归档到桌面 App')
        expect(document.querySelectorAll('.nd-thread')).toHaveLength(0)
        expect(localStorage.getItem('hapi-native-archives-v1')).toBeNull()
        page.unmount()
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /已归档/ }))
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Original desktop chat' }))
        fireEvent.click(await screen.findByRole('button', { name: '恢复到最近' }))
        await screen.findByText('已在桌面 App 恢复会话')
        fireEvent.click(screen.getByRole('button', { name: /返回最近/ }))
        await screen.findByRole('button', { name: /^Original desktop chat/ })
        expect(command.mock.calls.filter(([value]) => value.op === 'archive').map(([value]) => value.archived)).toEqual([true, false])
    })
    it('keeps the conversation visible when native archive fails', async () => {
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => value.op === 'archive' ? { ok: false, error: 'Native archive failed' } : original(value))
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Original desktop chat' }))
        fireEvent.click(await screen.findByRole('button', { name: '归档会话' }))
        await screen.findByText('Native archive failed')
        expect(screen.getByRole('button', { name: /^Original desktop chat/ })).toBeInTheDocument()
        expect(localStorage.getItem('hapi-native-archives-v1')).toBeNull()
    })
    it('uses original App state even when stale browser pin/archive flags remain', async () => {
        localStorage.setItem('hapi-native-archives-v1', JSON.stringify({ 'codex:original': 'Original desktop chat' }))
        localStorage.setItem('hapi-native-pins-v1', JSON.stringify({ 'codex:original': true }))
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Original desktop chat' }))
        expect(screen.getByRole('button', { name: '置顶：Original desktop chat' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: '归档会话' }))
        await screen.findByText('已同步归档到桌面 App')
        expect(command.mock.calls.some(([value]) => value.op === 'archive' && value.archived === true)).toBe(true)
        expect(JSON.parse(localStorage.getItem('hapi-native-pins-v1')!)).toEqual({ 'codex:original': true })
    })
    it('opens an original conversation outside the recent list from its link and copies its App identity', async () => {
        routing.search = { app: 'claude', thread: 'linked-original' }
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        expect(command.mock.calls.some(([value]) => value.app === 'claude' && value.id === 'linked-original' && value.op === 'read')).toBe(true)
        fireEvent.click(screen.getByRole('button', { name: '复制链接' }))
        await screen.findByText('链接已复制')
        const link = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]
        const url = new URL(link)
        expect(link).toBe('claude://claude.ai/epitaxy/linked-original')
        expect(parseNativeSearch({ app: 'invalid', thread: '../other' })).toEqual({ app: 'codex', thread: undefined })
    })
    it('offers one copy action in the conversation menu using the original App link', async () => {
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Original desktop chat' }))
        expect(screen.queryByText('复制网页链接')).toBeNull()
        expect(screen.queryByText('复制原 App 会话链接')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: '复制链接' }))
        await screen.findByText('链接已复制')
        expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('codex://threads/original')
    })
    it('offers a selectable link if clipboard permission is unavailable', async () => {
        vi.mocked(navigator.clipboard.writeText).mockRejectedValue(Error('denied'))
        routing.search = { app: 'codex', thread: 'original' }
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '复制链接' }))
        const link = await screen.findByRole('textbox', { name: '会话链接' })
        expect((link as HTMLInputElement).value).toBe('codex://threads/original')
        expect(screen.queryByText('链接已复制')).toBeNull()
    })
    it('sends with Enter, keeps Shift+Enter for newlines and never sends IME confirmation', async () => {
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Original desktop chat/ }))
        const input = await screen.findByRole('textbox', { name: '消息' })
        await screen.findByText('Readable reply')
        fireEvent.change(input, { target: { value: 'Continue original conversation' } })
        fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
        fireEvent.compositionStart(input)
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.compositionEnd(input)
        fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
        fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
        expect(command.mock.calls.some(([value]) => value.op === 'send')).toBe(false)
        fireEvent.keyDown(input, { key: 'Enter' })
        await waitFor(() => expect(command.mock.calls.filter(([value]) => value.op === 'send')).toHaveLength(1))
        expect(command.mock.calls.find(([value]) => value.op === 'send')?.[0]).toMatchObject({ app: 'codex', id: 'original', text: 'Continue original conversation' })
    })

    it('uses only an explicit new-chat model and preserves the existing conversation model', async () => {
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: (value.archived ? nativeArchived : !nativeArchived) ? [{ id: 'original', title: 'Original desktop chat', status: 'idle', archived: !!value.archived, pinned: nativePinned }] : [] }
            : value.op === 'models' ? { models: [{ id: 'gpt-6.1-sol' }, { id: 'claude-sonnet-5-5' }] }
            : value.op === 'create' ? { threadId: 'new-native' }
            : view
        }))
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /新聊天/ }))
        const selector = await screen.findByRole('combobox', { name: '新会话模型' })
        await screen.findByRole('option', { name: 'claude-sonnet-5-5' })
        expect(selector).toHaveValue('')
        fireEvent.change(selector, { target: { value: 'claude-sonnet-5-5' } })
        const input = screen.getByRole('textbox', { name: '消息' })
        fireEvent.change(input, { target: { value: 'New native task' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        await waitFor(() => expect(command.mock.calls.some(([value]) => value.op === 'create' && value.model === 'claude-sonnet-5-5')).toBe(true))
        expect(command.mock.calls.filter(([value]) => value.op === 'send')).toHaveLength(0)
    })
    it('shows concurrent DSH numbers and compact active/ended dots', async () => {
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'original', title: 'Original desktop chat', status: 'active' }, { id: 'ended', title: 'Ended chat', status: 'idle' }] }
            : { ...view, status: 'active', delegations: { running: 2, tasks: [{ id: 'one', number: 1, title: 'one', state: 'running' }, { id: 'two', number: 2, title: 'two', state: 'running' }, { id: 'old', title: 'old', state: 'completed' }] } }
        }))
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Original desktop chat/ }))
        await screen.findByLabelText('当前 DSH 任务')
        expect(screen.getByText('DSH 1')).toBeInTheDocument()
        expect(screen.getByText('DSH 2')).toBeInTheDocument()
        expect(screen.queryByText('DSH 3')).toBeNull()
        expect(screen.getByRole('img', { name: '任务运行中' })).toHaveAttribute('data-active', 'true')
        expect(screen.getByRole('img', { name: '本轮已结束' })).toHaveAttribute('data-completed', 'true')
    })

    it('keeps the conversation through a transient poll failure and reports a sustained outage', async () => {
        let failures = 0, poll: () => void = () => {}
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => {
            if (value.op === 'read' && failures > 0) { failures--; throw Error('Read connection interrupted') }
            return original(value)
        })
        const originalTimeout = globalThis.setTimeout
        const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
            if (delay === 1200 || delay === 3000) { poll = callback as () => void; return 0 as unknown as ReturnType<typeof setTimeout> }
            return originalTimeout(callback, delay, ...args)
        })
        try {
            render(<NativeDesktopPage />)
            fireEvent.click(await screen.findByRole('button', { name: /^Original desktop chat/ }))
            await screen.findByText('Readable reply')
            failures = 1
            await act(async () => { poll() })
            expect(screen.queryByText('Read connection interrupted')).toBeNull()
            expect(screen.getByText('Readable reply')).toBeInTheDocument()
            await act(async () => { poll() })
            failures = 2
            await act(async () => { poll() })
            expect(screen.queryByText('Read connection interrupted')).toBeNull()
            await act(async () => { poll() })
            expect(document.querySelector('.nd-error[role="alert"]')).toHaveTextContent('Read connection interrupted')
            await act(async () => { poll() })
            expect(screen.queryByText('Read connection interrupted')).toBeNull()
            expect(command.mock.calls.some(([value]) => value.op === 'send')).toBe(false)
        } finally { timeout.mockRestore() }
    })

    it('shows native queue acceptance for a running Claude conversation without stopping or replaying it', async () => {
        routing.search = { app: 'claude', thread: 'original' }
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => value.op === 'send'
            ? { ok: true, result: { sessionId: 'original', native: true, queued: true } }
            : value.op === 'read' && !value.since ? { ok: true, result: { ...view, status: 'active' } } : original(value))
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        const input = screen.getByRole('textbox', { name: '消息' })
        fireEvent.change(input, { target: { value: 'Follow up while running' } })
        fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
        await screen.findByText('已排队，等待接续')
        expect(screen.getByText('Follow up while running')).toBeInTheDocument()
        expect(screen.getByText('Readable reply')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /停止/ })).toBeInTheDocument()
        expect(screen.queryByRole('alert')).toBeNull()
        expect(input).toHaveValue('')
        expect(command.mock.calls.filter(([value]) => value.op === 'send')).toHaveLength(1)
        expect(command.mock.calls.some(([value]) => value.op === 'stop')).toBe(false)
    })

    it.each(['active', 'unknown'])('sends Stop once to the selected original Claude session when status is %s', async status => {
        routing.search = { app: 'claude', thread: 'original' }
        let stopped = false
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => {
            if (value.op === 'stop') { stopped = true; return { ok: true, result: { ok: true, stopped: true } } }
            if (value.op === 'read') return { ok: true, result: { ...view, status: stopped ? 'idle' : status } }
            return original(value)
        })
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /停止/ }))
        await waitFor(() => expect(screen.queryByRole('button', { name: /停止/ })).toBeNull())
        const stops = command.mock.calls.filter(([value]) => value.op === 'stop')
        expect(stops).toHaveLength(1)
        expect(stops[0][0]).toMatchObject({ app: 'claude', id: 'original', actionId: expect.any(String) })
        expect(command.mock.calls.some(([value]) => value.op === 'send' || value.op === 'create')).toBe(false)
        expect(screen.getByText('Readable reply')).toBeInTheDocument()
    })

    it.each(['native', 'http', 'gateway'] as const)('retains a %s send failure through successful reads without replaying or clearing the draft', async mode => {
        routing.search = { app: 'claude', thread: 'original' }
        let poll: () => void = () => {}
        const original = command.getMockImplementation()!
        const message = mode === 'gateway' ? '桌面连接暂时不可用（HTTP 502）' : 'Claude 桌面输入框已有草稿，请先处理草稿再从远端发送'
        command.mockImplementation(async value => {
            if (value.op === 'send') {
                if (mode === 'gateway') throw Object.assign(Error('HTTP 502 Bad Gateway: <!DOCTYPE html><html>Cloudflare gateway page</html>'), { status: 502, body: '<!DOCTYPE html><html>Cloudflare gateway page</html>' })
                if (mode === 'http') throw Object.assign(Error('HTTP 502 Bad Gateway'), { body: JSON.stringify({ ok: false, error: message }) })
                return { ok: false, error: message }
            }
            return original(value)
        })
        const originalTimeout = globalThis.setTimeout
        const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
            if (delay === 1200 || delay === 3000) { poll = callback as () => void; return 0 as unknown as ReturnType<typeof setTimeout> }
            return originalTimeout(callback, delay, ...args)
        })
        try {
            render(<NativeDesktopPage />)
            await screen.findByText('Readable reply')
            const input = screen.getByRole('textbox', { name: '消息' })
            fireEvent.change(input, { target: { value: 'Keep my follow up' } })
            fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
            expect(await screen.findByRole('alert')).toHaveTextContent(message)
            await act(async () => { poll() })
            await act(async () => { poll() })
            expect(screen.getByRole('alert')).toHaveTextContent(message)
            expect(screen.queryByText(/Cloudflare gateway page|<!DOCTYPE/)).toBeNull()
            if (mode !== 'gateway') expect(screen.queryByText(/HTTP 502/)).toBeNull()
            expect(input).toHaveValue('Keep my follow up')
            expect(command.mock.calls.filter(([value]) => value.op === 'send')).toHaveLength(1)
            expect(command.mock.calls.some(([value]) => value.op === 'stop')).toBe(false)
        } finally { timeout.mockRestore() }
    })

    it('previews, removes and sends image attachments in the original conversation', async () => {
        routing.search = { app: 'codex', thread: 'original' }
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        fireEvent.change(screen.getByLabelText('选择图片'), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' }), new File(['two'], 'two.png', { type: 'image/png' })] } })
        await screen.findByRole('button', { name: '移除图片 2' })
        fireEvent.click(screen.getByRole('button', { name: '移除图片 1' }))
        expect(screen.queryByAltText('one.png')).toBeNull()
        expect(screen.getByAltText('two.png')).toBeInTheDocument()
        fireEvent.keyDown(screen.getByRole('textbox', { name: '消息' }), { key: 'Enter' })
        await waitFor(() => expect(command.mock.calls.some(([value]) => value.op === 'send' && value.images?.length === 1)).toBe(true))
        expect(command.mock.calls.find(([value]) => value.op === 'send')?.[0]).toMatchObject({ id: 'original', text: '', images: [{ name: 'two.png' }] })
    })
    it('quietly highlights the other App only after observed running-to-ended transition', async () => {
        let ended = false, refresh: () => void = () => {}
        const originalInterval = globalThis.setInterval
        const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => { if (delay === 5000) { refresh = callback as () => void; return 0 as unknown as ReturnType<typeof setInterval> }; return originalInterval(callback, delay, ...args) })
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result: { threads: [{ id: 'original', title: 'Original desktop chat', status: value.app === 'claude' && !ended ? 'active' : 'idle' }] } }))
        try {
            render(<NativeDesktopPage />)
            await screen.findByRole('button', { name: /^Original desktop chat/ })
            const tab = screen.getByRole('button', { name: 'Claude Code' })
            expect(tab).toHaveAttribute('data-notify', 'false')
            await act(async () => {})
            ended = true; await act(async () => { refresh() })
            await waitFor(() => expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveAttribute('data-notify', 'true'))
            fireEvent.animationEnd(screen.getByRole('button', { name: 'Claude Code' }))
            expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveAttribute('data-notify', 'false')
            expect(screen.queryByText('任务已完成')).toBeNull()
        } finally { interval.mockRestore() }
    })

    it('keeps per-chat text and attachments through switching, and text through a refresh', async () => {
        routing.search = { app: 'codex', thread: 'original' }
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: 'Unsent original draft' } })
        fireEvent.change(screen.getByLabelText('选择图片'), { target: { files: [new File(['one'], 'draft.png', { type: 'image/png' })] } })
        await screen.findByAltText('draft.png')
        fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
        fireEvent.click(await screen.findByRole('button', { name: /^Original desktop chat/ }))
        expect(screen.getByRole('textbox', { name: '消息' })).toHaveValue('')
        fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
        fireEvent.click(await screen.findByRole('button', { name: /^Original desktop chat/ }))
        expect(screen.getByRole('textbox', { name: '消息' })).toHaveValue('Unsent original draft')
        expect(screen.getByAltText('draft.png')).toBeInTheDocument()
        cleanup()
        render(<NativeDesktopPage />)
        expect(await screen.findByRole('textbox', { name: '消息' })).toHaveValue('Unsent original draft')
        expect(screen.queryByAltText('draft.png')).toBeNull()
        expect(command.mock.calls.some(([value]) => value.op === 'send')).toBe(false)
    })

    it('acknowledges repeated messages only with distinct newly observed original user items', async () => {
        routing.search = { app: 'claude', thread: 'original' }
        let count = 0
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => value.op === 'send' ? { ok: true, result: { queued: true, native: true } }
            : value.op === 'read' ? { ok: true, result: { ...view, revision: String(count), turns: [...view.turns, ...Array.from({ length: count }, (_, n) => ({ id: 'new-' + n, status: 'completed', items: [{ id: 'new-' + n, key: 'new-key-' + n, role: 'user', text: 'Question' }] }))] } } : original(value))
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        const input = screen.getByRole('textbox', { name: '消息' })
        for (let i = 0; i < 2; i++) {
            fireEvent.change(input, { target: { value: 'Question' } })
            fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
            await waitFor(() => expect(input).toHaveValue(''))
        }
        expect(document.querySelectorAll('.nd-pending')).toHaveLength(2)
        count = 1
        await act(async () => { window.dispatchEvent(new Event('online')) })
        await waitFor(() => expect(document.querySelectorAll('.nd-pending')).toHaveLength(1))
        count = 2
        await act(async () => { window.dispatchEvent(new Event('online')) })
        await waitFor(() => expect(document.querySelectorAll('.nd-pending')).toHaveLength(0))
        expect(command.mock.calls.filter(([value]) => value.op === 'send')).toHaveLength(2)
    })

    it('keeps image-only sends visible while the original message syncs', async () => {
        routing.search = { app: 'codex', thread: 'original' }
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        fireEvent.change(screen.getByLabelText('选择图片'), { target: { files: [new File(['one'], 'only.png', { type: 'image/png' })] } })
        await screen.findByAltText('only.png')
        fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
        await screen.findByText('已发送，等待同步')
        expect(document.querySelector('.nd-pending img')).toHaveAttribute('alt', 'only.png')
        expect(screen.queryByRole('button', { name: '移除图片 1' })).toBeNull()
    })

    it('refreshes an open tool when its original result completes', async () => {
        routing.search = { app: 'codex', thread: 'original' }
        let completed = false
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => value.itemKey
            ? { ok: true, result: { item: { ...view.turns[0].items[1], output: completed ? 'Final original tool result' : 'Tool still working' } } }
            : value.op === 'read' ? { ok: true, result: { ...view, revision: completed ? 'done' : 'running', turns: [{ ...view.turns[0], items: view.turns[0].items.map(item => item.role === 'tool' ? { ...item, status: completed ? 'completed' : 'inProgress' } : item) }] } } : original(value))
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        const group = document.querySelector<HTMLDetailsElement>('.nd-activity')!
        group.open = true; fireEvent(group, new Event('toggle'))
        const detail = screen.getByText('Bash tool').closest('details')!
        detail.open = true; fireEvent(detail, new Event('toggle'))
        await screen.findByText('Tool still working')
        completed = true
        await act(async () => { window.dispatchEvent(new Event('online')) })
        await screen.findByText('Final original tool result')
        expect(detail.open).toBe(true)
    })
    it('keeps the previous tool output visible until its live refresh completes', async () => {
        routing.search = { app: 'codex', thread: 'original' }
        let updated = false, finishDetail: (() => void) | undefined, detailReads = 0
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => value.itemKey
            ? ++detailReads === 2 ? new Promise(resolve => { finishDetail = () => resolve({ ok: true, result: { item: { ...view.turns[0].items[1], output: 'Updated output' } } }) })
                : { ok: true, result: { item: { ...view.turns[0].items[1], output: 'Previous output' } } }
            : value.op === 'read' ? { ok: true, result: { ...view, revision: updated ? 'updated' : 'running', turns: [{ ...view.turns[0], items: view.turns[0].items.map(item => item.role === 'tool' ? { ...item, outputLength: updated ? 50 : 20 } : item) }] } }
                : original(value))
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        const group = document.querySelector<HTMLDetailsElement>('.nd-activity')!
        group.open = true; fireEvent(group, new Event('toggle'))
        const detail = screen.getByText('Bash tool').closest('details')!
        detail.open = true; fireEvent(detail, new Event('toggle'))
        await screen.findByText('Previous output')
        updated = true
        await act(async () => { window.dispatchEvent(new Event('online')) })
        await waitFor(() => expect(detailReads).toBe(2))
        expect(screen.getByText('Previous output')).toBeInTheDocument()
        await act(async () => { finishDetail?.() })
        await screen.findByText('Updated output')
    })
    it('keeps current-chat sending disabled when the list alone reconnects', async () => {
        routing.search = { app: 'codex', thread: 'original' }
        let failRead = false, reads = 0
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => {
            if (value.op === 'read' && !value.itemKey) {
                reads++
                if (failRead) return { ok: false, error: 'Original chat is unavailable' }
            }
            return original(value)
        })
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: 'Draft stays local' } })
        const send = screen.getByRole('button', { name: '发送消息' })
        expect(send).toBeEnabled()
        failRead = true
        for (let i = 0; i < 2; i++) {
            const previous = reads
            await act(async () => { window.dispatchEvent(new Event('online')) })
            await waitFor(() => expect(reads).toBeGreaterThan(previous))
        }
        await waitFor(() => expect(send).toBeDisabled())
        const previous = reads
        await act(async () => { window.dispatchEvent(new Event('online')) })
        await waitFor(() => expect(reads).toBeGreaterThan(previous))
        expect(send).toBeDisabled()
        expect(command.mock.calls.some(([value]) => value.op === 'send')).toBe(false)
    })

    it.each([502, 503, 504, 'network', 'transport'] as const)('recovers a transient %s initial read once without flashing an error', async status => {
        routing.search = { app: 'codex', thread: `gateway-recovery-${status}` }
        const original = command.getMockImplementation()!
        let reads = 0
        command.mockImplementation(async value => {
            if (value.op === 'read' && ++reads === 1) {
                if (status === 'network') throw new TypeError('Failed to fetch')
                if (status === 'transport') throw Object.assign(Error('HTTP 503'), { status: 503, body: JSON.stringify({ ok: false, code: 'desktop_transport_unavailable', error: '桌面连接中断' }) })
                throw Object.assign(Error(`HTTP ${status}`), { status, body: '<html>Bad gateway</html>' })
            }
            return original(value)
        })
        render(<NativeDesktopPage />)
        await waitFor(() => expect(reads).toBe(1))
        expect(document.querySelector('.nd-error[role="alert"]')).toBeNull()
        await screen.findByText('Readable reply')
        expect(reads).toBe(2)
        const requests = command.mock.calls.filter(([value]) => value.op === 'read')
        expect(requests[0][0]).toEqual(requests[1][0])
        expect(requests[0][1].signal).toBe(requests[1][1].signal)
        expect(document.querySelector('.nd-error[role="alert"]')).toBeNull()
        expect(command.mock.calls.some(([value]) => ['send', 'create', 'stop'].includes(value.op))).toBe(false)
    })

    it('limits persistent gateway recovery to one retry and keeps the failure visible', async () => {
        routing.search = { app: 'codex', thread: 'gateway-still-unavailable' }
        const original = command.getMockImplementation()!
        let reads = 0
        command.mockImplementation(async value => {
            if (value.op === 'read') { reads++; throw Object.assign(Error('HTTP 502'), { status: 502, body: '<html>Bad gateway</html>' }) }
            return original(value)
        })
        render(<NativeDesktopPage />)
        await waitFor(() => expect(document.querySelector('.nd-error[role="alert"]')).toHaveTextContent('桌面连接暂时不可用（HTTP 502）'))
        expect(reads).toBe(2)
        expect(screen.getByRole('button', { name: '重新连接' })).toBeInTheDocument()
    })

    it.each([409, 502])('shows native application HTTP %s rejections immediately without retrying the read', async status => {
        routing.search = { app: 'codex', thread: `native-rejection-${status}` }
        const original = command.getMockImplementation()!
        let reads = 0
        command.mockImplementation(async value => {
            if (value.op === 'read') { reads++; throw Object.assign(Error(`HTTP ${status}`), { status, body: JSON.stringify({ ok: false, error: '原会话已不可用' }) }) }
            return original(value)
        })
        render(<NativeDesktopPage />)
        await waitFor(() => expect(document.querySelector('.nd-error[role="alert"]')).toHaveTextContent('原会话已不可用'))
        expect(reads).toBe(1)
    })

    it('recovers a failed native list with the reconnect control without replaying writes', async () => {
        let failed = true
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => value.app === 'codex' && value.op === 'list' && failed ? { ok: false, error: 'Temporary desktop disconnect' } : original(value))
        render(<NativeDesktopPage />)
        await screen.findByText('Temporary desktop disconnect')
        failed = false
        fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
        await screen.findByRole('button', { name: /^Original desktop chat/ })
        expect(screen.queryByRole('alert')).toBeNull()
        expect(command.mock.calls.some(([value]) => ['send', 'create', 'stop'].includes(value.op))).toBe(false)
    })

    it('aborts a stalled read and recovers on reconnect without replaying a message', async () => {
        routing.search = { app: 'codex', thread: 'timeout-read' }
        let stalled = true, expire: (() => void) | undefined
        const original = command.getMockImplementation()!
        const originalTimeout = globalThis.setTimeout
        const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
            if (delay === 25000) { expire = callback as () => void; return 0 as unknown as ReturnType<typeof setTimeout> }
            return originalTimeout(callback, delay, ...args)
        })
        command.mockImplementation(async (value, options) => value.op === 'read' && stalled
            ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
            : original(value))
        try {
            render(<NativeDesktopPage />)
            await waitFor(() => expect(expire).toBeDefined())
            await act(async () => { expire!() })
            await screen.findByText('读取超时，正在重新连接')
            stalled = false
            fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
            await screen.findByText('Readable reply')
            expect(document.querySelector('.nd-error[role="alert"]')).toBeNull()
            expect(command.mock.calls.some(([value]) => value.op === 'send')).toBe(false)
        } finally { timeout.mockRestore() }
    })

    it('suspends hidden-page history polling and refreshes immediately on return', async () => {
        routing.search = { app: 'codex', thread: 'audit-hidden-chat' }
        const callbacks: (() => void)[] = []
        const originalTimeout = globalThis.setTimeout
        const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
            if (delay === 1200 || delay === 3000) { callbacks.push(callback as () => void); return 0 as unknown as ReturnType<typeof setTimeout> }
            return originalTimeout(callback, delay, ...args)
        })
        const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
        const reads = () => command.mock.calls.filter(([value]) => value.op === 'read').length
        try {
            render(<NativeDesktopPage />)
            await screen.findByText('Readable reply')
            const baseline = reads()
            visibility.mockReturnValue(true)
            for (let i = 0; i < 3 && callbacks.length; i++) await act(async () => { callbacks.shift()!() })
            expect(reads()).toBe(baseline)
            visibility.mockReturnValue(false)
            await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
            expect(reads()).toBe(baseline + 1)
        } finally { visibility.mockRestore(); timeout.mockRestore() }
    })
    it('keeps list polling for one App responsive while the other App is stalled', async () => {
        let refresh: () => void = () => {}, revision = 1
        const originalInterval = globalThis.setInterval
        const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
            if (delay === 5000) { refresh = callback as () => void; return 0 as unknown as ReturnType<typeof setInterval> }
            return originalInterval(callback, delay, ...args)
        })
        command.mockImplementation(async value => value.app === 'claude' ? new Promise(() => {})
            : { ok: true, result: { threads: [{ id: 'list-audit', title: `Native list version ${revision}`, status: 'idle' }] } })
        try {
            render(<NativeDesktopPage />)
            await screen.findByRole('button', { name: /^Native list version 1/ })
            revision = 2
            await act(async () => { refresh() })
            expect(screen.getByRole('button', { name: /^Native list version 2/ })).toBeInTheDocument()
            expect(command.mock.calls.filter(([value]) => value.app === 'claude')).toHaveLength(1)
        } finally { interval.mockRestore() }
    })
    it('does not download tool output while its group is folded and refreshes on reopen', async () => {
        routing.search = { app: 'codex', thread: 'audit-folded-tool' }
        let completed = false
        const original = command.getMockImplementation()!
        command.mockImplementation(async value => value.itemKey
            ? { ok: true, result: { item: { ...view.turns[0].items[1], output: completed ? 'Updated folded output' : 'Initial folded output' } } }
            : value.op === 'read' ? { ok: true, result: { ...view, revision: completed ? 'done' : 'running', turns: [{ ...view.turns[0], items: view.turns[0].items.map(item => item.role === 'tool' ? { ...item, status: completed ? 'completed' : 'inProgress' } : item) }] } } : original(value))
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        const group = document.querySelector<HTMLDetailsElement>('.nd-activity')!
        group.open = true; fireEvent(group, new Event('toggle'))
        const detail = screen.getByText('Bash tool').closest('details')!
        detail.open = true; fireEvent(detail, new Event('toggle'))
        await screen.findByText('Initial folded output')
        group.open = false; fireEvent(group, new Event('toggle'))
        completed = true
        await act(async () => { window.dispatchEvent(new Event('online')) })
        expect(command.mock.calls.filter(([value]) => value.itemKey)).toHaveLength(1)
        group.open = true; fireEvent(group, new Event('toggle'))
        await screen.findByText('Updated folded output')
        expect(detail.open).toBe(true)
        expect(command.mock.calls.filter(([value]) => value.itemKey)).toHaveLength(2)
    })

})
