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
vi.mock('@/components/nativeDesktop/attachments', async importOriginal => ({ ...await importOriginal<typeof import('@/components/nativeDesktop/attachments')>(), prepareImage: async (file: File) => ({ name: file.name, data: 'data:image/png;base64,aW1hZ2U=' }) }))
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

const threadEntry = (id: string, title: string) => ({ id, title, status: 'idle' })
const conversation = (id: string, text: string, extra: { revision?: string; hasEarlier?: boolean; before?: string | null; status?: string; live?: boolean; historyComplete?: boolean; windowStart?: number } = {}) => ({
    ...view, id, title: id, ...extra,
    turns: [{ id: `${id}-turn`, status: 'completed', items: [
        { id: `${id}-ask`, key: `${id}-ask`, role: 'user', text: 'Question' },
        { id: `${id}-reply`, key: `${id}-reply`, role: 'assistant', text }
    ] }]
})
const identityError = '桌面返回了其他会话的内容，已保留当前会话'

describe('native Desktop connection resilience', () => {
    it('preserves live content during brief fallback, exposes sustained fallback updates, then accepts live recovery', async () => {
        routing.search = { app: 'codex', thread: 'source-recovery' }
        let now = 100000, mode = 'live'
        vi.spyOn(Date, 'now').mockImplementation(() => now)
        const source = (live: boolean, text: string) => ({ ...view, id: 'source-recovery', live, revision: mode,
            turns: [{ id: 'source-turn', status: 'completed', items: [{ id: 'source-item', key: 'source-item', role: 'assistant', text }] }] })
        command.mockImplementation(async value => {
            if (value.op === 'list') return { ok: true, result: { threads: [] } }
            if (value.op === 'models') return { ok: true, result: { models: [] } }
            if (value.op === 'model-settings') return { ok: true, result: { model: 'gpt-6.1-sol' } }
            return { ok: true, result: source(mode.startsWith('live'), mode === 'live' ? 'Current native content' : mode === 'fallback-new' ? 'New fallback content' : mode === 'live-new' ? 'Resumed native content' : 'Older fallback content') }
        })
        render(<NativeDesktopPage />)
        await screen.findByText('Current native content')
        mode = 'fallback'; now += 1000
        await act(async () => { window.dispatchEvent(new Event('online')) })
        expect(screen.getByText('Current native content')).toBeInTheDocument()
        expect(screen.queryByText('Older fallback content')).not.toBeInTheDocument()
        expect(screen.getByText('实时连接正在恢复，已保留当前内容')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
        mode = 'fallback-new'; now += 16000
        await act(async () => { window.dispatchEvent(new Event('online')) })
        expect(screen.getByText('New fallback content')).toBeInTheDocument()
        expect(screen.getByText('实时连接暂不可用，正在显示备用历史；恢复后会自动接续。')).toBeInTheDocument()
        mode = 'live-new'; now += 1000
        await act(async () => { window.dispatchEvent(new Event('online')) })
        expect(screen.getByText('Resumed native content')).toBeInTheDocument()
        expect(screen.queryByText(/实时连接暂不可用/)).not.toBeInTheDocument()
    })

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
    it('does not add another full polling interval after a slow active read or overlap requests', async () => {
        routing.search = { app: 'codex', thread: 'slow-live' }
        let clock = 0, finish: ((value: unknown) => void) | undefined
        vi.spyOn(performance, 'now').mockImplementation(() => clock)
        const delays: number[] = []
        const originalTimeout = globalThis.setTimeout
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
            if (delay === 150 || delay === 1200 || delay === 3000) { delays.push(Number(delay)); return 0 as unknown as ReturnType<typeof setTimeout> }
            return originalTimeout(callback, delay, ...args)
        })
        command.mockImplementation(async value => {
            if (value.op === 'list') return { ok: true, result: { threads: [] } }
            if (value.op === 'models') return { ok: true, result: { models: [{ id: 'gpt-6.1-sol' }] } }
            if (value.op === 'model-settings') return { ok: true, result: { model: 'gpt-6.1-sol', reasoningEffort: 'high' } }
            return new Promise(resolve => { finish = resolve as (value: unknown) => void }) as never
        })
        render(<NativeDesktopPage />)
        await act(async () => { window.dispatchEvent(new Event('online')) })
        expect(command.mock.calls.filter(([value]) => value.op === 'read')).toHaveLength(1)
        await act(async () => { clock = 2000; finish!({ ok: true, result: { ...view, id: 'slow-live', status: 'active' } }) })
        expect(delays.at(-1)).toBe(150)
        expect(screen.getByText('Readable reply')).toBeInTheDocument()
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

    it('aborts a stale A to B to A session read and never lets it overwrite the new view', async () => {
        const alpha = conversation('rapid-alpha', 'Alpha newest')
        const alphaOld = conversation('rapid-alpha', 'Stale alpha')
        const beta = conversation('rapid-beta', 'Beta current')
        let alphaReads = 0
        let resolveOld: ((value: unknown) => void) | undefined
        const readSignals: { id: string; signal?: AbortSignal }[] = []
        command.mockImplementation(async (value: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
            if (value.op === 'models') return { ok: true, result: { models: [{ id: 'gpt-6.1-sol' }] } }
            if (value.op === 'model-settings') return { ok: true, result: { model: 'gpt-6.1-sol', reasoningEffort: 'high' } }
            if (value.op === 'list') return { ok: true, result: { threads: [threadEntry('rapid-alpha', 'Rapid alpha'), threadEntry('rapid-beta', 'Rapid beta')] } }
            if (value.op === 'read' && !value.itemKey) {
                readSignals.push({ id: String(value.id), signal: options?.signal })
                if (value.id === 'rapid-alpha') {
                    alphaReads++
                    if (alphaReads === 1) return new Promise(resolve => { resolveOld = resolve as (value: unknown) => void }) as never
                    return { ok: true, result: alpha }
                }
                return { ok: true, result: beta }
            }
            return { ok: true, result: alpha }
        })
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Rapid alpha/ }))
        await waitFor(() => expect(alphaReads).toBe(1))

        fireEvent.click(screen.getByRole('button', { name: /^Rapid beta/ }))
        await screen.findByText('Beta current')
        await waitFor(() => expect(readSignals[0]?.signal?.aborted).toBe(true))

        fireEvent.click(screen.getByRole('button', { name: /^Rapid alpha/ }))
        await screen.findByText('Alpha newest')
        await act(async () => { resolveOld!({ ok: true, result: alphaOld }) })
        await waitFor(() => expect(screen.queryByText('Stale alpha')).not.toBeInTheDocument())
        expect(screen.getByText('Alpha newest')).toBeInTheDocument()
        expect(alphaReads).toBe(2)
    })

    it('ignores wrong-identity normal, unchanged and older reads while retaining the current view', async () => {
        const current = conversation('identity-current', 'Correct content', { hasEarlier: true, before: 'cursor' })
        let reads = 0
        let olderReads = 0
        command.mockImplementation(async (value: Record<string, unknown>) => {
            if (value.op === 'models') return { ok: true, result: { models: [{ id: 'gpt-6.1-sol' }] } }
            if (value.op === 'model-settings') return { ok: true, result: { model: 'gpt-6.1-sol', reasoningEffort: 'high' } }
            if (value.op === 'list') return { ok: true, result: { threads: [threadEntry('identity-current', 'Identity current')] } }
            if (value.op === 'read' && value.before) {
                olderReads++
                return { ok: true, result: conversation('identity-other-older', 'Wrong older') }
            }
            if (value.op === 'read' && !value.itemKey) {
                reads++
                if (reads === 1) return { ok: true, result: current }
                if (reads === 2) return { ok: true, result: conversation('identity-other-normal', 'Wrong normal', { revision: 'two' }) }
                if (reads === 3) return { ok: true, result: { id: 'identity-other-unchanged', revision: 'three', unchanged: true } }
                return { ok: true, result: { id: 'identity-current', revision: 'one', unchanged: true } }
            }
            return { ok: true, result: current }
        })
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Identity current/ }))
        await screen.findByText('Correct content')

        await act(async () => { window.dispatchEvent(new Event('online')) })
        await waitFor(() => expect(reads).toBe(2))
        expect(await screen.findByText(identityError)).toBeInTheDocument()
        expect(screen.getByText('Correct content')).toBeInTheDocument()
        expect(screen.queryByText('Wrong normal')).not.toBeInTheDocument()

        await act(async () => { window.dispatchEvent(new Event('online')) })
        await waitFor(() => expect(reads).toBe(3))
        expect(screen.getByText(identityError)).toBeInTheDocument()
        expect(screen.getByText('Correct content')).toBeInTheDocument()
        expect(screen.queryByText('Wrong normal')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /更早的消息/ }))
        await waitFor(() => expect(olderReads).toBe(1))
        expect(await screen.findByText(identityError)).toBeInTheDocument()
        expect(screen.queryByText('Wrong older')).not.toBeInTheDocument()
        expect(screen.getByText('Correct content')).toBeInTheDocument()
    })

    it('keeps the current conversation across an online reconnect and rejects a delayed old response', async () => {
        const current = conversation('reconnect-current', 'Current content')
        const newest = conversation('reconnect-current', 'Newest content', { revision: 'two' })
        const other = conversation('reconnect-other', 'Other conversation')
        let currentReads = 0
        let resolveDelayed: ((value: unknown) => void) | undefined
        let delayedSignal: AbortSignal | undefined
        command.mockImplementation(async (value: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
            if (value.op === 'models') return { ok: true, result: { models: [{ id: 'gpt-6.1-sol' }] } }
            if (value.op === 'model-settings') return { ok: true, result: { model: 'gpt-6.1-sol', reasoningEffort: 'high' } }
            if (value.op === 'list') return { ok: true, result: { threads: [threadEntry('reconnect-current', 'Reconnect current'), threadEntry('reconnect-other', 'Reconnect other')] } }
            if (value.op === 'read' && !value.itemKey) {
                if (value.id === 'reconnect-other') return { ok: true, result: other }
                if (value.id === 'reconnect-current') {
                    currentReads++
                    if (currentReads === 1) return { ok: true, result: current }
                    if (currentReads === 2) {
                        delayedSignal = options?.signal
                        return new Promise(resolve => { resolveDelayed = resolve as (value: unknown) => void }) as never
                    }
                    return { ok: true, result: newest }
                }
            }
            return { ok: true, result: current }
        })
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Reconnect current/ }))
        await screen.findByText('Current content')

        await act(async () => { window.dispatchEvent(new Event('online')) })
        await waitFor(() => expect(currentReads).toBe(2))
        expect(screen.getByText('Current content')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /^Reconnect other/ }))
        await screen.findByText('Other conversation')
        await waitFor(() => expect(delayedSignal?.aborted).toBe(true))

        fireEvent.click(screen.getByRole('button', { name: /^Reconnect current/ }))
        await screen.findByText('Newest content')
        await act(async () => { resolveDelayed!({ ok: true, result: conversation('reconnect-current', 'Stale reconnect') }) })
        await waitFor(() => expect(screen.queryByText('Stale reconnect')).not.toBeInTheDocument())
        expect(screen.getByText('Newest content')).toBeInTheDocument()
    })

})
