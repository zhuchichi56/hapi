import { Hono } from 'hono'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { WebAppEnv } from '../middleware/auth'

type Dependencies = {
    stat?: (path: string) => Promise<{ isSocket(): boolean; uid: number; mode: number }>
    connect?: (socket: string, body: string) => Promise<Response>
    upload?: (socket: string, body: Buffer, filename: string, chunkHeaders?: Record<string, string>) => Promise<Response>
    report?: (event: Record<string, unknown>) => void
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

function attachmentFilename(header: string | undefined): string {
    if (!header) throw Error('缺少附件文件名')
    let name: string
    try { name = decodeURIComponent(header) } catch { throw Error('附件文件名编码无效') }
    if (!name || name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(name) || !/\.zip$/i.test(name)) throw Error('仅支持 .zip 附件')
    return name
}

export function createNativeDesktopRoutes(dependencies: Dependencies = {}): Hono<WebAppEnv> {
    const statSocket = dependencies.stat ?? (path => lstat(path))
    const connect = dependencies.connect ?? ((socket, body) => fetch('http://localhost/command', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, unix: socket, proxy: '', signal: AbortSignal.timeout(60000) }))
    const upload = dependencies.upload ?? ((socket, body, filename, chunkHeaders) => fetch('http://localhost/attachments', { method: 'POST', body, headers: { 'Content-Type': 'application/zip', 'X-Attachment-Filename': encodeURIComponent(filename), ...chunkHeaders }, unix: socket, proxy: '', signal: AbortSignal.timeout(120000) }))
    const report = dependencies.report ?? (event => console.warn(JSON.stringify(event)))
    const app = new Hono<WebAppEnv>()
    app.post('/native-desktop/attachments', async (c) => {
        if (c.get('namespace') !== 'default') return c.json({ error: 'Desktop access is only available to the hub owner' }, 403)
        c.header('Cache-Control', 'no-store')
        c.header('X-Desktop-Request-Id', randomUUID())
        let filename: string
        try { filename = attachmentFilename(c.req.header('x-attachment-filename')) }
        catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400) }
        const chunkHeaders: Record<string, string> = {}
        for (const header of ['x-attachment-total', 'x-attachment-offset', 'x-attachment-upload-id']) {
            const value = c.req.header(header)
            if (value !== undefined) chunkHeaders[header] = value
        }
        const limit = chunkHeaders['x-attachment-total'] !== undefined ? 512 * 1024 : MAX_ATTACHMENT_BYTES
        const declared = Number(c.req.header('content-length') ?? NaN)
        if (Number.isFinite(declared) && declared > limit) return c.json({ error: '单个 ZIP 附件不能超过 20 MiB' }, 413)
        if (!c.req.raw.body) return c.json({ error: 'ZIP 文件为空' }, 400)
        const reader = c.req.raw.body.getReader()
        const chunks: Buffer[] = []
        let size = 0
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (!value?.byteLength) continue
                size += value.byteLength
                if (size > limit) {
                    await reader.cancel().catch(() => {})
                    return c.json({ error: '单个 ZIP 附件不能超过 20 MiB' }, 413)
                }
                chunks.push(Buffer.from(value))
            }
        } catch {
            return c.json({ error: '附件上传中断，请重试' }, 400)
        }
        if (!size) return c.json({ error: 'ZIP 文件为空' }, 400)
        try {
            const socket = join(homedir(), '.local/lib/hapi-mini/desktop/host.sock')
            const stat = await statSocket(socket)
            if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw Error('Desktop connection is not private')
            const response = await upload(socket, Buffer.concat(chunks), filename, chunkHeaders)
            const raw = await response.json().catch(() => null) as { ok?: unknown; result?: unknown; error?: unknown } | null
            if (!response.ok || raw?.ok !== true || !raw.result || typeof raw.result !== 'object' || Array.isArray(raw.result)) {
                const status: ContentfulStatusCode = response.status === 413 ? 413 : response.status === 400 ? 400 : 502
                const error = typeof raw?.error === 'string' && raw.error ? raw.error : '附件上传失败，请重试'
                return c.json({ error }, status)
            }
            return c.json(raw.result)
        } catch {
            return c.json({ code: 'attachment_transport_unavailable', error: '附件上传通道暂时不可用，请确认 MacBook 与桌面 App 在线后重试' }, 503)
        }
    })
    app.post('/native-desktop/command', async (c) => {
        if (c.get('namespace') !== 'default') return c.json({ error: 'Desktop access is only available to the hub owner' }, 403)
        c.header('Cache-Control', 'no-store')
        if (Number(c.req.header('content-length') ?? 0) > 8388608) return c.json({ error: 'Request too large' }, 413)
        const requestId = randomUUID(), start = performance.now()
        c.header('X-Desktop-Request-Id', requestId)
        let stage = 'request', command: { app?: string; op?: string } = {}
        const failure = (fields: Record<string, unknown>) => report({ event: 'native-desktop-failure', at: new Date().toISOString(), requestId,
            app: command.app, op: command.op, stage, elapsedMs: Math.round(performance.now() - start),
            cfRay: /^[a-f0-9]{16}-[A-Z]{3}$/i.test(c.req.header('cf-ray') ?? '') ? c.req.header('cf-ray') : undefined, ...fields })
        try {
            const body = await c.req.text()
            if (Buffer.byteLength(body) > 8388608) return c.json({ error: 'Request too large' }, 413)
            const value = JSON.parse(body)
            if (!['codex', 'claude'].includes(value?.app) || !['list', 'read', 'projects', 'models', 'model-settings', 'set-model', 'create', 'send', 'stop', 'respond', 'archive', 'pin'].includes(value?.op)) return c.json({ error: 'Invalid desktop command' }, 400)
            command = { app: value.app, op: value.op }
            stage = 'socket'
            const socket = join(homedir(), '.local/lib/hapi-mini/desktop/host.sock')
            const stat = await statSocket(socket)
            if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw Error('Desktop connection is not private')
            stage = 'transport'
            const response = await connect(socket, body)
            stage = 'response'
            const raw = await response.json()
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid desktop response')
            const result = raw as Record<string, unknown>
            if (result?.ok !== true && !(result?.ok === false && typeof result.error === 'string')) throw Error('Invalid desktop response')
            if (!response.ok && result.ok === true) throw Error('Invalid desktop response')
            if (!response.ok || result.ok === false) {
                failure({ kind: 'native-command', nativeStatus: response.status, delivery: typeof result.delivery === 'string' && ['unknown', 'not-sent'].includes(result.delivery) ? result.delivery : null,
                    errorFingerprint: createHash('sha256').update(String(result.error ?? '')).digest('hex').slice(0, 16) })
                // This is a reachable native adapter's rejection. A 502 can be replaced
                // by gateway HTML, hiding its real error and triggering pointless retries.
                return c.json(result, 409)
            }
            return c.json(result)
        } catch (error) {
            if (stage === 'request' && error instanceof SyntaxError) return c.json({ error: 'Invalid desktop command' }, 400)
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNKNOWN'
            failure({ kind: 'transport', code })
            return c.json({ ok: false, code: 'desktop_transport_unavailable', error: '桌面连接中断。请保持 MacBook 和桌面 App 在线；若刚才发送过消息，请刷新确认结果。', delivery: 'unknown' }, 503)
        }
    })
    return app
}
