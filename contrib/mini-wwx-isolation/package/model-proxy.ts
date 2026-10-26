#!/usr/bin/env bun
/**
 * HAPI WWX guest model proxy.
 *
 * One process for the WWX guest, bound to 127.0.0.1:<PROXY_PORT>.
 * Fixed routes only:
 *   POST /v1/responses  -> <fixed upstream>/v1/responses  (model fixed: gpt-6.1-sol)
 *   POST /v1/messages   -> <fixed upstream>/v1/messages   (model fixed: claude-sonnet-5-5)
 *   GET  /v1/models     -> static list of exactly those two models
 *
 * Deliberate non-features (do not add):
 *   - no caller-selected target URL / base_url / proxy / endpoint
 *   - no arbitrary header pass-through; only anthropic-version/anthropic-beta
 *   - no Authorization/Cookie/X-Api-Key forwarding upstream
 *   - no previous_response_id, files, uploads, batches, admin or management API
 *   - no body/header/token logging
 *
 * The file is installed root:wheel 0444 outside the tenant sandbox. The process
 * runs as hapi-wwx and is the only guest process allowed to reach 127.0.0.1:4150.
 *
 * Environment (set by the root-owned LaunchDaemon):
 *   HAPI_TENANT=wwx
 *   PROXY_PORT=4126
 *   UPSTREAM_URL=http://127.0.0.1:4150
 *   TOKEN_FILE=/Users/hapi-wwx/.hapi/secrets/proxy-token
 *   LOG_PREFIX=model-proxy-wwx
 */

const MODELS = {
    responses: 'gpt-6.1-sol',
    messages: 'claude-sonnet-5-5',
} as const
type Route = keyof typeof MODELS

const MAX_BODY_BYTES = 16 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 300_000

type JsonObject = Record<string, unknown>

function env(name: string, fallback?: string): string {
    const value = process.env[name]
    if (value !== undefined && value !== '') return value
    if (fallback !== undefined) return fallback
    throw new Error(`missing required environment variable ${name}`)
}

const tenant = env('HAPI_TENANT')
if (!/^[a-z][a-z0-9-]{1,15}$/.test(tenant)) {
    console.error('invalid HAPI_TENANT')
    process.exit(78)
}
const proxyPort = Number(env('PROXY_PORT'))
if (!Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    console.error('invalid PROXY_PORT')
    process.exit(78)
}
const upstreamUrl = new URL(env('UPSTREAM_URL', 'http://127.0.0.1:4150'))
if (upstreamUrl.protocol !== 'http:' || upstreamUrl.hostname !== '127.0.0.1') {
    console.error('UPSTREAM_URL must be http://127.0.0.1:<port>')
    process.exit(78)
}
if (upstreamUrl.pathname !== '/' || upstreamUrl.search !== '' || upstreamUrl.hash !== '') {
    console.error('UPSTREAM_URL must not contain a path, query or fragment')
    process.exit(78)
}
const tokenFile = env('TOKEN_FILE')
const logPrefix = env('LOG_PREFIX', 'model-proxy-wwx')

function fail(code: number, message: string): never {
    console.error(`${logPrefix}: ${message}`)
    process.exit(code)
}

async function loadTenantToken(): Promise<string> {
    let stat: import('node:fs').Stats
    try {
        stat = await Bun.file(tokenFile).stat()
    } catch {
        fail(78, 'tenant token file is unreadable')
    }
    if (!stat.isFile()) fail(78, 'tenant token file is not a regular file')
    if ((stat.mode & 0o777) !== 0o600) fail(78, 'tenant token file mode is not 0600')
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        fail(78, 'tenant token file is not owned by the proxy user')
    }
    const token = (await Bun.file(tokenFile).text()).trim()
    if (token.length < 32) fail(78, 'tenant token is too short')
    return token
}

const tenantToken = await loadTenantToken()

function constantTimeEqual(a: string, b: string): boolean {
    const aa = new TextEncoder().encode(a)
    const bb = new TextEncoder().encode(b)
    let diff = aa.length ^ bb.length
    const n = Math.max(aa.length, bb.length)
    for (let i = 0; i < n; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0)
    return diff === 0
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        },
    })
}

function errorFor(route: Route | null, status: number, message: string): Response {
    if (route === 'messages') {
        return json(status, { type: 'error', error: { type: 'invalid_request_error', message } })
    }
    return json(status, { error: { type: 'invalid_request_error', message } })
}

function authenticate(request: Request): boolean {
    const raw = request.headers.get('authorization')
    if (!raw || !raw.startsWith('Bearer ')) return false
    const presented = raw.slice('Bearer '.length).trim()
    if (presented.length === 0) return false
    return constantTimeEqual(presented, tenantToken)
}

function upstreamHeaders(request: Request, route: Route): Headers {
    // Built from scratch: caller headers are never copied upstream.
    const headers = new Headers()
    headers.set('content-type', 'application/json')
    headers.set('accept', 'text/event-stream, application/json')
    headers.set('user-agent', `hapi-model-proxy/${tenant}`)
    if (route === 'messages') {
        const version = request.headers.get('anthropic-version')
        headers.set(
            'anthropic-version',
            version && /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : '2023-06-01',
        )
        const beta = request.headers.get('anthropic-beta')
        if (beta && /^[A-Za-z0-9,._ -]{1,512}$/.test(beta)) {
            headers.set('anthropic-beta', beta)
        }
    }
    return headers
}

function validatePayload(route: Route, payload: unknown): { ok: true; body: JsonObject } | { ok: false; error: string } {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { ok: false, error: 'body must be a JSON object' }
    }
    const body = payload as JsonObject
    if (body.model !== MODELS[route]) {
        return { ok: false, error: `model must be ${MODELS[route]}` }
    }
    for (const key of [
        'previous_response_id',
        'conversation',
        'background',
        'file_ids',
        'input_file',
        'vector_store_ids',
        'upload_id',
        'batch_id',
        'url',
        'base_url',
        'proxy',
        'endpoint',
    ]) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            return { ok: false, error: `field ${key} is not allowed` }
        }
    }
    return { ok: true, body }
}

async function handleModelRequest(
    request: Request,
    route: Route,
    search: string,
): Promise<Response> {
    const contentLength = request.headers.get('content-length')
    if (contentLength !== null) {
        const n = Number(contentLength)
        if (!Number.isFinite(n) || n > MAX_BODY_BYTES) {
            return errorFor(route, 413, 'request body too large')
        }
    }

    let text: string
    try {
        text = await request.text()
    } catch {
        return errorFor(route, 400, 'unreadable request body')
    }
    if (text.length > MAX_BODY_BYTES) return errorFor(route, 413, 'request body too large')

    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return errorFor(route, 400, 'invalid JSON')
    }
    const validated = validatePayload(route, parsed)
    if (!validated.ok) return errorFor(route, 400, validated.error)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })

    let upstream: Response
    try {
        upstream = await fetch(new URL(`/v1/${route}${search}`, upstreamUrl), {
            method: 'POST',
            headers: upstreamHeaders(request, route),
            body: JSON.stringify(validated.body),
            signal: controller.signal,
        })
    } catch {
        clearTimeout(timeout)
        request.signal.removeEventListener('abort', onAbort)
        const aborted = controller.signal.aborted
        return errorFor(route, aborted ? 504 : 502, aborted ? 'upstream timeout' : 'upstream unavailable')
    }

    const contentType = upstream.headers.get('content-type') ?? ''
    const headers = new Headers()
    headers.set('cache-control', 'no-store')
    headers.set('x-accel-buffering', 'no')
    headers.set('x-model-proxy-tenant', tenant)
    headers.set('content-type', contentType || 'text/event-stream; charset=utf-8')

    const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
            const reader = upstream.body?.getReader()
            if (!reader) {
                streamController.close()
                return
            }
            const pump = async (): Promise<void> => {
                try {
                    for (;;) {
                        const { done, value } = await reader.read()
                        if (done) break
                        if (value) streamController.enqueue(value)
                    }
                    streamController.close()
                } catch {
                    streamController.error(new Error('upstream stream failed'))
                } finally {
                    clearTimeout(timeout)
                    request.signal.removeEventListener('abort', onAbort)
                    reader.releaseLock()
                }
            }
            void pump()
        },
        cancel(reason) {
            clearTimeout(timeout)
            request.signal.removeEventListener('abort', onAbort)
            controller.abort()
            void upstream.body?.cancel(reason)
        },
    })

    return new Response(stream, { status: upstream.status, headers })
}

function modelsResponse(): Response {
    return json(200, {
        object: 'list',
        data: [
            { id: MODELS.responses, object: 'model', created: 0, owned_by: 'hapi-wwx' },
            { id: MODELS.messages, object: 'model', created: 0, owned_by: 'hapi-wwx' },
        ],
    })
}

function logLine(request: Request, status: number, startedAt: number): void {
    const url = new URL(request.url)
    console.log(
        JSON.stringify({
            ts: new Date().toISOString(),
            tenant,
            method: request.method,
            path: url.pathname,
            status,
            duration_ms: Date.now() - startedAt,
        }),
    )
}

function parseSearch(route: Route, search: string): { ok: true; search: string } | { ok: false } {
    if (search === '') return { ok: true, search: '' }
    const params = new URLSearchParams(search)
    // Claude Code's SDK appends ?beta=true for beta message calls. Nothing else
    // is accepted; query data is never forwarded upstream.
    if (route === 'messages' && params.size === 1 && params.get('beta') === 'true') {
        return { ok: true, search: '' }
    }
    return { ok: false }
}

const server = Bun.serve({
    hostname: '127.0.0.1',
    port: proxyPort,
    development: false,
    idleTimeout: 255,
    async fetch(request: Request): Promise<Response> {
        const startedAt = Date.now()
        const url = new URL(request.url)
        let response: Response
        const route: Route | null =
            url.pathname === '/v1/messages' ? 'messages' : url.pathname === '/v1/responses' ? 'responses' : null
        try {
            if (!authenticate(request)) {
                response = errorFor(route, 401, 'unauthorized')
            } else if (url.pathname === '/v1/models' && request.method === 'GET') {
                response = url.search === '' ? modelsResponse() : errorFor(null, 400, 'query parameters are not allowed')
            } else if (route !== null && request.method === 'POST') {
                const query = parseSearch(route, url.search)
                response = query.ok
                    ? await handleModelRequest(request, route, query.search)
                    : errorFor(route, 400, 'query parameters are not allowed')
            } else if (route !== null || url.pathname === '/v1/models') {
                response = errorFor(route, 405, 'method not allowed')
            } else {
                response = errorFor(null, 404, 'not found')
            }
        } catch {
            response = errorFor(route, 500, 'internal error')
        }
        logLine(request, response.status, startedAt)
        return response
    },
})

console.log(
    JSON.stringify({
        ts: new Date().toISOString(),
        event: 'listening',
        tenant,
        host: '127.0.0.1',
        port: server.port,
        routes: ['/v1/responses', '/v1/messages', '/v1/models'],
        models: MODELS,
    }),
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        server.stop(true)
        process.exit(0)
    })
}
