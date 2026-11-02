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
import NativeDesktopPage, { pendingRequestKind } from './nativeDesktop'

const idleView = (id: string, title: string, status: unknown, requests: Record<string, unknown>[] = []) => ({
    id, title, status, live: true, historyComplete: true, hasEarlier: false, before: null, revision: 'one', windowStart: 1, requests, turns: [],
})

describe('sidebar waiting status', () => {
    it('does not turn unsupported request shapes into waiting states', () => {
        expect(pendingRequestKind({ method: 'untrusted/requestApproval' })).toBe('')
        expect(pendingRequestKind({ questions: [{ question: 'prose only' }] })).toBe('')
        expect(pendingRequestKind({ buttons: ['unrelated'] })).toBe('')
        expect(pendingRequestKind({ method: 'native/approval', buttons: ['Allow once'] })).toBe('approval')
    })

    beforeEach(() => { routing.search = { app: 'codex', thread: undefined }; command.mockReset() })
    afterEach(cleanup)

    it('prioritizes waitingOnApproval/Input and explicit pendingState over running, ignoring idle/completed', async () => {
        command.mockImplementation(async () => ({ ok: true, result: { threads: [
            { id: 'approval', title: 'Approval thread', status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
            { id: 'input', title: 'Input thread', status: { type: 'running', activeFlags: ['waitingOnUserInput'] } },
            { id: 'explicit', title: 'Explicit thread', status: 'completed', pendingState: 'approval' },
            { id: 'active', title: 'Active thread', status: 'active' },
            { id: 'idle', title: 'Idle thread', status: 'idle' },
            { id: 'completed', title: 'Completed thread', status: 'completed' },
        ] } }))
        render(<NativeDesktopPage />)
        await screen.findByText('Approval thread')
        const row = (title: string) => [...document.querySelectorAll<HTMLElement>('.nd-thread')].find(value => value.textContent?.includes(title))!
        expect(row('Approval thread').querySelector('.nd-thread-waiting')).toHaveTextContent('等待审批')
        expect(row('Approval thread').querySelector('.nd-thread-waiting')).toHaveAttribute('data-kind', 'approval')
        expect(row('Approval thread').querySelector('.nd-thread-indicator')).toBeNull()
        expect(row('Input thread').querySelector('.nd-thread-waiting')).toHaveTextContent('需要输入')
        expect(row('Explicit thread').querySelector('.nd-thread-waiting')).toHaveTextContent('等待审批')
        expect(row('Active thread').querySelector('.nd-thread-waiting')).toBeNull()
        expect(row('Active thread').querySelector('.nd-thread-indicator')).toHaveAttribute('data-active', 'true')
        expect(row('Idle thread').querySelector('.nd-thread-waiting')).toBeNull()
        expect(row('Completed thread').querySelector('.nd-thread-waiting')).toBeNull()
    })

    it('uses valid selected-view requests as fallback and clears the wait after a refreshed/reconnect status', async () => {
        let state = idleView('wait-thread', 'Wait thread', 'idle', [{ id: 'r1', method: 'item/commandExecution/requestApproval' }])
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'wait-thread', title: 'Wait thread', status: 'idle' }] }
            : state
        }))
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Wait thread/ }))
        expect(await screen.findByText('等待审批')).toBeInTheDocument()
        state = idleView('wait-thread', 'Wait thread', { type: 'active', activeFlags: [] }, [])
        act(() => { window.dispatchEvent(new Event('online')) })
        await waitFor(() => expect(screen.queryByText('等待审批')).toBeNull())
        expect(document.querySelector('.nd-thread-indicator[data-active=true]')).not.toBeNull()
    })

    it('recognizes valid input request questions', async () => {
        const view = idleView('input-thread', 'Input thread', 'idle', [{ id: 'q1', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', question: 'Pick one' }] } }])
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'input-thread', title: 'Input thread', status: 'idle' }] }
            : view
        }))
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Input thread/ }))
        expect(await screen.findByText('需要输入')).toBeInTheDocument()
    })
    it('clears stale sidebar-list waiting immediately when the selected live view confirms resolution', async () => {
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'resolved-thread', title: 'Resolved thread', status: 'active', pendingState: 'approval' }] }
            : { ...idleView('resolved-thread', 'Resolved thread', 'active'), activeFlags: [], pendingState: null }
        }))
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Resolved thread/ }))
        await waitFor(() => expect(document.querySelector('.nd-thread[aria-current=true]')).not.toBeNull())
        await waitFor(() => expect(screen.queryByText('等待审批')).toBeNull())
        expect(document.querySelector('.nd-thread-indicator[data-active=true]')).not.toBeNull()
    })

})
