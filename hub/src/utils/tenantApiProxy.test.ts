import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectEventStream, proxyTenantApi, tenantApiResponse } from './tenantApiProxy'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { gunzipSync } from 'node:zlib'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function setup(ownerVisible: boolean = true) {
    const seen: { path: string; method: string; auth: string | null; body: unknown }[] = []
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
        const url = new URL(request.url)
        const body = request.method === 'POST' ? await request.json() : null
        seen.push({ path: url.pathname, method: request.method, auth: request.headers.get('authorization'), body })
        if (url.pathname === '/api/auth') return Response.json({ token: 'private-backend-jwt' })
        if (url.pathname === '/api/sessions') return Response.json({ sessions: [{ id: 'migrated', metadata: { path: '/current/wwx' }, updatedAt: 20 }] })
        if (url.pathname === '/api/machines') return Response.json({ machines: [{ id: 'wwx-machine' }] })
        if (url.pathname === '/api/events') return new Response('data: {"type":"connection-changed","data":{"subscriptionId":"subscription"}}\n\nid: 5\ndata: {"type":"heartbeat"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        if (url.pathname.endsWith('/messages') && request.method === 'POST') return Response.json({ error: 'controlled failure' }, { status: 503 })
        return Response.json({ ok: true, body })
    } })
    const dir = mkdtempSync(join(tmpdir(), 'hapi-project-'))
    writeFileSync(join(dir, 'tenant-backends.json'), JSON.stringify({ version: 1, backends: [{ namespace: 'wwx', baseUrl: `http://127.0.0.1:${server.port}`, accessToken: 'x'.repeat(40) + ':wwx', ownerVisible }] }), { mode: 0o600 })
    cleanups.push(() => { server.stop(true); rmSync(dir, { recursive: true }) })
    const call = (path: string, namespace = 'default', init?: RequestInit) => proxyTenantApi(new Request('http://public' + path, { ...init, headers: { Authorization: 'Bearer owner-jwt', Cookie: 'private=never-forward', 'Content-Type': 'application/json' } }), namespace, dir,
        async () => Response.json({ sessions: [{ id: 'migrated', metadata: { path: '/old/wwx' }, updatedAt: 10 }, { id: 'owner-private', updatedAt: 30 }] }))
    return { call, seen, dir }
}
test('aggregated response replaces finalized Hono context before outer gzip', async () => {
    const { dir } = setup()
    const app = new Hono()
    app.use('/api/*', compress({ encoding: 'gzip' }))
    app.use('/api/*', async (c, next) => {
        const proxied = await proxyTenantApi(c.req.raw, 'default', dir, async () => { await next(); return c.res })
        if (proxied) { c.res = proxied; return proxied }
        return next()
    })
    app.get('/api/sessions', c => c.json({ sessions: [{ id: 'migrated', metadata: { path: '/old/wwx' } }] }))
    const response = await app.request('/api/sessions', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(response.status).toBe(200)
    const value = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString())
    expect(value.sessions[0].metadata.path).toBe('/current/wwx')
})
test('owner sees one canonical copy; guest remains backend-only and desktop stays local', async () => {
    const { call, seen } = setup()
    const list = await (await call('/api/sessions'))!.json() as { sessions: { id: string; metadata: { path: string } }[]; ownerBackends: string[] }
    expect(list.sessions).toHaveLength(2)
    expect(list.sessions.find(s => s.id === 'migrated')!.metadata.path).toBe('/current/wwx')
    expect(list.ownerBackends).toEqual(['wwx'])
    const guest = await (await call('/api/sessions?backend=other', 'wwx'))!.json() as { sessions: unknown[] }
    expect(guest.sessions).toHaveLength(1)
    expect(await call('/api/native-desktop')).toBeNull()
    expect((await call('/api/native-desktop', 'wwx'))!.status).toBe(403)
    expect(seen.filter(r => r.path !== '/api/auth').every(r => r.auth === 'Bearer private-backend-jwt')).toBe(true)
})
test('owner session reads/writes target the current backend and uncertain writes are not retried', async () => {
    const { call, seen } = setup()
    expect((await call('/api/sessions/migrated'))!.status).toBe(200)
    expect((await call('/api/sessions/migrated/messages', 'default', { method: 'POST', body: JSON.stringify({ text: 'new message' }) }))!.status).toBe(503)
    expect(seen.filter(r => r.path.endsWith('/messages') && r.method === 'POST')).toHaveLength(1)
    expect(await call('/api/sessions/owner-private')).toBeNull()
})
test('backend SSE has an independent cursor and visibility returns to the matching backend', async () => {
    const { call, seen } = setup()
    const stream = await (await call('/api/events?all=true&backend=wwx&lastEventId=5'))!.text()
    expect(stream).toContain('project:wwx:subscription')
    expect(stream).toContain('id: 5\n')
    const visible = await call('/api/visibility', 'default', { method: 'POST', body: JSON.stringify({ subscriptionId: 'project:wwx:subscription', visibility: 'visible' }) })
    expect(visible!.status).toBe(200)
    expect(seen.at(-1)?.body).toEqual({ subscriptionId: 'subscription', visibility: 'visible' })
    expect((await call('/api/events?backend=unknown'))!.status).toBe(403)
})
test('projection is opt-in and SSE preserves UTF8 and frames across arbitrary chunks', async () => {
    const { call } = setup(false)
    expect(await call('/api/sessions')).toBeNull()
    const text = 'data: {"type":"connection-changed","data":{"subscriptionId":"s"}}\n\nid: 8\ndata: {"type":"message","text":"中文"}\n\n'
    const bytes = new TextEncoder().encode(text)
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
    const result = await projectEventStream(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), 'wwx').text()
    expect(result).toBe(text.replace('"subscriptionId":"s"', '"subscriptionId":"project:wwx:s"'))
})

test('a project configuration failure cannot take down the original owner desktop', async () => {
    const { call, dir } = setup()
    writeFileSync(join(dir, 'tenant-backends.json'), '{invalid', { mode: 0o600 })
    expect(await call('/api/native-desktop/read')).toBeNull()
    expect((await call('/api/sessions'))!.status).toBe(503)
})

test('proxied gzip SSE delivers a live frame before the backend closes', async () => {
    const app = new Hono()
    let close: (() => void) | undefined
    app.use('/api/*', compress({ encoding: 'gzip' }))
    app.get('/api/events', c => {
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"heartbeat"}\n\n')); close = () => controller.close() } })
        return tenantApiResponse(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), c.req.header('Accept-Encoding'))
    })
    const response = await app.request('/api/events', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(response.headers.get('content-encoding')).toBe('gzip')
    const reader = response.body!.pipeThrough(new DecompressionStream('gzip')).getReader()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('SSE buffered until close')), 1000) })])
        expect(new TextDecoder().decode(first.value)).toContain('heartbeat')
    } finally { clearTimeout(timer); close?.(); await reader.cancel() }
})
