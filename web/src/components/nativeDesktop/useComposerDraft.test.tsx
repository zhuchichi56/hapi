import { afterEach, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { composerStorageScope, useComposerDraft } from './useComposerDraft'
afterEach(() => { cleanup(); sessionStorage.clear() })
it('isolates drafts by Hub and signed-in identity without using raw credentials in keys', () => {
 const token = (uid: string, ns: string) => `header.${btoa(JSON.stringify({ uid, ns }))}.signature`
 const owner = composerStorageScope(token('owner', 'default'), 'https://one.example')
 const guest = composerStorageScope(token('guest', 'wwx'), 'https://one.example')
 expect(owner.key).not.toContain('signature'); expect(owner.owner).toBe(true); expect(guest.owner).toBe(false)
 expect(owner.key).not.toBe(guest.key)
 const { result, rerender } = renderHook(({ key }) => useComposerDraft(key), { initialProps: { key: owner.key + ':chat' } })
 act(() => result.current[1]('Private unsent text'))
 rerender({ key: guest.key + ':chat' }); expect(result.current[0]).toBe('')
 rerender({ key: owner.key + ':chat' }); expect(result.current[0]).toBe('Private unsent text')
 expect(composerStorageScope(token('owner', 'default'), 'https://two.example').key).not.toBe(owner.key)
})
it('migrates only an explicitly allowed owner draft and does not resurrect it after clearing', () => {
 sessionStorage.setItem('hapi-native-draft-v1:codex:original', 'Existing draft')
 const { result, unmount } = renderHook(() => useComposerDraft('scoped:codex:original', 'codex:original'))
 expect(result.current[0]).toBe('Existing draft')
 act(() => result.current[1]('')); unmount()
 const next = renderHook(() => useComposerDraft('scoped:codex:original', 'codex:original'))
 expect(next.result.current[0]).toBe('')
})
