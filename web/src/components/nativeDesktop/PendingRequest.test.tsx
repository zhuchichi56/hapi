import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PendingRequest } from './PendingRequest'
afterEach(cleanup)
describe('original pending requests', () => {
    it('submits native question IDs and answers while retaining approval choices', () => {
        const respond = vi.fn()
        const request = { id: 'native-request', request: { method: 'item/tool/requestUserInput', params: { questions: [
            { id: 'approach', question: 'Choose an approach', isOther: true, options: [{ label: 'Keep current', description: 'Preserve the current work' }] },
            { id: 'detail', question: 'Extra detail' }
        ] } } }
        render(<PendingRequest request={request} disabled={false} respond={respond} />)
        expect(screen.getByRole('button', { name: '提交回答' })).toBeDisabled()
        fireEvent.click(screen.getByRole('radio', { name: '自定义回答' }))
        fireEvent.change(screen.getByLabelText('Choose an approach'), { target: { value: 'Adjust spacing' } })
        fireEvent.change(screen.getByLabelText('Extra detail'), { target: { value: 'Keep the original conversation' } })
        fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
        expect(respond).toHaveBeenCalledOnce()
        expect(respond).toHaveBeenCalledWith({ requestId: 'native-request', response: { answers: { approach: { answers: ['Adjust spacing'] }, detail: { answers: ['Keep the original conversation'] } } } })
        expect(screen.queryByText(/请求详情/)?.closest('details')).not.toHaveAttribute('open')
    })
    it('keeps exact original approval identities and respects pending-operation disabling', () => {
        const respond = vi.fn()
        const { rerender } = render(<PendingRequest request={{ requestId: 'approval-7', method: 'item/fileChange/requestApproval' }} disabled={true} respond={respond} />)
        expect(screen.getByRole('button', { name: '允许本次' })).toBeDisabled()
        rerender(<PendingRequest request={{ requestId: 'approval-7', method: 'item/fileChange/requestApproval' }} disabled={false} respond={respond} />)
        fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
        expect(respond).toHaveBeenCalledWith({ requestId: 'approval-7', decision: 'decline' })
    })
})
