import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import type { EmbeddedWebAsset } from './embeddedAssets'
import { acceptsGzip } from './sseCompression'

const compress = promisify(gzip)
const compressedAssets = new WeakMap<EmbeddedWebAsset, Promise<Uint8Array<ArrayBuffer>>>()

function isCompressible(asset: EmbeddedWebAsset): boolean {
    return /^(text\/|application\/(javascript|json)|image\/svg\+xml)/.test(asset.mimeType)
}

/** Cache immutable build assets and compress text once without blocking the Hub. */
export async function serveEmbeddedAsset(asset: EmbeddedWebAsset, acceptEncoding?: string): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': asset.mimeType }
    if (asset.path === '/sw.js') {
        headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
        headers['CDN-Cache-Control'] = 'no-store'
        headers['Cloudflare-CDN-Cache-Control'] = 'no-store'
    } else if (/^\/assets\/.*-[\w-]{8,}\.[\w]+$/.test(asset.path)) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    } else {
        // HTML and other stable URLs must discover a new build on reload.
        headers['Cache-Control'] = 'no-cache'
    }

    if (isCompressible(asset)) {
        headers.Vary = 'Accept-Encoding'
        if (acceptsGzip(acceptEncoding)) {
            let compressed = compressedAssets.get(asset)
            if (!compressed) {
                compressed = Bun.file(asset.sourcePath).arrayBuffer()
                    .then(buffer => compress(Buffer.from(buffer)))
                    .then(buffer => new Uint8Array(buffer))
                    .catch(error => { compressedAssets.delete(asset); throw error })
                compressedAssets.set(asset, compressed)
            }
            headers['Content-Encoding'] = 'gzip'
            return new Response(await compressed, { headers })
        }
    }
    return new Response(Bun.file(asset.sourcePath), { headers })
}
