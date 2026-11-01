import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FileChanges } from './FileChanges'
afterEach(cleanup)
it('collects repeated native file changes into one final panel and reads original diffs only on demand', async () => {
    const call = vi.fn(async () => ({ item: { output: JSON.stringify([{ path: '/project/a.ts', diff: '+added\n-removed' }]) } }))
    const items = [{ key: 'original-1', files: [{ path: '/project/a.ts', additions: 2, deletions: 1 }] }, { key: 'original-2', files: [{ path: '/project/a.ts', additions: 3, deletions: 0 }, { path: '/project/b.ts' }, { path: '/project/c.ts', additions: 4, deletions: 1 }] }]
    render(<FileChanges items={items} id="original" call={call as never} />)
    expect(screen.getAllByText('a.ts')).toHaveLength(1)
    expect(screen.queryByRole('group', { name: '新增 9 行，删除 2 行' })).toBeNull()
    expect(screen.getByText('+5')).toBeInTheDocument()
    expect(call).not.toHaveBeenCalled()
    const details = screen.getByText(/查看更改/).closest('details')!
    details.open = true; fireEvent(details, new Event('toggle'))
    await screen.findAllByText('+added')
    expect(call.mock.calls).toHaveLength(2)
})
it('shows exactly the first three unique files and reveals the remaining five', () => {
    const files = Array.from({ length: 8 }, (_, index) => ({ path: `/project/src/file-${index + 1}.ts`, additions: 90, deletions: 1 }))
    render(<FileChanges items={[{ key: 'files', files }]} id="original" call={vi.fn() as never} />)
    expect(screen.getByText('已编辑 8 个文件')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '新增 720 行，删除 8 行' })).toHaveTextContent('+720')
    expect(screen.getByText('file-1.ts')).toBeInTheDocument()
    expect(screen.getByText('file-3.ts')).toBeInTheDocument()
    expect(screen.queryByText('file-4.ts')).toBeNull()
    expect(screen.getAllByText(/^\+90$/)).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: /再显示 5 个文件/ }))
    expect(screen.getByText('file-8.ts')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /再显示/ })).toBeNull()
    expect(screen.getAllByText(/^\+90$/)).toHaveLength(8)
})
it('de-duplicates exact repeated original item keys instead of doubling counts', () => {
    const item = { key: 'same-original-item', files: [{ path: '/project/repeated.ts', additions: 2, deletions: 1 }] }
    render(<FileChanges items={[item, { ...item }, { ...item }]} id="original" call={vi.fn() as never} />)
    expect(screen.getByText('已编辑 1 个文件')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '新增 2 行，删除 1 行' })).toBeInTheDocument()
    expect(screen.queryByText('+6')).toBeNull()
    expect(screen.getAllByText('repeated.ts')).toHaveLength(1)
})
it('keeps unknown original counts unknown instead of inventing zero totals', () => {
    render(<FileChanges items={[{ key: 'counted', files: [{ path: '/project/known.ts', additions: 3, deletions: 1 }] }, { key: 'unknown', files: [{ path: '/project/unknown.ts' }] }]} id="original" call={vi.fn() as never} />)
    expect(screen.getByText('已编辑 2 个文件')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '新增 3 行，删除 1 行' })).toBeNull()
    expect(screen.queryByText('+0')).toBeNull()
    expect(screen.queryByText('−0')).toBeNull()
    expect(screen.getAllByText('+3')).toHaveLength(1)
})
it('does not mount lazy diff readers until the details summary is opened', () => {
    const call = vi.fn()
    render(<FileChanges items={[{ key: 'one', files: [{ path: '/project/lazy.ts', additions: 1 }] }]} id="original" call={call as never} />)
    expect(call).not.toHaveBeenCalled()
    const details = screen.getByText(/查看更改/).closest('details')!
    expect(details.open).toBe(false)
})
