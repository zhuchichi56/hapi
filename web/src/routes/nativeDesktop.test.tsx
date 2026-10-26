import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
describe('desktop reading experience', () => {
    beforeEach(() => {
        routing.search = { app: 'codex', thread: undefined }
        localStorage.removeItem('hapi-native-pins-v1')
        localStorage.removeItem('hapi-native-archives-v1')
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
        command.mockReset()
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'original', title: 'Original desktop chat', status: 'idle' }] }
            : value.itemKey ? { item: { id: 'tool', key: 'tool-key', role: 'tool', text: 'Bash tool', output: 'Detailed original output' } }
            : value.before ? { ...view, revision: 'older', hasEarlier: false, before: 'older-cursor', turns: [{ id: 'earlier-native-turn', status: 'completed', items: [{ id: 'early', key: 'early-key', role: 'assistant', text: 'Earlier original message' }] }] }
            : value.since ? { id: 'original', revision: 'one', unchanged: true }
            : view
        }))
    })
    afterEach(cleanup)
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
    it('pins a conversation ahead of the list and restores the order after remount', async () => {
        const original = { id: 'original', title: 'Original desktop chat', status: 'idle' }
        const later = { id: 'later', title: 'Later desktop chat', status: 'idle' }
        command.mockImplementation(async () => ({ ok: true, result: { threads: [original, later] } }))
        const page = render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Later desktop chat' }))
        fireEvent.click(await screen.findByRole('button', { name: '置顶：Later desktop chat（此浏览器）' }))
        const titles = () => [...document.querySelectorAll('.nd-thread-title')].map(el => el.textContent)
        expect(titles()).toEqual(['Later desktop chat', 'Original desktop chat'])
        expect(JSON.parse(localStorage.getItem('hapi-native-pins-v1')!)).toMatchObject({ 'codex:later': true })
        page.unmount()
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Later desktop chat' }))
        await screen.findByRole('button', { name: '取消置顶：Later desktop chat（此浏览器）' })
        expect(titles()).toEqual(['Later desktop chat', 'Original desktop chat'])
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
    it('archives only the browser list and restores after remount without native writes', async () => {
        const page = render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Original desktop chat' }))
        fireEvent.click(await screen.findByRole('button', { name: '归档会话' }))
        expect(document.querySelectorAll('.nd-thread')).toHaveLength(0)
        expect(JSON.parse(localStorage.getItem('hapi-native-archives-v1')!)).toEqual({ 'codex:original': 'Original desktop chat' })
        page.unmount()
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /已归档/ }))
        fireEvent.click(await screen.findByRole('button', { name: '更多操作：Original desktop chat' }))
        fireEvent.click(await screen.findByRole('button', { name: '恢复到最近' }))
        fireEvent.click(screen.getByRole('button', { name: /返回最近/ }))
        await screen.findByRole('button', { name: /^Original desktop chat/ })
        expect(JSON.parse(localStorage.getItem('hapi-native-archives-v1')!)).toEqual({})
        expect(command.mock.calls.every(([value]) => value.op === 'list')).toBe(true)
    })
    it('opens an original conversation outside the recent list from its link and copies its App identity', async () => {
        routing.search = { app: 'claude', thread: 'linked-original' }
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        expect(command.mock.calls.some(([value]) => value.app === 'claude' && value.id === 'linked-original' && value.op === 'read')).toBe(true)
        fireEvent.click(screen.getByRole('button', { name: '复制当前会话链接' }))
        await screen.findByText('会话链接已复制')
        const link = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]
        const url = new URL(link)
        expect(url.pathname).toBe('/desktop')
        expect([...url.searchParams]).toEqual([['app', 'claude'], ['thread', 'linked-original']])
        expect(parseNativeSearch(Object.fromEntries(url.searchParams))).toEqual(routing.search)
        expect(parseNativeSearch({ app: 'invalid', thread: '../other' })).toEqual({ app: 'codex', thread: undefined })
    })
    it('offers a selectable link if clipboard permission is unavailable', async () => {
        vi.mocked(navigator.clipboard.writeText).mockRejectedValue(Error('denied'))
        routing.search = { app: 'codex', thread: 'original' }
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: '复制当前会话链接' }))
        const link = await screen.findByRole('textbox', { name: '会话链接' })
        expect((link as HTMLInputElement).value).toContain('/desktop?app=codex&thread=original')
        expect(screen.queryByText('会话链接已复制')).toBeNull()
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

})
