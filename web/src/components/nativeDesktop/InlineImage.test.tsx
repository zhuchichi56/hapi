import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InlineImage } from './InlineImage'
beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('small native image previews', () => {
    it('loads a referenced local thumbnail and expands only after a click', async () => {
        const load = vi.fn().mockResolvedValue('data:image/jpeg;base64,test')
        render(<InlineImage src="/Users/test/preview.png" alt="A small preview" load={load} />)
        const img = await screen.findByAltText('A small preview')
        expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,test')
        expect(load).toHaveBeenCalledWith('/Users/test/preview.png')
        const button = screen.getByRole('button')
        expect(button).toHaveAttribute('aria-expanded', 'false')
        fireEvent.click(button)
        expect(button).toHaveAttribute('aria-expanded', 'true')
    })
    it('shows a readable placeholder for a deleted image instead of a broken image', async () => {
        render(<InlineImage src="/Users/test/deleted.png" alt="Deleted preview" load={vi.fn().mockRejectedValue(Error('gone'))} />)
        await screen.findByText(/预览不可用/)
        expect(document.querySelector('img')).toBeNull()
    })
})
