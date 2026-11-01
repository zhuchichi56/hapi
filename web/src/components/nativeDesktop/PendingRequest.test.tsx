import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PendingRequest } from './PendingRequest'
afterEach(cleanup)
describe('original pending requests', () => {
    it('submits typed custom text only after the explicit send action', () => {
        const respond = vi.fn()
        const request = { id: 'native-request', request: { method: 'item/tool/requestUserInput', params: { questions: [
            { id: 'approach', question: 'Choose an approach', isOther: true, options: [{ label: 'Keep current', description: 'Preserve the current work' }] }
        ] } } }
        render(<PendingRequest request={request} disabled={false} respond={respond} />)
        expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
        expect(screen.getByPlaceholderText('或自行撰写回复')).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText('Choose an approach'), { target: { value: 'Adjust spacing' } })
        expect(respond).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: '发送' }))
        expect(respond).toHaveBeenCalledOnce()
        expect(respond).toHaveBeenCalledWith({ requestId: 'native-request', response: { answers: { approach: { answers: ['Adjust spacing'] } } } })
    })
    it('lets an option replace a custom draft so only the selected original label is submitted', () => {
        const respond = vi.fn()
        render(<PendingRequest request={{ id: 'replace-custom', method: 'item/tool/requestUserInput', questions: [{ id: 'approach', question: 'Choose an approach', isOther: true, options: [{ label: 'Keep current' }] }] }} disabled={false} respond={respond} />)
        fireEvent.change(screen.getByLabelText('Choose an approach'), { target: { value: 'Neither' } })
        fireEvent.click(screen.getByRole('radio', { name: 'Keep current' }))
        expect(screen.getByRole('radio', { name: 'Keep current' })).toBeChecked()
        expect(screen.getByLabelText('Choose an approach')).toHaveValue('')
        fireEvent.click(screen.getByRole('button', { name: '发送' }))
        expect(respond).toHaveBeenCalledWith({ requestId: 'replace-custom', response: { answers: { approach: { answers: ['Keep current'] } } } })
    })
    it('supports multiple questions, checkbox multi-select and free text when no options exist', () => {
        const respond = vi.fn()
        const request = { id: 'native-multi', method: 'item/tool/requestUserInput', questions: [
            { id: 'approach', question: 'Choose an approach', options: [{ label: 'Keep current' }, { label: 'Rewrite' }] },
            { id: 'checks', question: 'Choose checks', multiSelect: true, options: [{ label: 'Layout' }, { label: 'Images' }] },
            { id: 'detail', question: 'Extra detail' }
        ] }
        render(<PendingRequest request={request} disabled={false} respond={respond} />)
        fireEvent.click(screen.getByRole('radio', { name: 'Rewrite' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'Layout' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'Images' }))
        fireEvent.change(screen.getByLabelText('Extra detail'), { target: { value: 'Keep the original conversation' } })
        expect(screen.getByRole('checkbox', { name: 'Layout' })).toBeChecked()
        expect(screen.getByRole('checkbox', { name: 'Images' })).toBeChecked()
        fireEvent.click(screen.getByRole('button', { name: '发送' }))
        expect(respond).toHaveBeenCalledWith({ requestId: 'native-multi', response: { answers: {
            approach: { answers: ['Rewrite'] },
            checks: { answers: ['Layout', 'Images'] },
            detail: { answers: ['Keep the original conversation'] }
        } } })
    })
    it('sends the exact native Codex skip response with the original request identity', () => {
        const respond = vi.fn()
        render(<PendingRequest request={{ id: 'skip-request', method: 'item/tool/requestUserInput', questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }] }] }} disabled={false} respond={respond} />)
        fireEvent.click(screen.getByRole('button', { name: '跳过' }))
        expect(respond).toHaveBeenCalledOnce()
        expect(respond).toHaveBeenCalledWith({ requestId: 'skip-request', response: { answers: {} } })
    })
    it('submits native Claude multiple-choice answers without free text or skip', () => {
        const respond = vi.fn()
        render(<PendingRequest request={{ id: 'claude-question-real', method: 'native/claude/requestUserInput', questions: [{ id: '0', question: 'Choose checks', multiSelect: true, options: [{ label: 'Layout' }, { label: 'Images' }] }] }} disabled={false} respond={respond} />)
        expect(screen.queryByRole('button', { name: '跳过' })).toBeNull()
        expect(screen.queryByPlaceholderText('或自行撰写回复')).toBeNull()
        fireEvent.click(screen.getByRole('checkbox', { name: 'Layout' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'Images' }))
        fireEvent.click(screen.getByRole('button', { name: '发送' }))
        expect(respond).toHaveBeenCalledWith({ requestId: 'claude-question-real', response: { answers: { '0': { answers: ['Layout', 'Images'] } } } })
    })
    it('collapses and reopens locally without submitting or cancelling the native request', () => {
        const respond = vi.fn()
        render(<PendingRequest request={{ id: 'collapse-request', method: 'item/tool/requestUserInput', questions: [{ id: 'q', question: 'Pick one', options: [{ label: 'A' }] }] }} disabled={false} respond={respond} />)
        fireEvent.click(screen.getByRole('radio', { name: 'A' }))
        fireEvent.click(screen.getByRole('button', { name: '收起问题' }))
        expect(screen.queryByText('Pick one')).toBeNull()
        expect(respond).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: '展开问题' }))
        expect(screen.getByText('Pick one')).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'A' })).toBeChecked()
        expect(respond).not.toHaveBeenCalled()
    })
    it('resets selections, drafts and collapse state when the native request identity changes', () => {
        const respond = vi.fn()
        const questions = [{ id: 'approach', question: 'Choose an approach', isOther: true, options: [{ label: 'Keep current' }] }]
        const { rerender } = render(<PendingRequest request={{ id: 'request-one', method: 'item/tool/requestUserInput', questions }} disabled={false} respond={respond} />)
        fireEvent.click(screen.getByRole('radio', { name: 'Keep current' }))
        fireEvent.change(screen.getByLabelText('Choose an approach'), { target: { value: 'Old draft' } })
        fireEvent.click(screen.getByRole('button', { name: '收起问题' }))
        expect(screen.queryByText('Choose an approach')).toBeNull()
        rerender(<PendingRequest request={{ id: 'request-two', method: 'item/tool/requestUserInput', questions }} disabled={false} respond={respond} />)
        expect(screen.getByText('Choose an approach')).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Keep current' })).not.toBeChecked()
        expect(screen.getByLabelText('Choose an approach')).toHaveValue('')
        expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    })
    it('disables all question controls while busy', () => {
        render(<PendingRequest request={{ id: 'busy-request', method: 'item/tool/requestUserInput', questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }] }] }} disabled={true} respond={vi.fn()} />)
        expect(screen.getByRole('radio', { name: 'A' })).toBeDisabled()
        expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
        expect(screen.getByRole('button', { name: '跳过' })).toBeDisabled()
    })
    it('keeps exact original approval identities and respects pending-operation disabling', () => {
        const respond = vi.fn()
        const { rerender } = render(<PendingRequest request={{ requestId: 'approval-7', method: 'item/fileChange/requestApproval' }} disabled={true} respond={respond} />)
        expect(screen.getByRole('button', { name: '允许本次' })).toBeDisabled()
        rerender(<PendingRequest request={{ requestId: 'approval-7', method: 'item/fileChange/requestApproval' }} disabled={false} respond={respond} />)
        fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
        expect(respond).toHaveBeenCalledWith({ requestId: 'approval-7', decision: 'decline' })
    })
    it('keeps Claude approval button labels as the exact native response', () => {
        const respond = vi.fn()
        render(<PendingRequest request={{ id: 'native-ui-approval', method: 'native/approval', buttons: ['Allow once'] }} disabled={false} respond={respond} />)
        fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
        expect(respond).toHaveBeenCalledWith({ requestId: 'native-ui-approval', button: 'Allow once' })
        expect(screen.queryByRole('button', { name: '跳过' })).toBeNull()
    })
})
