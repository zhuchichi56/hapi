import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Backend = { namespace: string; baseUrl: string; accessToken: string }
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
            return { namespace: entry.namespace, baseUrl: url.origin, accessToken: entry.accessToken }
        })
    } finally {
        closeSync(fd)
    }
}

const corePaths = /^\/api\/(?:sessions|machines|events|visibility|usage|storage|push|devices)(?:\/|$)/
const unavailable = () => Response.json({ error: 'Isolated execution service is temporarily unavailable' }, { status: 503 })

/** Call only after the public hub authenticated the browser JWT and namespace. */
export async function proxyTenantApi(request: Request, namespace: string, dataDir: string): Promise<Response | null> {
    if (namespace === 'default') return null
    let backend: Backend | undefined
    try {
        backend = loadBackends(dataDir).find(entry => entry.namespace === namespace)
    } catch {
        return unavailable()
    }
    if (!backend) return null
    const incoming = new URL(request.url)
    if (!corePaths.test(incoming.pathname)) {
        return Response.json({ error: 'This operation is unavailable for isolated execution accounts' }, { status: 403 })
    }
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
