import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const { command, api } = vi.hoisted(() => {
    const command = vi.fn()
    return { command, api: { nativeDesktopCommand: command } }
})
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api }) }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }))
vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }))
import NativeDesktopPage from './nativeDesktop'
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
        fireEvent.click(await screen.findByRole('button', { name: /Original desktop chat/ }))
        await screen.findByText('Readable reply')
        expect(screen.queryByText('Detailed original output')).toBeNull()
        expect(command.mock.calls.some(([value]) => value.itemKey)).toBe(false)
        const details = screen.getByText('Bash tool').closest('details')!
        details.open = true
        fireEvent(details, new Event('toggle'))
        await screen.findByText('Detailed original output')
        expect(command.mock.calls.some(([value]) => value.id === 'original' && value.itemKey === 'tool-key')).toBe(true)
    })
    it('adds older messages while retaining the current original reply', async () => {
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /Original desktop chat/ }))
        fireEvent.click(await screen.findByRole('button', { name: /更早的消息/ }))
        await screen.findByText('Earlier original message')
        expect(screen.getByText('Readable reply')).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByRole('button', { name: /更早的消息/ })).toBeNull())
    })
    it('restores a compact composer after clearing a long draft', async () => {
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /Original desktop chat/ }))
        const input = await screen.findByRole('textbox', { name: '消息' }) as HTMLTextAreaElement
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 300 })
        fireEvent.change(input, { target: { value: 'A long draft' } })
        expect(input.style.height).toBe('180px')
        fireEvent.change(input, { target: { value: '' } })
        expect(input.style.height).toBe('auto')
    })
})
