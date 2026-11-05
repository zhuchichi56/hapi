import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { questionReplyId, questionReplyText, type AsyncQuestion } from '@/components/nativeDesktop/questionReply'

type Item = { id: string; key: string; role: string; text: string; delivery?: string; questions?: AsyncQuestion[]; questionReplies?: { questionItemId: string; question: string; answer: string }[]; questionAnswers?: (string | null)[] }
const view = (id: string, items: Item[]) => ({
    id, title: 'Async question chat', status: 'active', live: true, historyComplete: true,
    hasEarlier: false, before: null, revision: 'one', windowStart: 0, requests: [],
    turns: [{ id: `turn-${id}`, status: 'inProgress', items }],
})

function install(thread: ReturnType<typeof view>, send: (value: Record<string, unknown>) => unknown = async () => ({ ok: true, result: {} })) {
    routing.search = { app: 'codex', thread: thread.id }
    command.mockImplementation(async (value: Record<string, unknown>) => {
        if (value.op === 'list') return { ok: true, result: { threads: [{ id: thread.id, title: thread.title, status: 'idle' }] } }
        if (value.op === 'send') return send(value)
        if (value.op === 'read' && value.since) return { ok: true, result: { id: thread.id, revision: 'one', unchanged: true } }
        if (value.op === 'read') return { ok: true, result: thread }
        return { ok: true, result: {} }
    })
    return render(<NativeDesktopPage />)
}

const sendButton = () => within(screen.getByRole('region', { name: '问题' })).getByRole('button', { name: '发送' })

describe('Codex async question card', () => {
    beforeEach(() => {
        command.mockReset()
        routing.search = { app: 'codex', thread: undefined }
        localStorage.clear(); sessionStorage.clear()
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    })
    afterEach(cleanup)

    it('sends the original App reply envelope only after an explicit click and keeps the normal draft and images', async () => {
        const questions: AsyncQuestion[] = [{ title: 'Which one?', options: ['A', 'B'] }]
        const thread = view('async-single', [
            { id: 'item-async-1', key: 'item-async-1', role: 'assistant', text: 'Original question text with A and B', delivery: 'async', questions },
        ])
        const send = vi.fn(async (_value: Record<string, unknown>) => ({ ok: true, result: {} }))
        install(thread, send)
        await screen.findByText('Which one?')
        expect(screen.queryByText('Original question text with A and B')).toBeNull()
        expect(sendButton()).toBeDisabled()

        const composer = screen.getByRole('textbox', { name: '消息' })
        fireEvent.change(composer, { target: { value: 'Unsent normal draft' } })
        fireEvent.change(screen.getByLabelText(/^选择(?:图片|附件)$/), { target: { files: [new File(['image'], 'draft.png', { type: 'image/png' })] } })
        await screen.findByAltText('draft.png')

        fireEvent.click(screen.getByRole('radio', { name: 'A' }))
        expect(send).not.toHaveBeenCalled()
        expect(sendButton()).toBeEnabled()
        fireEvent.click(sendButton())

        await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
        const text = String(send.mock.calls[0][0].text)
        expect(text).toBe(questionReplyText('item-async-1', questions, ['A']))
        expect(text).toBe('<send_user_message_question_reply>\n' + JSON.stringify([{
            questionItemId: questionReplyId('item-async-1', 0),
            question: 'Which one?',
            answer: 'A',
        }]) + '\n</send_user_message_question_reply>')
        expect(composer).toHaveValue('Unsent normal draft')
        expect(screen.getByAltText('draft.png')).toBeInTheDocument()
        await screen.findByText('已发送，等待原会话更新')
    })

    it('supports free input and multiple questions without auto-submitting', async () => {
        const questions: AsyncQuestion[] = [{ title: 'First', options: ['A', 'B'] }, { title: 'Second' }]
        const thread = view('async-multi', [
            { id: 'item-async-multi', key: 'item-async-multi', role: 'assistant', text: 'Ignored source text', delivery: 'async', questions },
        ])
        const send = vi.fn(async (_value: Record<string, unknown>) => ({ ok: true, result: {} }))
        install(thread, send)
        await screen.findByText('First')
        expect(screen.getByText('1/2')).toBeInTheDocument()
        expect(screen.getByText('2/2')).toBeInTheDocument()
        expect(sendButton()).toBeDisabled()

        fireEvent.click(screen.getByRole('radio', { name: 'A' }))
        expect(sendButton()).toBeDisabled()
        const custom = screen.getByRole('textbox', { name: 'Second 自定义回答' })
        fireEvent.change(custom, { target: { value: 'Custom B' } })
        expect(send).not.toHaveBeenCalled()
        expect(sendButton()).toBeEnabled()
        fireEvent.click(sendButton())

        await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
        const text = String(send.mock.calls[0][0].text)
        expect(text).toBe(questionReplyText('item-async-multi', questions, ['A', 'Custom B']))
        const body = text.slice('<send_user_message_question_reply>\n'.length, -'\n</send_user_message_question_reply>'.length)
        expect(JSON.parse(body)).toEqual([
            { questionItemId: questionReplyId('item-async-multi', 0), question: 'First', answer: 'A' },
            { questionItemId: questionReplyId('item-async-multi', 1), question: 'Second', answer: 'Custom B' },
        ])
    })

    it('skips locally without sending a user message and can reopen the card', async () => {
        const thread = view('async-skip', [
            { id: 'item-skip', key: 'item-skip', role: 'assistant', text: 'Skip source', delivery: 'async', questions: [{ title: 'Skip me?', options: ['Yes'] }] },
        ])
        const send = vi.fn(async () => ({ ok: true, result: {} }))
        install(thread, send)
        await screen.findByText('Skip me?')
        fireEvent.click(screen.getByRole('button', { name: '跳过' }))
        expect(send).not.toHaveBeenCalled()
        expect(screen.getByText('已跳过 · 未发送')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: '重新打开' }))
        expect(screen.getByText('Skip me?')).toBeInTheDocument()
    })

    it('keeps the card retryable after a definite failure and preserves the choice', async () => {
        const thread = view('async-fail', [
            { id: 'item-fail', key: 'item-fail', role: 'assistant', text: 'Failure source', delivery: 'async', questions: [{ title: 'Try again?', options: ['A'] }] },
        ])
        const send = vi.fn(async () => ({ ok: false, error: '原会话拒绝了回答' }))
        install(thread, send)
        await screen.findByText('Try again?')
        fireEvent.click(screen.getByRole('radio', { name: 'A' }))
        fireEvent.click(screen.getByRole('button', { name: '发送' }))
        await screen.findByText('原会话拒绝了回答')
        expect(screen.getByRole('radio', { name: 'A' })).toBeChecked()
        expect(screen.getByText('发送失败，请稍后重试')).toBeInTheDocument()
        expect(screen.queryByText('已回答')).toBeNull()
        expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('does not auto-resend when the native reply delivery is unknown', async () => {
        const thread = view('async-unknown', [
            { id: 'item-unknown', key: 'item-unknown', role: 'assistant', text: 'Unknown source', delivery: 'async', questions: [{ title: 'Maybe?', options: ['A'] }] },
        ])
        const send = vi.fn(async () => ({ ok: false, error: 'Desktop request timed out', delivery: 'unknown' }))
        install(thread, send)
        await screen.findByText('Maybe?')
        fireEvent.click(screen.getByRole('radio', { name: 'A' }))
        fireEvent.click(screen.getByRole('button', { name: '发送' }))
        await screen.findByText('结果未确认')
        expect(screen.getByText('提交结果暂未确认，请先查看原会话，避免重复发送。')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
        await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
        expect(command.mock.calls.filter(([value]) => value.op === 'send')).toHaveLength(1)
    })

    it('shows an answered history card from the canonical wrapper and does not render the wrapper as user prose', async () => {
        const questions: AsyncQuestion[] = [{ title: 'Which one?', options: ['A', 'B'] }]
        const reply = questionReplyText('item-answered', questions, ['A'])
        const thread = view('async-answered', [
            { id: 'item-answered', key: 'item-answered', role: 'assistant', text: 'Original answered source', delivery: 'async', questions },
            { id: 'user-answered', key: 'user-answered', role: 'user', text: reply },
        ])
        const send = vi.fn(async () => ({ ok: true, result: {} }))
        install(thread, send)
        await screen.findByText('已回答')
        expect(screen.queryByText('Original answered source')).toBeNull()
        expect(screen.queryByText(reply)).toBeNull()
        expect(screen.queryByText(/send_user_message_question_reply/)).toBeNull()
        const details = screen.getByText('已回答').closest('details')!
        details.open = true
        fireEvent(details, new Event('toggle'))
        expect(screen.getByText('Which one?')).toBeInTheDocument()
        expect(screen.getByText('回答：A')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
        expect(send).not.toHaveBeenCalled()
    })

    it('accepts bridge questionReplies metadata for an answered card', async () => {
        const questions: AsyncQuestion[] = [{ title: 'Bridge answer?', options: ['Yes', 'No'] }]
        const thread = view('async-bridge-replies', [
            {
                id: 'item-bridge', key: 'item-bridge', role: 'assistant', text: 'Bridge source', delivery: 'async', questions,
                questionReplies: [{ questionItemId: questionReplyId('item-bridge', 0), question: 'Bridge answer?', answer: 'No' }],
            },
        ])
        install(thread)
        await screen.findByText('已回答')
        const details = screen.getByText('已回答').closest('details')!
        details.open = true
        fireEvent(details, new Event('toggle'))
        expect(screen.getByText('回答：No')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    })

    it('does not infer an answer from an ordinary subsequent user message', async () => {
        const thread = view('async-ordinary-user', [
            { id: 'item-ordinary', key: 'item-ordinary', role: 'assistant', text: 'Ordinary follow source', delivery: 'async', questions: [{ title: 'Still pending?', options: ['A'] }] },
            { id: 'ordinary-user', key: 'ordinary-user', role: 'user', text: 'A separate normal message' },
        ])
        const send = vi.fn(async () => ({ ok: true, result: {} }))
        install(thread, send)
        await screen.findByText('Still pending?')
        expect(screen.queryByText('已回答')).toBeNull()
        expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument()
        expect(screen.getByText('A separate normal message')).toBeInTheDocument()
    })

    it('does not turn a normal assistant message or malformed async metadata into a question card', async () => {
        const thread = view('async-normal', [
            { id: 'normal-message', key: 'normal-message', role: 'assistant', text: 'Ordinary assistant answer', questions: [{ title: 'Not a card' }] },
            { id: 'malformed-async', key: 'malformed-async', role: 'assistant', text: 'Malformed source', delivery: 'async', questions: [{ title: '' }] },
        ])
        install(thread)
        await screen.findByText('Ordinary assistant answer')
        expect(screen.getByText('Malformed source')).toBeInTheDocument()
        expect(screen.queryByText('Not a card')).toBeNull()
        expect(screen.queryByRole('region', { name: '问题' })).toBeNull()
    })

    it('disables an unanswered card when the selected conversation loses its connection', async () => {
        const thread = view('async-offline', [
            { id: 'item-offline', key: 'item-offline', role: 'assistant', text: 'Offline source', delivery: 'async', questions: [{ title: 'Offline?', options: ['A'] }] },
        ])
        install(thread)
        await screen.findByText('Offline?')
        const original = command.getMockImplementation()!
        let fail = false
        command.mockImplementation(async (value: Record<string, unknown>) => value.op === 'read' && !value.itemKey && fail
            ? { ok: false, error: 'Original chat unavailable' }
            : original(value))
        fail = true
        for (let index = 0; index < 2; index++) {
            await act(async () => { window.dispatchEvent(new Event('online')) })
        }
        await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeDisabled())
        expect(screen.getByText('原会话实时连接不可用，暂不能发送')).toBeInTheDocument()
    })

    it('does not send an unanswered question from a completed turn', async () => {
        const thread = view('async-complete', [
            { id: 'item-old', key: 'item-old', role: 'assistant', text: 'Old question', delivery: 'async', questions: [{ title: 'Old?', options: ['A'] }] },
        ])
        thread.turns[0].status = 'completed'
        install(thread)
        await screen.findByText('Old?')
        expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
        expect(screen.getByText('此轮已结束，无法回答')).toBeInTheDocument()
    })

    it('recovers answers when the original reply is outside the displayed page', async () => {
        const thread = view('async-paged', [
            { id: 'item-paged', key: 'item-paged', role: 'assistant', text: 'Paged question', delivery: 'async', questions: [{ title: 'Paged?', options: ['A'] }], questionAnswers: ['A'] },
        ])
        install(thread)
        await screen.findByText('已回答')
        expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    })
})
