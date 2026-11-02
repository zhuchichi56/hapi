import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createNativeDesktopRoutes } from './nativeDesktop'
import type { WebAppEnv } from '../middleware/auth'

function fixture(options: Parameters<typeof createNativeDesktopRoutes>[0] = {}, namespace = 'default') {
    const events: Record<string, unknown>[] = []
    let calls = 0
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', namespace); await next() })
    app.route('/api', createNativeDesktopRoutes({ stat: async () => ({ isSocket: () => true, uid: process.getuid!(), mode: 0o600 }),
        connect: async () => { calls++; return Response.json({ ok: true, result: { threads: [] } }) }, report: event => events.push(event), ...options }))
    return { events, calls: () => calls, request: (value: unknown = { app: 'codex', op: 'list' }) => app.request('/api/native-desktop/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer PRIVATE_TOKEN', 'cf-ray': 'a51aa70a7c2184f6-HKG' }, body: JSON.stringify(value),
    }), uploadRequest: (name: string, body: RequestInit['body'], extra: Record<string, string> = {}) => app.request('/api/native-desktop/attachments', {
        method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Attachment-Filename': encodeURIComponent(name), 'Authorization': 'Bearer PRIVATE_TOKEN', ...extra }, body,
    }) }
}

describe('native Desktop failure boundaries', () => {
    it('returns original success without a failure record', async () => {
        const f = fixture(), response = await f.request()
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, result: { threads: [] } })
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        expect(response.headers.get('X-Desktop-Request-Id')).toBeTruthy()
        expect(f.events).toHaveLength(0)
    })
    it('preserves a native rejection as JSON conflict rather than gateway 502', async () => {
        const detail = 'PRIVATE_NATIVE_ERROR: desktop draft exists'
        let calls = 0
        const f = fixture({ connect: async () => { calls++; return Response.json({ ok: false, error: detail, delivery: 'unknown' }, { status: 502 }) } })
        const response = await f.request({ app: 'claude', op: 'send', text: 'PRIVATE_MESSAGE', id: 'PRIVATE_THREAD_ID' })
        expect(response.status).toBe(409)
        expect((await response.json() as { error: string }).error).toBe(detail)
        expect(calls).toBe(1)
        expect(f.events[0]).toMatchObject({ kind: 'native-command', app: 'claude', op: 'send', stage: 'response', nativeStatus: 502, cfRay: 'a51aa70a7c2184f6-HKG' })
        expect(f.events[0].requestId).toBe(response.headers.get('X-Desktop-Request-Id'))
        const log = JSON.stringify(f.events)
        for (const secret of ['PRIVATE_TOKEN', 'PRIVATE_NATIVE_ERROR', 'PRIVATE_MESSAGE', 'PRIVATE_THREAD_ID']) expect(log).not.toContain(secret)
    })
    it('classifies socket transport failure without replaying a write', async () => {
        let calls = 0
        const f = fixture({ connect: async () => { calls++; throw Object.assign(Error('PRIVATE_SOCKET_PATH'), { code: 'ECONNRESET' }) } })
        const response = await f.request({ app: 'codex', op: 'send', text: 'PRIVATE_MESSAGE' })
        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({ ok: false, code: 'desktop_transport_unavailable', delivery: 'unknown' })
        expect(calls).toBe(1)
        expect(f.events[0]).toMatchObject({ kind: 'transport', stage: 'transport', code: 'ECONNRESET' })
        expect(JSON.stringify(f.events)).not.toContain('PRIVATE_')
    })
    it('still rejects a socket that is accessible by other users', async () => {
        const f = fixture({ stat: async () => ({ isSocket: () => true, uid: process.getuid!(), mode: 0o666 }) })
        expect((await f.request()).status).toBe(503)
        expect(f.calls()).toBe(0)
        expect(f.events[0]).toMatchObject({ kind: 'transport', stage: 'socket' })
    })
    it('keeps malformed bridge responses distinct from native rejections', async () => {
        const f = fixture({ connect: async () => Response.json({ unexpected: true }) })
        expect((await f.request()).status).toBe(503)
        expect(f.events[0]).toMatchObject({ kind: 'transport', stage: 'response' })
    })
    it('retains the owner-only boundary and command allowlist', async () => {
        const denied = fixture({}, 'guest')
        expect((await denied.request()).status).toBe(403)
        expect(denied.calls()).toBe(0)
        const invalid = fixture()
        expect((await invalid.request({ app: 'codex', op: 'shell' })).status).toBe(400)
        expect(invalid.calls()).toBe(0)
    })
})

describe('native Desktop ZIP uploads', () => {
    it('forwards chunked ZIP bytes byte-for-byte under the owner boundary', async () => {
        let uploaded: Buffer | undefined, name = ''
        const f = fixture({ upload: async (_socket, body, filename) => {
            uploaded = body; name = filename
            return Response.json({ ok: true, result: { id: '00000000-0000-4000-8000-000000000000', name: filename, size: body.length, canonicalText: 'CANONICAL' } })
        } })
        const bytes = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251))
        const response = await f.uploadRequest('Report.ZIP', bytes)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ id: '00000000-0000-4000-8000-000000000000', name: 'Report.ZIP', size: bytes.length })
        expect(name).toBe('Report.ZIP')
        expect(uploaded).toBeDefined()
        expect(Buffer.compare(uploaded!, bytes)).toBe(0)
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        expect(response.headers.get('X-Desktop-Request-Id')).toBeTruthy()
    })
    it('rejects streamed oversized ZIPs without a content-length before forwarding', async () => {
        let uploads = 0
        const f = fixture({ upload: async () => { uploads++; return Response.json({ ok: true, result: { id: 'x', name: 'x', size: 1, canonicalText: 'x' } }) } })
        let produced = 0
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (produced++ >= 21) { controller.close(); return }
                controller.enqueue(new Uint8Array(1024 * 1024))
            }
        })
        const response = await f.uploadRequest('big.zip', body)
        expect(response.status).toBe(413)
        expect((await response.json() as { error: string }).error).toContain('20 MiB')
        expect(uploads).toBe(0)
        expect(produced).toBeLessThanOrEqual(22)
    })
    it('keeps upload errors human-readable instead of the desktop-disconnected message', async () => {
        const f = fixture({ upload: async () => { throw Object.assign(Error('PRIVATE_TRANSPORT'), { code: 'ECONNRESET' }) } })
        const response = await f.uploadRequest('Report.zip', Buffer.from('PK'))
        expect(response.status).toBe(503)
        const detail = await response.json() as { code: string; error: string }
        expect(detail.code).toBe('attachment_transport_unavailable')
        expect(detail.error).toContain('附件上传通道')
        expect(detail.error).not.toContain('桌面连接中断')
        expect(JSON.stringify(detail)).not.toContain('PRIVATE_TRANSPORT')
    })
    it('preserves host validation errors and rejects non-ZIP names or guests', async () => {
        const invalidName = fixture()
        expect((await invalidName.uploadRequest('notes.txt', Buffer.from('PK'))).status).toBe(400)
        let uploads = 0
        const denied = fixture({ upload: async () => { uploads++; return Response.json({ ok: true }) } }, 'guest')
        expect((await denied.uploadRequest('Report.zip', Buffer.from('PK'))).status).toBe(403)
        expect(uploads).toBe(0)
        const rejected = fixture({ upload: async () => Response.json({ ok: false, error: 'ZIP 文件格式无效' }, { status: 400 }) })
        const response = await rejected.uploadRequest('Report.zip', Buffer.from('PK'))
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'ZIP 文件格式无效' })
    })
})

it('forwards chunk state and rejects a chunk above 512 KiB before the bridge', async () => {
    let headers: Record<string, string> | undefined, uploads = 0
    const f = fixture({ upload: async (_socket, _body, _filename, chunkHeaders) => {
        uploads++; headers = chunkHeaders
        return Response.json({ ok: true, result: { uploadId: 'private-id', offset: 2, complete: false } })
    } })
    const chunk = { 'x-attachment-total': '1000000', 'x-attachment-offset': '0' }
    expect((await f.uploadRequest('x.zip', Buffer.from('PK'), chunk)).status).toBe(200)
    expect(headers).toEqual(chunk)
    expect((await f.uploadRequest('x.zip', new Uint8Array(512 * 1024 + 1), chunk)).status).toBe(413)
    expect(uploads).toBe(1)
})
