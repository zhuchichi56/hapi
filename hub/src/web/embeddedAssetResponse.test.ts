import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { serveEmbeddedAsset } from './embeddedAssetResponse'

const directory = mkdtempSync(join(tmpdir(), 'hapi-static-test-'))
const sourcePath = join(directory, 'asset.js')
const text = 'export const value = "repeat";\n'.repeat(10_000)
writeFileSync(sourcePath, text)
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const asset = { path: '/assets/index-abCD0123.js', sourcePath, mimeType: 'text/javascript; charset=utf-8' }

describe('embedded static asset delivery', () => {
    it('compresses concurrent requests once and preserves source bytes', async () => {
        const responses = await Promise.all([serveEmbeddedAsset(asset, 'gzip'), serveEmbeddedAsset(asset, 'gzip')])
        for (const response of responses) {
            expect(response.headers.get('Content-Encoding')).toBe('gzip')
            expect(response.headers.get('Vary')).toBe('Accept-Encoding')
            expect(response.headers.get('Cache-Control')).toContain('immutable')
            const body = Buffer.from(await response.arrayBuffer())
            expect(body.length).toBeLessThan(text.length / 10)
            expect(gunzipSync(body).toString()).toBe(text)
        }
    })
    it('respects explicit gzip refusal even after the compressed version is cached', async () => {
        await serveEmbeddedAsset(asset, 'gzip')
        const response = await serveEmbeddedAsset(asset, '*;q=1, gzip;q=0')
        expect(response.headers.get('Content-Encoding')).toBeNull()
        expect(await response.text()).toBe(text)
    })
    it('revalidates HTML and retains service worker no-store policy', async () => {
        const html = await serveEmbeddedAsset({ ...asset, path: '/index.html', mimeType: 'text/html' })
        expect(html.headers.get('Cache-Control')).toBe('no-cache')
        const worker = await serveEmbeddedAsset({ ...asset, path: '/sw.js' })
        expect(worker.headers.get('Cache-Control')).toContain('no-store')
        expect(worker.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store')
    })
    it('does not gzip already compressed binary assets or permanently cache stable names', async () => {
        const response = await serveEmbeddedAsset({ ...asset, path: '/assets/fonts/font.woff2', mimeType: 'font/woff2' }, 'gzip')
        expect(response.headers.get('Content-Encoding')).toBeNull()
        expect(response.headers.get('Cache-Control')).toBe('no-cache')
    })
})
