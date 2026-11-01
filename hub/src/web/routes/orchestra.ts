import { Hono } from 'hono'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import type { WebAppEnv } from '../middleware/auth'

const SNAPSHOT_LIMIT = 512 * 1024
const ARTIFACT_LIMIT = 256 * 1024
const SNAPSHOT_TIMEOUT_MS = 2000
const SOCKET_PATH = join(homedir(), '.local/lib/hapi-mini/desktop/orchestra.sock')
const UNAVAILABLE = { error: '任务总控数据暂不可用', code: 'orchestra_unavailable' } as const

type SocketStat = { isSocket(): boolean; uid: number; mode: number }

type Dependencies = {
    stat?: (path: string) => Promise<SocketStat>
    connect?: (socket: string, path?: string) => Promise<Response>
    timeoutMs?: number
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Orchestra collector timed out')), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}

async function readLimited(response: Response, limit: number): Promise<string> {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) throw Error('Orchestra snapshot is too large')
    if (!response.body) {
        const text = await response.text()
        if (Buffer.byteLength(text, 'utf8') > limit) throw Error('Orchestra snapshot is too large')
        return text
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            size += value.byteLength
            if (size > limit) throw Error('Orchestra snapshot is too large')
            chunks.push(value)
        }
    } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(body)
}

export function createOrchestraRoutes(dependencies: Dependencies = {}): Hono<WebAppEnv> {
    const statSocket = dependencies.stat ?? (path => lstat(path))
    const timeoutMs = dependencies.timeoutMs ?? SNAPSHOT_TIMEOUT_MS
    const connect = dependencies.connect ?? ((socket, path = '/snapshot') => fetch(`http://localhost${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        unix: socket,
        proxy: '',
        signal: AbortSignal.timeout(timeoutMs)
    }))
    const app = new Hono<WebAppEnv>()
    app.get('/orchestra/snapshot', async (c) => {
        c.header('Cache-Control', 'no-store')
        if (c.get('namespace') !== 'default') return c.json({ error: 'Desktop access is only available to the hub owner' }, 403)
        try {
            const stat = await statSocket(SOCKET_PATH)
            if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
                throw Error('Orchestra socket is not private')
            }
            // Bound the whole exchange, not just the response headers: a
            // collector that stalls mid-body must not hold a web request open.
            const text = await withTimeout((async () => {
                const response = await connect(SOCKET_PATH, '/snapshot')
                if (!response.ok) throw Error('Orchestra collector rejected the request')
                return await readLimited(response, SNAPSHOT_LIMIT)
            })(), timeoutMs)
            let value: unknown
            try {
                value = JSON.parse(text)
            } catch {
                throw Error('Orchestra collector returned invalid JSON')
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Orchestra collector returned an invalid snapshot')
            const snapshot = value as Record<string, unknown>
            if (snapshot.version !== 1 || !Array.isArray(snapshot.tasks)) throw Error('Orchestra collector returned an unsupported snapshot')
            return c.json(snapshot)
        } catch {
            // The reader is read-only and owner-only. Never expose socket paths,
            // collector errors or credentials through the web boundary.
            return c.json(UNAVAILABLE, 503)
        }
    })
    app.get('/orchestra/artifact', async (c) => {
        c.header('Cache-Control', 'no-store')
        if (c.get('namespace') !== 'default') return c.json({ error: 'Desktop access is only available to the hub owner' }, 403)
        const task = c.req.query('task') ?? ''
        const index = c.req.query('index') ?? ''
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(task) || !/^\d{1,3}$/.test(index)) {
            return c.json({ error: '交付物请求无效', code: 'orchestra_artifact_invalid' }, 400)
        }
        try {
            const stat = await statSocket(SOCKET_PATH)
            if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
                throw Error('Orchestra socket is not private')
            }
            const path = `/artifact?${new URLSearchParams({ task, index }).toString()}`
            const text = await withTimeout((async () => {
                const response = await connect(SOCKET_PATH, path)
                if (!response.ok) throw Error('Orchestra collector rejected the artifact request')
                return await readLimited(response, ARTIFACT_LIMIT)
            })(), timeoutMs)
            let value: unknown
            try {
                value = JSON.parse(text)
            } catch {
                throw Error('Orchestra collector returned invalid artifact JSON')
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Orchestra collector returned an invalid artifact')
            const artifact = value as Record<string, unknown>
            if (typeof artifact.name !== 'string' || !artifact.name.trim() || artifact.name.length > 200 || typeof artifact.content !== 'string') {
                throw Error('Orchestra collector returned an invalid artifact')
            }
            if (Buffer.byteLength(artifact.content, 'utf8') > ARTIFACT_LIMIT) throw Error('Orchestra artifact is too large')
            return c.json({ name: artifact.name, content: artifact.content })
        } catch {
            return c.json({ error: '交付物暂不可用', code: 'orchestra_artifact_unavailable' }, 503)
        }
    })
    return app
}
