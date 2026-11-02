import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
vi.mock('@/components/nativeDesktop/attachments', async () => {
    const actual = await vi.importActual<typeof import('@/components/nativeDesktop/attachments')>('@/components/nativeDesktop/attachments')
    return { ...actual, prepareImage: async (file: File) => ({ name: file.name, data: 'data:image/png;base64,aW1hZ2U=' }) }
})
vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }))
import NativeDesktopPage from './nativeDesktop'

const pureA = '<heartbeat><automation_id>check-a</automation_id><decision>DONT_NOTIFY</decision></heartbeat>'
const pureB = '<heartbeat><automation_id>check-b</automation_id><current_time_iso>2026-10-10T13:28:19.329Z</current_time_iso><instructions>继续按原任务核对。</instructions></heartbeat>'
const pureC = '<heartbeat><automation_id>check-c</automation_id><decision>DONT_NOTIFY</decision></heartbeat>'
const pureD = '<heartbeat><automation_id>check-d</automation_id><decision>DONT_NOTIFY</decision></heartbeat>'
const notify = '<heartbeat><automation_id>notify-check</automation_id><decision>NOTIFY</decision><message>任务已完成，请查看结果。</message></heartbeat>'

const view = {
    id: 'heartbeat-thread', title: 'Heartbeat thread', status: 'idle', live: true, historyComplete: true,
    hasEarlier: false, before: null, revision: 'one', windowStart: 1, requests: [],
    turns: [
        { id: 'check-1', status: 'completed', items: [{ id: 'a', key: 'check-a-item', role: 'user', text: pureA }] },
        { id: 'check-blank', status: 'completed', items: [{ id: 'blank', key: 'blank-item', role: 'assistant', text: ' \n\t' }] },
        { id: 'check-2', status: 'completed', items: [{ id: 'b', key: 'check-b-item', role: 'user', text: pureB }] },
        { id: 'notify-turn', status: 'completed', items: [{ id: 'n', key: 'notify-item', role: 'user', text: notify }] },
        { id: 'mixed-user-turn', status: 'completed', items: [{ id: 'mixed', key: 'mixed-user-item', role: 'user', text: `用户补充说明\n${pureC}` }] },
        { id: 'empty-tool-turn', status: 'completed', items: [{ id: 'empty-tool', key: 'empty-tool-item', role: 'tool', text: ' \n', status: 'completed' }] },
        { id: 'meaningful-turn', status: 'active', items: [
            { id: 'm', key: 'meaningful-item', role: 'assistant', text: 'Normal reply' },
            { id: 't', key: 'meaningful-tool', role: 'tool', text: 'Bash tool', status: 'running' },
        ] },
        { id: 'check-3', status: 'completed', items: [{ id: 'c', key: 'check-c-item', role: 'user', text: pureD }] },
        { id: 'truncated-turn', status: 'completed', items: [{ id: 'tr', key: 'truncated-item', role: 'assistant', text: '', textTruncated: true }] },
    ],
}

describe('heartbeat conversation grouping', () => {
    beforeEach(() => {
        routing.search = { app: 'codex', thread: undefined }
        command.mockReset()
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'heartbeat-thread', title: 'Heartbeat thread', status: 'idle' }] }
            : value.op === 'read' && value.itemKey ? { item: { id: 'tool', key: String(value.itemKey), role: 'tool', text: 'Bash tool', output: 'detail' } }
            : value.since ? { id: 'heartbeat-thread', revision: 'one', unchanged: true }
            : view
        }))
    })
    afterEach(cleanup)

    it('merges adjacent pure checks across empty placeholders and turns without crossing real content', async () => {
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Heartbeat thread/ }))
        await screen.findByText('Normal reply')

        const rows = [...document.querySelectorAll<HTMLDetailsElement>('.nd-heartbeat')]
        expect(rows).toHaveLength(4)
        expect(rows[0].querySelector('.nd-heartbeat-count')).toHaveTextContent('×2')
        expect(rows[1]).toHaveTextContent('任务已完成，请查看结果。')
        expect(rows[2]).toHaveTextContent('无需提醒')
        expect(rows[3]).not.toHaveTextContent('Normal reply')
        expect(document.querySelectorAll('.nd-message')).toHaveLength(4)
        expect(screen.getByText('用户补充说明')).toBeInTheDocument()
        expect(screen.getByText('展开全文')).toBeInTheDocument()
        expect(screen.getByText('正在使用工具')).toBeInTheDocument()
        expect(document.querySelectorAll('.nd-activity')).toHaveLength(1)
        expect(command.mock.calls.some(([value]) => value.itemKey)).toBe(false)
    })

    it('mounts raw instructions and automation IDs only when the merged row is expanded', async () => {
        render(<NativeDesktopPage />)
        fireEvent.click(await screen.findByRole('button', { name: /^Heartbeat thread/ }))
        await screen.findByText('Normal reply')
        const row = document.querySelector<HTMLDetailsElement>('.nd-heartbeat')!
        expect(row.querySelector('pre')).toBeNull()
        expect(row).not.toHaveTextContent('check-a')
        expect(row).not.toHaveTextContent('check-b')
        row.open = true
        fireEvent(row, new Event('toggle'))
        const raw = [...row.querySelectorAll('pre')].map(value => value.textContent)
        expect(raw).toEqual([pureA, pureB])
        expect(row).toHaveTextContent('check-a')
        expect(row).toHaveTextContent('check-b')
        expect(row).toHaveTextContent('继续按原任务核对。')
    })
})
