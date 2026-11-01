import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FileChanges } from './FileChanges'
afterEach(cleanup)
it('collects repeated native file changes into one final panel and reads original diffs only on demand', async () => {
    const call = vi.fn(async () => ({item: {output: JSON.stringify([{path: '/project/a.ts', diff: '+added\n-removed'}])}}))
    const items = [{key: 'original-1', files: [{path: '/project/a.ts', additions: 2, deletions: 1}]}, {key: 'original-2', files: [{path: '/project/a.ts', additions: 3, deletions: 0}, {path: '/project/b.ts'}]}]
    render(<FileChanges items={items} id="original" call={call as never} />)
    expect(screen.getAllByText('a.ts')).toHaveLength(1)
    expect(screen.getByText('+5')).toBeInTheDocument()
    expect(call).not.toHaveBeenCalled()
    const details = screen.getByText(/查看更改/).closest('details')!
    details.open = true; fireEvent(details, new Event('toggle'))
    await screen.findAllByText('+added')
    expect(call.mock.calls).toHaveLength(2)
})
