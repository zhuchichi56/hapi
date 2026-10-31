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

const view = {
    id: 'original', title: 'Original desktop chat', status: 'idle', live: true, historyComplete: true,
    hasEarlier: true, before: 'cursor', revision: 'one', windowStart: 80, requests: [],
    turns: [{ id: 'native-turn', status: 'completed', items: [
        { id: 'ask', key: 'ask-key', role: 'user', text: 'Question' },
        { id: 'tool', key: 'tool-key', role: 'tool', text: 'Bash tool', hasDetail: true },
        { id: 'reply', key: 'reply-key', role: 'assistant', text: 'Readable reply' }
    ] }]
}

describe('native Desktop connection resilience', () => {
    beforeEach(() => {
        routing.search = { app: 'codex', thread: undefined }
        sessionStorage.clear()
        command.mockReset()
    })
    afterEach(() => { cleanup(); vi.restoreAllMocks() })

    it('keeps the chat disconnected while only the list channel recovers', async () => {
        let failures = 0
        let poll: () => void = () => {}
        let listTick: () => void = () => {}
        command.mockImplementation(async (value: Record<string, unknown>) => {
            if (value.op === 'models') return { ok: true, result: { models: [{ id: 'gpt-6.1-sol' }] } }
            if (value.op === 'model-settings') return { ok: true, result: { model: 'gpt-6.1-sol', reasoningEffort: 'high' } }
            if (value.op === 'list') return { ok: true, result: { threads: [{ id: 'original', title: 'Original desktop chat', status: 'idle' }] } }
            if (value.op === 'read' && value.since === 'one') {
                if (failures > 0) { failures--; throw Error('Read connection interrupted') }
                return { ok: true, result: { id: 'original', revision: 'one', unchanged: true } }
            }
            return { ok: true, result: view }
        })
        const originalTimeout = globalThis.setTimeout
        const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
            if (delay === 1200 || delay === 3000) { poll = callback as () => void; return 0 as unknown as ReturnType<typeof setTimeout> }
            return originalTimeout(callback, delay, ...args)
        })
        const originalInterval = globalThis.setInterval
        const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
            if (delay === 5000) { listTick = callback as () => void; return 0 as unknown as ReturnType<typeof setInterval> }
            return originalInterval(callback, delay, ...args)
        })
        try {
            render(<NativeDesktopPage />)
            fireEvent.click(await screen.findByRole('button', { name: /^Original desktop chat/ }))
            await screen.findByText('Readable reply')
            fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: 'keep this' } })

            failures = 2
            await act(async () => { poll() })
            await act(async () => { poll() })
            expect(await screen.findByText('连接中断，正在重连')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()

            // The list channel recovers while history reads are still broken.
            await act(async () => { listTick() })
            // Desired: chat health is independent of list health, so sending stays closed.
            expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
            expect(screen.getByText('连接中断，正在重连')).toBeInTheDocument()
            await act(async () => { poll() })
            expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled()
        } finally { timeout.mockRestore(); interval.mockRestore() }
    })

    it('keeps expanded tool output visible while a growing detail refreshes', async () => {
        routing.search = { app: 'codex', thread: 'tool-growth' }
        const growing = {
            ...view, id: 'tool-growth', revision: 'one', status: 'active',
            turns: [{ id: 'native-turn', status: 'inProgress', items: [
                { id: 'ask', key: 'ask-key', role: 'user', text: 'Question' },
                { id: 'tool', key: 'tool-key', role: 'tool', text: 'Bash tool', status: 'inProgress', hasDetail: true, outputLength: 5 },
                { id: 'reply', key: 'reply-key', role: 'assistant', text: 'Readable reply' }
            ] }]
        }
        let detailCalls = 0
        let resolveSecond: ((value: unknown) => void) | undefined
        command.mockImplementation(async (value: Record<string, unknown>) => {
            if (value.op === 'models') return { ok: true, result: { models: [{ id: 'gpt-6.1-sol' }] } }
            if (value.op === 'model-settings') return { ok: true, result: { model: 'gpt-6.1-sol', reasoningEffort: 'high' } }
            if (value.op === 'list') return { ok: true, result: { threads: [{ id: 'tool-growth', title: 'Tool growth', status: 'active' }] } }
            if (value.itemKey === 'tool-key') {
                detailCalls++
                if (detailCalls === 1) return { ok: true, result: { item: { id: 'tool', key: 'tool-key', role: 'tool', text: 'Bash tool', status: 'inProgress', output: 'line1', outputLength: 5 } } }
                return new Promise(resolve => { resolveSecond = resolve as (value: unknown) => void }) as never
            }
            if (value.op === 'read' && value.since === 'two') return { ok: true, result: { id: 'tool-growth', revision: 'two', unchanged: true } }
            if (value.op === 'read' && value.since === 'one') {
                return { ok: true, result: { ...growing, revision: 'two', turns: [{ ...growing.turns[0], items: growing.turns[0].items.map(item => item.key === 'tool-key' ? { ...item, outputLength: 11 } : item) }] } }
            }
            return { ok: true, result: growing }
        })
        try {
            render(<NativeDesktopPage />)
            await screen.findByText('Readable reply')
            const group = document.querySelector<HTMLDetailsElement>('.nd-activity')!
            group.open = true; fireEvent(group, new Event('toggle'))
            const detail = screen.getByText('Bash tool').closest('details')!
            detail.open = true; fireEvent(detail, new Event('toggle'))
            await screen.findByText('line1')

            await act(async () => { window.dispatchEvent(new Event('online')) })
            await waitFor(() => expect(detailCalls).toBe(2))
            // Desired: old output stays readable while the new page is in flight.
            expect(screen.getByText('line1')).toBeInTheDocument()

            await act(async () => { resolveSecond!({ ok: true, result: { item: { id: 'tool', key: 'tool-key', role: 'tool', text: 'Bash tool', status: 'inProgress', output: 'line1\nline2', outputLength: 11 } } }) })
            await screen.findByText(/line1\s+line2/)
            await act(async () => { window.dispatchEvent(new Event('online')) })
            // No new detail request is made for an unchanged item version.
            expect(detailCalls).toBe(2)
        } finally {
            // Release a still-pending detail read so its 25s AbortController timer is cleared.
            resolveSecond?.({ ok: true, result: { item: { id: 'tool', key: 'tool-key', role: 'tool', text: 'Bash tool', status: 'inProgress', output: 'line1\nline2', outputLength: 11 } } })
        }
    })
    it.each(['envelope', 'http'])('shows uncertain delivery from %s without replaying or clearing the draft', async mode => {
        command.mockImplementation(async value => {
            if (value.op === 'send') {
                const detail = { ok: false, error: 'Desktop request timed out', delivery: 'unknown' }
                if (mode === 'http') throw Object.assign(Error('HTTP 502'), { status: 502, body: JSON.stringify(detail) })
                return detail
            }
            if (value.op === 'list') return { ok: true, result: { threads: [{ id: 'delivery', title: 'Delivery check', status: 'idle' }] } }
            if (value.op === 'models') return { ok: true, result: { models: [] } }
            return { ok: true, result: { ...view, id: 'delivery' } }
        })
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Delivery check/ }))
        await screen.findByText('Readable reply')
        fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: 'Original draft' } })
        fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
        await screen.findByText('提交结果暂未确认，请先查看原会话，避免重复操作')
        expect(screen.getByRole('textbox', { name: '消息' })).toHaveValue('Original draft')
        expect(command.mock.calls.filter(([value]) => value.op === 'send')).toHaveLength(1)
    })

})
