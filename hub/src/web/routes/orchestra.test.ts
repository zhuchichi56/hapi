import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createOrchestraRoutes } from './orchestra'
import type { WebAppEnv } from '../middleware/auth'

const SNAPSHOT_LIMIT = 512 * 1024
const SOCKET_PATH = join(homedir(), '.local/lib/hapi-mini/desktop/orchestra.sock')

const task = {
    id: 'T009',
    title: '实现只读任务总控看板',
    goal: '用户打开 Desktop 就能看到队列、进展、工作链接和交付。',
    deliverables: ['OrchestraBoard.tsx', 'orchestra.ts'],
    acceptance: ['390px 无横向溢出', '失败时保留上次成功快照'],
    ownership: ['web/src/components/nativeDesktop/OrchestraBoard.tsx'],
    authorization: '2026-11-02 用户授权只读展示',
    threadId: '01a19339-39e6-7081-8920-82db9992402a',
    host: 'local' as const,
    createdAt: '2026-11-01T16:00:00.000Z',
    checkpoint: '后端路由与前端看板完成',
    expectedAt: '2026-11-02T02:15:00.000+08:00',
    execution: 'running' as const,
    review: 'pending' as const,
    archive: 'none' as const,
    observedAt: '2026-11-01T16:57:00.000Z',
    sourceAt: '2026-11-01T16:56:00.000Z',
    progress: '正在实现只读快照路由和看板。',
    latestAction: '读取任务队列',
    evidence: ['bun test hub/src/web/routes/orchestra.test.ts'],
    stale: false,
    attention: false,
    external: false
}

const snapshot = {
    version: 1 as const,
    generatedAt: '2026-11-01T16:57:30.000Z',
    controllerThreadId: '01a19339-39e6-7081-8920-82db9992402a',
    collector: { connected: true, stale: false, lastSuccessAt: '2026-11-01T16:57:30.000Z' },
    tasks: [task],
    notices: [],
    operations: []
}

function fixture(options: Parameters<typeof createOrchestraRoutes>[0] = {}, namespace = 'default') {
    const app = new Hono<WebAppEnv>()
    let statCalls = 0
    let connectCalls = 0
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createOrchestraRoutes({
        stat: async () => {
            statCalls++
            return { isSocket: () => true, uid: process.getuid!(), mode: 0o600 }
        },
        connect: async () => {
            connectCalls++
            return Response.json(snapshot)
        },
        ...options
    }))
    return {
        request: (path = '/api/orchestra/snapshot', init?: RequestInit) => app.request(path, init),
        statCalls: () => statCalls,
        connectCalls: () => connectCalls
    }
}

describe('read-only orchestra snapshot route', () => {
    it('forwards the real version-1 contract from the private socket', async () => {
        const sockets: string[] = []
        const f = fixture({
            connect: async socket => {
                sockets.push(socket)
                return Response.json(snapshot)
            }
        })
        const response = await f.request()
        expect(response.status).toBe(200)
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        expect(response.headers.get('Content-Type')).toContain('application/json')
        expect(await response.json()).toEqual(snapshot)
        expect(sockets).toEqual([SOCKET_PATH])
        expect(f.statCalls()).toBe(1)
    })

    it('is owner-only and exposes no write route', async () => {
        const denied = fixture({}, 'guest')
        expect((await denied.request()).status).toBe(403)
        expect(denied.statCalls()).toBe(0)
        expect(denied.connectCalls()).toBe(0)

        const write = fixture()
        expect((await write.request('/api/orchestra/snapshot', { method: 'POST' })).status).toBe(404)
        expect(write.connectCalls()).toBe(0)
    })

    it('rejects a socket that is not private', async () => {
        for (const stat of [
            { isSocket: () => true, uid: process.getuid!(), mode: 0o666 },
            { isSocket: () => true, uid: process.getuid!() + 1, mode: 0o600 },
            { isSocket: () => false, uid: process.getuid!(), mode: 0o600 }
        ]) {
            let connects = 0
            const f = fixture({ stat: async () => stat, connect: async () => { connects++; return Response.json(snapshot) } })
            const response = await f.request()
            expect(response.status).toBe(503)
            expect(await response.json()).toEqual({ error: '任务总控数据暂不可用', code: 'orchestra_unavailable' })
            expect(response.headers.get('Cache-Control')).toBe('no-store')
            expect(connects).toBe(0)
        }
    })

    it('turns collector faults into a redacted 503', async () => {
        const faults: Array<Parameters<typeof createOrchestraRoutes>[0]> = [
            { connect: async () => { throw Object.assign(Error(`PRIVATE ${SOCKET_PATH}`), { code: 'ECONNREFUSED' }) } },
            { connect: async () => new Response('PRIVATE gateway body', { status: 502 }) },
            { connect: async () => new Response('PRIVATE not json', { status: 200 }) },
            { connect: async () => Response.json({ version: 1, tasks: 'PRIVATE' }) },
            { connect: async () => Response.json({ version: 2, tasks: [] }) },
            { stat: async () => { throw Error(`PRIVATE ${SOCKET_PATH}`) } }
        ]
        for (const fault of faults) {
            const response = await fixture(fault).request()
            expect(response.status).toBe(503)
            expect(response.headers.get('Cache-Control')).toBe('no-store')
            const text = await response.text()
            expect(JSON.parse(text)).toEqual({ error: '任务总控数据暂不可用', code: 'orchestra_unavailable' })
            for (const secret of ['PRIVATE', SOCKET_PATH, 'ECONNREFUSED', 'gateway']) expect(text).not.toContain(secret)
        }
    })

    it('bounds the collector response at 512 KiB', async () => {
        const tooLarge = fixture({ connect: async () => new Response('x'.repeat(SNAPSHOT_LIMIT + 1)) })
        const response = await tooLarge.request()
        expect(response.status).toBe(503)
        expect((await response.json() as { code: string }).code).toBe('orchestra_unavailable')

        const lyingHeader = fixture({ connect: async () => new Response('{}', { headers: { 'content-length': String(SNAPSHOT_LIMIT + 1) } }) })
        expect((await lyingHeader.request()).status).toBe(503)
    })

    it('times out a stalled collector instead of holding the request', async () => {
        const f = fixture({ timeoutMs: 15, connect: () => new Promise<Response>(() => {}) })
        const started = performance.now()
        const response = await f.request()
        expect(response.status).toBe(503)
        expect(performance.now() - started).toBeLessThan(1000)
    })

    it('times out a collector that stalls after sending headers', async () => {
        const f = fixture({
            timeoutMs: 20,
            connect: async () => new Response(new ReadableStream({ start() {} }), { status: 200 })
        })
        const started = performance.now()
        const response = await f.request()
        expect(response.status).toBe(503)
        expect(performance.now() - started).toBeLessThan(1000)
    })
})

describe('read-only orchestra artifact route', () => {
    it('is owner-only and validates the registered index shape', async () => {
        const denied = fixture({}, 'guest')
        expect((await denied.request('/api/orchestra/artifact?task=T003&index=0')).status).toBe(403)
        expect(denied.statCalls()).toBe(0)
        expect((await fixture().request('/api/orchestra/artifact?task=T003&index=x')).status).toBe(400)
        expect((await fixture().request('/api/orchestra/artifact?task=../x&index=0')).status).toBe(400)
    })

    it('forwards the exact task and index on the artifact path', async () => {
        const paths: Array<[string, string | undefined]> = []
        const f = fixture({
            connect: async (socket, path) => {
                paths.push([socket, path])
                return Response.json({ name: '报告', content: '# hi' })
            }
        })
        const response = await f.request('/api/orchestra/artifact?task=T003&index=0')
        expect(response.status).toBe(200)
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        expect(await response.json()).toEqual({ name: '报告', content: '# hi' })
        expect(paths).toEqual([[SOCKET_PATH, '/artifact?task=T003&index=0']])
    })

    it('redacts artifact faults and bounds the payload at 256 KiB', async () => {
        const fault = fixture({ connect: async () => new Response('PRIVATE', { status: 404 }) })
        const response = await fault.request('/api/orchestra/artifact?task=T003&index=0')
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: '交付物暂不可用', code: 'orchestra_artifact_unavailable' })
        const large = fixture({ connect: async () => new Response('x'.repeat(256 * 1024 + 1)) })
        expect((await large.request('/api/orchestra/artifact?task=T003&index=0')).status).toBe(503)
    })
})
