import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { command, upload, api } = vi.hoisted(() => {
    const command = vi.fn()
    const upload = vi.fn()
    return { command, upload, api: { nativeDesktopCommand: command, nativeDesktopUpload: upload } }
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

const canonical = '[ZIP 附件] Archive.ZIP\n大小：1.2 KB\n本机路径：/tmp/archive.zip'
const view = { id: 'original', title: 'Original desktop chat', status: 'idle', live: true, historyComplete: true, hasEarlier: false, before: null, revision: 'one', windowStart: 0, requests: [], turns: [] }
const zipFile = () => new File(['zip-bytes'], 'Archive.ZIP', { type: 'application/zip' })

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason?: unknown) => void
    const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
    return { promise, resolve, reject }
}

describe('native Desktop ZIP attachments', () => {
    let synced: boolean
    beforeEach(() => {
        routing.search = { app: 'codex', thread: 'original' }
        sessionStorage.clear()
        command.mockReset(); upload.mockReset()
        synced = false
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'original', title: 'Original desktop chat', status: 'idle' }, { id: 'other', title: 'Other desktop chat', status: 'idle' }] }
            : value.op === 'read' ? (value.id === 'other' ? { ...view, id: 'other', title: 'Other desktop chat' } : {
                ...view,
                revision: synced ? 'two' : 'one',
                turns: synced ? [{ id: 'zip-turn', status: 'completed', items: [{ id: 'zip-user', key: 'zip-user', role: 'user', text: canonical }] }] : [],
            })
            : value.op === 'send' ? { threadId: 'original', native: true }
            : {}
        }))
        upload.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', name: 'Archive.ZIP', size: 1234, canonicalText: canonical })
    })
    afterEach(cleanup)

    it('previews, uploads and sends a ZIP-only attachment without auto-sending', async () => {
        render(<NativeDesktopPage />)
        await screen.findByRole('button', { name: /^Original desktop chat/ })
        fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [zipFile()] } })
        await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
        await screen.findByText('Archive.ZIP')
        expect(screen.getByText(/1\.2 KB/)).toBeInTheDocument()
        expect(command.mock.calls.some(([value]) => value.op === 'send')).toBe(false)
        const send = screen.getByRole('button', { name: '发送消息' })
        expect(send).toBeEnabled()
        fireEvent.click(send)
        await waitFor(() => expect(command.mock.calls.some(([value]) => value.op === 'send')).toBe(true))
        const sent = command.mock.calls.find(([value]) => value.op === 'send')![0]
        expect(sent).toMatchObject({ id: 'original', text: '', attachmentIds: ['11111111-1111-4111-8111-111111111111'] })
        expect(sent).not.toHaveProperty('canonicalText')
        await waitFor(() => expect(document.querySelectorAll('.nd-zip-preview')).toHaveLength(0))
        expect(screen.queryByRole('button', { name: '移除附件 Archive.ZIP' })).toBeNull()
    })

    it('acknowledges ZIP-only canonical input without duplicate pending bubbles', async () => {
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'original', title: 'Original desktop chat', status: 'idle' }] }
            : value.op === 'read' ? { ...view, revision: synced ? 'two' : 'one', turns: synced ? [{ id: 'zip-turn', status: 'completed', items: [{ id: 'zip-user', key: 'zip-user', role: 'user', text: canonical }] }] : [] }
            : value.op === 'send' ? { threadId: 'original', native: true }
            : {}
        }))
        render(<NativeDesktopPage />)
        await screen.findByRole('button', { name: /^Original desktop chat/ })
        fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [zipFile()] } })
        await screen.findByRole('button', { name: '移除附件 Archive.ZIP' })
        fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
        await waitFor(() => expect(document.querySelectorAll('.nd-pending')).toHaveLength(1))
        expect(document.querySelector('.nd-pending')?.textContent).toContain('Archive.ZIP')
        synced = true
        await act(async () => { window.dispatchEvent(new Event('online')) })
        await waitFor(() => expect(document.querySelectorAll('.nd-pending')).toHaveLength(0))
        expect(command.mock.calls.filter(([value]) => value.op === 'send')).toHaveLength(1)
    })

    it('disables sending while uploading and keeps a human-readable upload error', async () => {
        const pending = deferred<unknown>()
        upload.mockReturnValue(pending.promise)
        render(<NativeDesktopPage />)
        await screen.findByRole('button', { name: /^Original desktop chat/ })
        fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [zipFile()] } })
        await screen.findByText(/上传中/)
        expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
        expect(command.mock.calls.some(([value]) => value.op === 'send')).toBe(false)
        await act(async () => {
            pending.reject(Object.assign(Error('HTTP 400'), { status: 400, body: JSON.stringify({ error: 'ZIP 文件格式无效' }) }))
        })
        await screen.findByText('ZIP 文件格式无效')
        expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: '移除附件 Archive.ZIP' }))
        expect(screen.queryByText('ZIP 文件格式无效')).toBeNull()
        expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
    })

    it('keeps an in-flight upload in its original draft after navigating away', async () => {
        const pending = deferred<unknown>()
        upload.mockReturnValue(pending.promise)
        render(<NativeDesktopPage />)
        await screen.findByRole('button', { name: /^Original desktop chat/ })
        fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [zipFile()] } })
        await screen.findByText(/上传中/)
        fireEvent.click(screen.getByRole('button', { name: /^Other desktop chat/ }))
        await screen.findByRole('button', { name: '发送消息' })
        expect(document.querySelectorAll('.nd-zip-preview')).toHaveLength(0)
        await act(async () => { pending.resolve({ id: '11111111-1111-4111-8111-111111111111', name: 'Archive.ZIP', size: 1234, canonicalText: canonical }) })
        expect(document.querySelectorAll('.nd-zip-preview')).toHaveLength(0)
        fireEvent.click(screen.getByRole('button', { name: /^Original desktop chat/ }))
        await screen.findByText('Archive.ZIP')
        expect(document.querySelectorAll('.nd-zip-preview')).toHaveLength(1)
        expect(command.mock.calls.some(([value]) => value.op === 'send')).toBe(false)
    })

    it('accepts drag-and-drop ZIPs and enforces four combined attachments', async () => {
        upload.mockImplementation(async (file: File) => ({ id: crypto.randomUUID(), name: file.name, size: file.size, canonicalText: `canonical:${file.name}` }))
        render(<NativeDesktopPage />)
        await screen.findByRole('button', { name: /^Original desktop chat/ })
        const form = document.querySelector('form.nd-compose')!
        fireEvent.drop(form, { dataTransfer: { files: [new File(['a'], 'one.zip'), new File(['b'], 'two.ZIP')], types: ['Files'] } })
        await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
        await screen.findByText('one.zip')
        expect(screen.getByText('two.ZIP')).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [new File(['c'], 'three.zip'), new File(['d'], 'four.zip'), new File(['e'], 'five.zip')] } })
        await screen.findByText('每条消息最多附加 4 个附件')
        expect(upload).toHaveBeenCalledTimes(2)
    })

    it('preserves a ZIP draft and its files when send fails', async () => {
        command.mockImplementation(async (value: Record<string, unknown>) => {
            if (value.op === 'send') throw Object.assign(Error('HTTP 503'), { status: 503, body: JSON.stringify({ error: '原会话暂时未能加载，消息尚未发送，请稍后重试' }) })
            return { ok: true, result: value.op === 'list' ? { threads: [{ id: 'original', title: 'Original desktop chat', status: 'idle' }] } : value.op === 'read' ? view : {} }
        })
        render(<NativeDesktopPage />)
        await screen.findByRole('button', { name: /^Original desktop chat/ })
        fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: 'Read this archive' } })
        fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [zipFile()] } })
        await screen.findByRole('button', { name: '移除附件 Archive.ZIP' })
        fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
        await screen.findByText('原会话暂时未能加载，消息尚未发送，请稍后重试')
        expect(screen.getByRole('textbox', { name: '消息' })).toHaveValue('Read this archive')
        expect(screen.getByRole('button', { name: '移除附件 Archive.ZIP' })).toBeInTheDocument()
        expect(document.querySelectorAll('.nd-pending')).toHaveLength(0)
        expect(command.mock.calls.filter(([value]) => value.op === 'send')).toHaveLength(1)
    })
})
