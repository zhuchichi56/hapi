import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    resolveWebAccessLogin,
    WebAccessConfigError,
    WEB_ACCESS_CODES_FILENAME
} from './webAccessCodes'

const CLI_TOKEN = 'legacy-cli-token-0123456789abcdef'
const OWNER_CODE = 'owner-opaque-code-0123456789abcdef'
const GUEST_CODE = 'wwx-opaque-code-0123456789abcdef'

const dirs: string[] = []

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-web-codes-'))
    dirs.push(dir)
    return dir
}

function writeRegistry(dir: string, value: unknown, mode = 0o600): string {
    const path = join(dir, WEB_ACCESS_CODES_FILENAME)
    writeFileSync(path, JSON.stringify(value), { mode })
    chmodSync(path, mode)
    return path
}

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir) rmSync(dir, { recursive: true, force: true })
    }
})

describe('legacy mode (registry absent)', () => {
    it('accepts the CLI token as default namespace', () => {
        expect(resolveWebAccessLogin(tempDir(), CLI_TOKEN, CLI_TOKEN))
            .toEqual({ ok: true, namespace: 'default', mode: 'legacy' })
    })

    it('keeps CLI token namespace suffixes for compatibility', () => {
        expect(resolveWebAccessLogin(tempDir(), CLI_TOKEN, `${CLI_TOKEN}:wwx`))
            .toEqual({ ok: true, namespace: 'wwx', mode: 'legacy' })
    })

    it('rejects a wrong base token', () => {
        expect(resolveWebAccessLogin(tempDir(), CLI_TOKEN, 'wrong-base:default'))
            .toEqual({ ok: false })
    })
})

describe('registry mode', () => {
    it('allows the owner code to resolve default', () => {
        const dir = tempDir()
        writeRegistry(dir, {
            version: 1,
            codes: [{ code: OWNER_CODE, namespace: 'default' }]
        })
        expect(resolveWebAccessLogin(dir, CLI_TOKEN, OWNER_CODE))
            .toEqual({ ok: true, namespace: 'default', mode: 'registry' })
    })

    it('allows the guest code to resolve only its fixed namespace', () => {
        const dir = tempDir()
        writeRegistry(dir, {
            version: 1,
            codes: [
                { code: OWNER_CODE, namespace: 'default' },
                { code: GUEST_CODE, namespace: 'wwx' }
            ]
        })
        expect(resolveWebAccessLogin(dir, CLI_TOKEN, GUEST_CODE))
            .toEqual({ ok: true, namespace: 'wwx', mode: 'registry' })
    })

    it('rejects suffix manipulation, extension and truncation of a guest code', () => {
        const dir = tempDir()
        writeRegistry(dir, {
            version: 1,
            codes: [{ code: GUEST_CODE, namespace: 'wwx' }]
        })
        for (const candidate of [
            `${GUEST_CODE}:default`,
            `${GUEST_CODE}x`,
            GUEST_CODE.slice(0, -1),
            `x${GUEST_CODE}`,
            ` ${GUEST_CODE}`
        ]) {
            expect(resolveWebAccessLogin(dir, CLI_TOKEN, candidate)).toEqual({ ok: false })
        }
    })

    it('rejects the root CLI token when a registry exists', () => {
        const dir = tempDir()
        writeRegistry(dir, {
            version: 1,
            codes: [{ code: GUEST_CODE, namespace: 'wwx' }]
        })
        expect(resolveWebAccessLogin(dir, CLI_TOKEN, CLI_TOKEN)).toEqual({ ok: false })
        expect(resolveWebAccessLogin(dir, CLI_TOKEN, `${CLI_TOKEN}:default`)).toEqual({ ok: false })
    })

    it('accepts the CLI token only when its literal value is explicitly listed', () => {
        const dir = tempDir()
        writeRegistry(dir, {
            version: 1,
            codes: [{ code: CLI_TOKEN, namespace: 'default' }]
        })
        expect(resolveWebAccessLogin(dir, CLI_TOKEN, CLI_TOKEN))
            .toEqual({ ok: true, namespace: 'default', mode: 'registry' })
    })

    it('re-reads the registry so a revoked code stops working', () => {
        const dir = tempDir()
        writeRegistry(dir, {
            version: 1,
            codes: [{ code: GUEST_CODE, namespace: 'wwx' }]
        })
        expect(resolveWebAccessLogin(dir, CLI_TOKEN, GUEST_CODE).ok).toBe(true)

        writeRegistry(dir, {
            version: 1,
            codes: [{ code: OWNER_CODE, namespace: 'default' }]
        })
        expect(resolveWebAccessLogin(dir, CLI_TOKEN, GUEST_CODE)).toEqual({ ok: false })
    })
})

describe('fail-closed configuration errors', () => {
    it('throws on malformed JSON', () => {
        const dir = tempDir()
        writeFileSync(join(dir, WEB_ACCESS_CODES_FILENAME), '{ not json', { mode: 0o600 })
        chmodSync(join(dir, WEB_ACCESS_CODES_FILENAME), 0o600)
        expect(() => resolveWebAccessLogin(dir, CLI_TOKEN, OWNER_CODE))
            .toThrow(WebAccessConfigError)
    })

    it('throws on group/other permissions', () => {
        const dir = tempDir()
        writeRegistry(dir, {
            version: 1,
            codes: [{ code: OWNER_CODE, namespace: 'default' }]
        }, 0o644)
        expect(() => resolveWebAccessLogin(dir, CLI_TOKEN, OWNER_CODE))
            .toThrow(WebAccessConfigError)
    })

    it('throws on duplicate codes', () => {
        const dir = tempDir()
        writeRegistry(dir, {
            version: 1,
            codes: [
                { code: OWNER_CODE, namespace: 'default' },
                { code: OWNER_CODE, namespace: 'wwx' }
            ]
        })
        expect(() => resolveWebAccessLogin(dir, CLI_TOKEN, OWNER_CODE))
            .toThrow(WebAccessConfigError)
    })

    it('throws on an invalid namespace', () => {
        const dir = tempDir()
        writeRegistry(dir, {
            version: 1,
            codes: [{ code: OWNER_CODE, namespace: '../default' }]
        })
        expect(() => resolveWebAccessLogin(dir, CLI_TOKEN, OWNER_CODE))
            .toThrow(WebAccessConfigError)
    })

    it('throws on an unsupported version or empty code list', () => {
        const dir = tempDir()
        writeRegistry(dir, { version: 2, codes: [{ code: OWNER_CODE, namespace: 'default' }] })
        expect(() => resolveWebAccessLogin(dir, CLI_TOKEN, OWNER_CODE))
            .toThrow(WebAccessConfigError)

        writeRegistry(dir, { version: 1, codes: [] })
        expect(() => resolveWebAccessLogin(dir, CLI_TOKEN, OWNER_CODE))
            .toThrow(WebAccessConfigError)
    })

    it('throws on a symlinked registry', () => {
        const dir = tempDir()
        const target = writeRegistry(dir, {
            version: 1,
            codes: [{ code: OWNER_CODE, namespace: 'default' }]
        })
        const link = join(dir, 'link.json')
        symlinkSync(target, link)
        rmSync(join(dir, WEB_ACCESS_CODES_FILENAME))
        // Rename the link to the canonical filename.
        symlinkSync(target, join(dir, WEB_ACCESS_CODES_FILENAME))
        expect(() => resolveWebAccessLogin(dir, CLI_TOKEN, OWNER_CODE))
            .toThrow(WebAccessConfigError)
    })
})
