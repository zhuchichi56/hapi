import { afterEach, expect, it, vi } from 'vitest'
import { ApiClient } from './client'
afterEach(() => vi.unstubAllGlobals())
it('uploads large ZIPs sequentially with the acknowledged offset and no replay', async () => {
    const size = 512 * 1024 + 50, calls: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
        calls.push(init)
        return Response.json(calls.length === 1 ? { uploadId: 'upload-1', offset: 512 * 1024, complete: false } : { id: 'zip-1', size, name: 'x.zip', complete: true, canonicalText: 'x' })
    }))
    const result = await new ApiClient('token').nativeDesktopUpload(new File([new Uint8Array(size)], 'x.zip'))
    expect(result.id).toBe('zip-1')
    expect(calls).toHaveLength(2)
    expect(new Headers(calls[0].headers).get('x-attachment-offset')).toBe('0')
    expect(new Headers(calls[1].headers).get('x-attachment-offset')).toBe(String(512 * 1024))
    expect(new Headers(calls[1].headers).get('x-attachment-upload-id')).toBe('upload-1')
    expect((calls[1].body as Blob).size).toBe(50)
})
it('stops on an invalid chunk acknowledgement', async () => {
    const fetch = vi.fn(async () => Response.json({ uploadId: 'x', offset: 1, complete: false }))
    vi.stubGlobal('fetch', fetch)
    await expect(new ApiClient('token').nativeDesktopUpload(new File([new Uint8Array(600000)], 'x.zip'))).rejects.toThrow('分块响应无效')
    expect(fetch).toHaveBeenCalledTimes(1)
})
