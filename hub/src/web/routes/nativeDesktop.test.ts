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
