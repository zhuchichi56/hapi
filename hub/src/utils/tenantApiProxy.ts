import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compressSseResponse } from '../web/sseCompression'

export type Backend = { namespace: string; baseUrl: string; accessToken: string; ownerVisible?: boolean }
const authenticated = new Map<string, { jwt: string; expires: number }>()

function loadBackends(dataDir: string): Backend[] {
    let fd: number
    try {
        fd = openSync(join(dataDir, 'tenant-backends.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw Error('Tenant backend configuration unavailable')
    }
    try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size > 32768 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
            throw Error('Tenant backend configuration is not private')
        }
        const value = JSON.parse(readFileSync(fd, 'utf8'))
        if (value?.version !== 1 || !Array.isArray(value.backends)) throw Error('Invalid tenant configuration')
        const seen = new Set<string>()
        return value.backends.map((entry: Backend) => {
            if (!entry || typeof entry.namespace !== 'string' || entry.namespace === 'default' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.namespace) || seen.has(entry.namespace)) {
                throw Error('Invalid tenant namespace')
            }
            const url = new URL(entry.baseUrl)
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024 || ['3006', '4150', '18080'].includes(url.port) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
                throw Error('Invalid tenant endpoint')
            }
            if (typeof entry.accessToken !== 'string' || entry.accessToken.length < 32 || !entry.accessToken.endsWith(':' + entry.namespace) || /\s/.test(entry.accessToken)) throw Error('Invalid tenant credential')
            seen.add(entry.namespace)
            return { namespace: entry.namespace, baseUrl: url.origin, accessToken: entry.accessToken, ownerVisible: entry.ownerVisible === true }
        })
    } finally {
        closeSync(fd)
    }
}

const corePaths = /^\/api\/(?:sessions|machines|events|visibility|usage|storage|push|devices)(?:\/|$)/
const unavailable = () => Response.json({ error: 'Isolated execution service is temporarily unavailable' }, { status: 503 })

/** Forwarded SSE lost its hop-by-hop transfer header. Restore streaming semantics
 * before the outer generic gzip middleware can buffer an indefinitely open feed. */
export function tenantApiResponse(response: Response, acceptEncoding: string | undefined): Response {
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return response
    const headers = new Headers(response.headers)
    headers.set('Transfer-Encoding', 'chunked')
    headers.delete('Content-Length')
    const streaming = new Response(response.body, { status: response.status, headers })
    return headers.has('Content-Encoding') ? streaming : compressSseResponse(streaming, acceptEncoding)
}

/** Call only after the public hub authenticated the browser JWT and namespace. */
async function forward(request: Request, backend: Backend): Promise<Response> {
    const incoming = new URL(request.url)
    try {
        const cacheKey = backend.baseUrl + '\n' + backend.accessToken
        let cached = authenticated.get(cacheKey)
        if (!cached || cached.expires <= Date.now()) {
            const auth = await fetch(backend.baseUrl + '/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accessToken: backend.accessToken }),
                redirect: 'error',
                signal: AbortSignal.timeout(5000)
            })
            const value = await auth.json() as { token?: unknown }
            if (!auth.ok || typeof value.token !== 'string') return unavailable()
            cached = { jwt: value.token, expires: Date.now() + 60000 }
            authenticated.set(cacheKey, cached)
        }
        // Never forward the public hub JWT, cookies, or arbitrary client headers.
        incoming.searchParams.delete('token')
        incoming.searchParams.delete('backend')
        const target = backend.baseUrl + incoming.pathname + incoming.search
        const headers = new Headers({ Authorization: 'Bearer ' + cached.jwt, 'Accept-Encoding': 'identity' })
        for (const name of ['content-type', 'accept', 'range', 'last-event-id']) {
            const value = request.headers.get(name)
            if (value) headers.set(name, value)
        }
        const response = await fetch(target, {
            method: request.method,
            headers,
            body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
            redirect: 'error',
            signal: request.signal
        })
        const responseHeaders = new Headers(response.headers)
        for (const name of ['set-cookie', 'connection', 'transfer-encoding']) responseHeaders.delete(name)
        responseHeaders.set('Cache-Control', 'no-store')
        return new Response(response.body, { status: response.status, headers: responseHeaders })
    } catch {
        // An interrupted write may already have reached the guest; never replay it.
        return unavailable()
    }
}

type Index = { expires: number; sessions: Array<{ id: string; [key: string]: unknown }>; machines: Array<{ id: string; [key: string]: unknown }> }
const indexes = new Map<string, { value?: Index; pending?: Promise<Index> }>()
async function backendIndex(backend: Backend): Promise<Index> {
    const key = backend.baseUrl + '\n' + backend.accessToken
    const cached = indexes.get(key)
    if (cached?.value && cached.value.expires > Date.now()) return cached.value
    if (cached?.pending) return cached.pending
    const pending = (async () => {
        const responses = await Promise.all(['sessions', 'machines'].map(name => forward(new Request(`http://local/api/${name}`, { signal: AbortSignal.timeout(10000) }), backend)))
        if (responses.some(r => !r.ok)) throw Error('Project index unavailable')
        const [sessions, machines] = await Promise.all(responses.map(r => r.json())) as [Pick<Index, 'sessions'>, Pick<Index, 'machines'>]
        const value = { expires: Date.now() + 5000, sessions: sessions.sessions, machines: machines.machines }
        if (!Array.isArray(value.sessions) || !Array.isArray(value.machines)) throw Error('Invalid project index')
        indexes.set(key, { value })
        return value
    })()
    indexes.set(key, { pending })
    try { return await pending } catch (error) { indexes.delete(key); throw error }
}

/** Each backend retains its own SSE cursor. Only its opaque visibility handle is namespaced. */
export function projectEventStream(response: Response, namespace: string): Response {
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response
    let tail = ''
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    function rewrite(line: string): string {
        if (!line.startsWith('data:')) return line
        try {
            const event = JSON.parse(line.slice(5))
            if (event.type === 'connection-changed' && typeof event.data?.subscriptionId === 'string') {
                event.data.subscriptionId = `project:${namespace}:${event.data.subscriptionId}`
                return 'data: ' + JSON.stringify(event)
            }
        } catch { /* Leave unrecognized events byte-equivalent. */ }
        return line
    }
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            tail += decoder.decode(chunk, { stream: true })
            let end: number
            while ((end = tail.indexOf('\n')) >= 0) {
                controller.enqueue(encoder.encode(rewrite(tail.slice(0, end)) + '\n'))
                tail = tail.slice(end + 1)
            }
        },
        flush(controller) { tail += decoder.decode(); if (tail) controller.enqueue(encoder.encode(rewrite(tail))) }
    }))
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(body, { status: response.status, headers })
}

/** Invoked after public JWT authentication. Guests remain scoped to their original backend. */
export async function proxyTenantApi(request: Request, namespace: string, dataDir: string, localResponse?: () => Promise<Response>): Promise<Response | null> {
    const incoming = new URL(request.url)
    if (namespace === 'default' && !corePaths.test(incoming.pathname)) return null
    let backends: Backend[]
    try { backends = loadBackends(dataDir) } catch { return unavailable() }
    if (namespace !== 'default') {
        const backend = backends.find(entry => entry.namespace === namespace)
        if (!backend) return null
        if (!corePaths.test(incoming.pathname)) return Response.json({ error: 'This operation is unavailable for isolated execution accounts' }, { status: 403 })
        // A guest cannot opt into a different backend, including the owner's desktop.
        return forward(request, backend)
    }
    const visible = backends.filter(entry => entry.ownerVisible)
    if (!visible.length || !corePaths.test(incoming.pathname)) return null
    try {
        const explicit = incoming.searchParams.get('backend')
        if (explicit) {
            const backend = visible.find(entry => entry.namespace === explicit)
            if (!backend || incoming.pathname !== '/api/events') return Response.json({ error: 'Project stream unavailable' }, { status: 403 })
            return projectEventStream(await forward(request, backend), backend.namespace)
        }
        if (incoming.pathname === '/api/visibility' && request.method === 'POST') {
            const value = await request.clone().json() as { subscriptionId?: string }
            const match = typeof value.subscriptionId === 'string' && /^project:([a-z0-9_-]+):(.+)$/.exec(value.subscriptionId)
            if (!match) return null
            const backend = visible.find(entry => entry.namespace === match[1])
            if (!backend) return Response.json({ error: 'Project subscription unavailable' }, { status: 403 })
            value.subscriptionId = match[2]
            return forward(new Request(request, { body: JSON.stringify(value) }), backend)
        }
        const list = incoming.pathname === '/api/sessions' ? 'sessions' : incoming.pathname === '/api/machines' ? 'machines' : null
        if (list && request.method === 'GET' && localResponse) {
            const [local, remote] = await Promise.all([localResponse(), Promise.all(visible.map(backendIndex))])
            if (!local.ok) return local
            const value = await local.json() as Record<string, unknown>
            const combined = new Map((value[list] as Array<{ id: string }>).map(row => [row.id, row]))
            // Migrated IDs intentionally replace their retained, read-only source copies.
            for (const index of remote) for (const row of index[list]) combined.set(row.id, row)
            let rows = [...combined.values()]
            if (list === 'sessions') {
                rows.sort((a, b) => {
                    const left = a as Record<string, unknown>, right = b as Record<string, unknown>
                    if (incoming.searchParams.get('order') === 'updatedAt') return Number(right.updatedAt) - Number(left.updatedAt)
                    for (const key of ['globalPinned', 'pinned', 'active']) if (Boolean(left[key]) !== Boolean(right[key])) return left[key] ? -1 : 1
                    if (left.active && Number(left.pendingRequestsCount ?? 0) !== Number(right.pendingRequestsCount ?? 0)) return Number(right.pendingRequestsCount ?? 0) - Number(left.pendingRequestsCount ?? 0)
                    return Number(right.updatedAt) - Number(left.updatedAt)
                })
                const limit = Number(incoming.searchParams.get('limit'))
                if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, Math.min(500, Math.max(1, Math.floor(limit))))
            }
            return Response.json({ ...value, [list]: rows, ownerBackends: visible.map(b => b.namespace) }, { headers: { 'Cache-Control': 'no-store' } })
        }
        const entity = /^\/api\/(sessions|machines)\/([^/]+)/.exec(incoming.pathname)
        const sessionId = entity?.[1] === 'sessions' ? decodeURIComponent(entity[2]!) : incoming.pathname === '/api/events' ? incoming.searchParams.get('sessionId') : null
        const machineId = entity?.[1] === 'machines' ? decodeURIComponent(entity[2]!) : incoming.pathname === '/api/events' ? incoming.searchParams.get('machineId') : null
        if (!sessionId && !machineId) return null
        const remote = await Promise.all(visible.map(backendIndex))
        const index = remote.findIndex(value => sessionId ? value.sessions.some(s => s.id === sessionId) : value.machines.some(m => m.id === machineId))
        if (index < 0) return null
        const backend = visible[index]!
        const result = await forward(request, backend)
        if (request.method !== 'GET' && request.method !== 'HEAD') indexes.delete(backend.baseUrl + '\n' + backend.accessToken)
        return incoming.pathname === '/api/events' ? projectEventStream(result, backend.namespace) : result
    } catch { return unavailable() }
}
