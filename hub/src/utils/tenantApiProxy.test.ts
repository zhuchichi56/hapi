import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proxyTenantApi } from './tenantApiProxy'

const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
const guestCredential = 'isolated-root-test-0123456789abcdef:wwx'
function setup(handler: (r: Request) => Response | Promise<Response>) {
    const dir = mkdtempSync(join(tmpdir(), 'tenant-proxy-')); dirs.push(dir)
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler }); servers.push(server)
    const path = join(dir, 'tenant-backends.json')
    writeFileSync(path, JSON.stringify({ version: 1, backends: [{ namespace: 'wwx', baseUrl: `http://127.0.0.1:${server.port}`, accessToken: guestCredential }] }), { mode: 0o600 })
    return { dir, path }
}
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

test('owner requests stay on owner hub even with a tenant configuration', async () => {
    const { dir } = setup(() => { throw Error('Owner request must not be forwarded') })
    expect(await proxyTenantApi(new Request('https://public/api/sessions'), 'default', dir)).toBeNull()
})

test('guest request uses guest credential and strips the public JWT and cookies', async () => {
    const seen: string[] = []
    const { dir } = setup(async r => {
        const u = new URL(r.url)
        if (u.pathname === '/api/auth') { expect((await r.json() as { accessToken: string }).accessToken).toBe(guestCredential); return Response.json({ token: 'guest-jwt-for-tests' }) }
        seen.push(u.pathname)
        expect(r.headers.get('authorization')).toBe('Bearer guest-jwt-for-tests')
        expect(r.headers.get('cookie')).toBeNull()
        expect(u.searchParams.has('token')).toBe(false)
        return Response.json({ machines: [{ id: 'guest-machine' }] })
    })
    const response = await proxyTenantApi(new Request('https://public/api/machines?token=public-owner-signed-jwt', { headers: { Authorization: 'Bearer public-owner-signed-jwt', Cookie: 'private=value' } }), 'wwx', dir)
    expect(response?.status).toBe(200)
    expect(await response!.json()).toEqual({ machines: [{ id: 'guest-machine' }] })
    expect(seen).toEqual(['/api/machines'])
})

test('desktop and privileged hub operations are rejected before forwarding', async () => {
    let calls = 0
    const { dir } = setup(() => { calls++; return new Response('Unexpected') })
    for (const path of ['/api/native-desktop/command', '/api/codex/sync-session', '/api/hub-settings']) {
        const response = await proxyTenantApi(new Request('https://public' + path, { method: 'POST', body: '{}' }), 'wwx', dir)
        expect(response?.status).toBe(403)
    }
    expect(calls).toBe(0)
})

test('POST body is forwarded once and redirects cannot escape the guest backend', async () => {
    let writes = 0
    const { dir } = setup(async r => {
        if (new URL(r.url).pathname === '/api/auth') return Response.json({ token: 'guest-jwt-for-tests' })
        writes++
        expect(await r.text()).toBe('{"text":"hello"}')
        return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:3006/api/sessions' } })
    })
    const response = await proxyTenantApi(new Request('https://public/api/sessions/guest/messages', { method: 'POST', body: '{"text":"hello"}' }), 'wwx', dir)
    expect(response?.status).toBe(503)
    expect(writes).toBe(1)
})

test('SSE is returned as a stream without buffering the whole response', async () => {
    const { dir } = setup(r => {
        if (new URL(r.url).pathname === '/api/auth') return Response.json({ token: 'guest-jwt-for-tests' })
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: connected\n\n')); c.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const response = await proxyTenantApi(new Request('https://public/api/events'), 'wwx', dir)
    expect(response?.headers.get('content-type')).toContain('text/event-stream')
    expect(await response!.text()).toBe('data: connected\n\n')
})

test('insecure and owner-directed configurations fail closed', async () => {
    const { dir, path } = setup(() => new Response('Never'))
    chmodSync(path, 0o644)
    expect((await proxyTenantApi(new Request('https://public/api/machines'), 'wwx', dir))?.status).toBe(503)
    chmodSync(path, 0o600)
    writeFileSync(path, JSON.stringify({ version: 1, backends: [{ namespace: 'wwx', baseUrl: 'http://127.0.0.1:3006', accessToken: guestCredential }] }))
    expect((await proxyTenantApi(new Request('https://public/api/machines'), 'wwx', dir))?.status).toBe(503)
})
