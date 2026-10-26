import { Hono } from 'hono'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import type { WebAppEnv } from '../middleware/auth'

export function createNativeDesktopRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.post('/native-desktop/command', async (c) => {
        if (c.get('namespace') !== 'default') return c.json({ error: 'Desktop access is only available to the hub owner' }, 403)
        c.header('Cache-Control', 'no-store')
        if (Number(c.req.header('content-length') ?? 0) > 8388608) return c.json({ error: 'Request too large' }, 413)
        try {
            const body = await c.req.text()
            if (Buffer.byteLength(body) > 8388608) return c.json({ error: 'Request too large' }, 413)
            const value = JSON.parse(body)
            if (!['codex', 'claude'].includes(value?.app) || !['list', 'read', 'projects', 'models', 'create', 'send', 'stop', 'respond'].includes(value?.op)) return c.json({ error: 'Invalid desktop command' }, 400)
            const socket = join(homedir(), '.local/lib/hapi-mini/desktop/host.sock')
            const stat = await lstat(socket)
            if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw Error('Desktop connection is not private')
            const response = await fetch('http://localhost/command', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, unix: socket, proxy: '', signal: AbortSignal.timeout(60000) })
            const result = await response.json()
            return c.json(result, response.ok ? 200 : 502)
        } catch {
            return c.json({ ok: false, error: '桌面连接中断。请保持 MacBook 和桌面 App 在线；若刚才发送过消息，请刷新确认结果。', delivery: 'unknown' }, 502)
        }
    })
    return app
}
