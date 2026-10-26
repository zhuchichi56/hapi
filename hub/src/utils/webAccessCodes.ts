import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAccessToken } from './accessToken'

/**
 * Independent, opaque web access codes.
 *
 * The file lives at `<HAPI dataDir>/web-access-codes.json` and is the single
 * authority for web login once it exists. Codes are matched byte-for-byte and
 * are never parsed for a `:namespace` suffix; the namespace is whatever the
 * protected file maps that exact code to.
 *
 * - File absent  -> legacy CLI_API_TOKEN behavior (base token + optional suffix).
 * - File present -> only codes in the file may log in. Invalid, insecure or
 *   unreadable file fails closed: callers must return 503, not fall back.
 */

export const WEB_ACCESS_CODES_FILENAME = 'web-access-codes.json'

const MAX_FILE_BYTES = 64 * 1024
const MAX_CODES = 128
const CODE_MIN_LENGTH = 16
const CODE_MAX_LENGTH = 256
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type WebAccessCodeEntry = {
    code: string
    namespace: string
}

export type WebAccessCodeRegistry = {
    version: 1
    codes: WebAccessCodeEntry[]
}

export type WebAccessLoginResult =
    | { ok: true; namespace: string; mode: 'registry' | 'legacy' }
    | { ok: false }

export class WebAccessConfigError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'WebAccessConfigError'
    }
}

function fail(message: string): never {
    throw new WebAccessConfigError(message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest()
}

/** Constant-time equality for arbitrary-length strings. */
function safeEqual(left: string, right: string): boolean {
    return timingSafeEqual(sha256(left), sha256(right))
}

function parseRegistry(text: string): WebAccessCodeRegistry {
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch {
        return fail('Web access code file is not valid JSON')
    }

    if (!isPlainObject(raw) || raw.version !== 1) {
        return fail('Web access code file has an unsupported version')
    }
    if (!Array.isArray(raw.codes) || raw.codes.length === 0 || raw.codes.length > MAX_CODES) {
        return fail('Web access code file must contain 1..' + MAX_CODES + ' codes')
    }

    const seen = new Set<string>()
    const codes: WebAccessCodeEntry[] = []
    for (const value of raw.codes) {
        if (!isPlainObject(value)) {
            return fail('Web access code entry must be an object')
        }
        const { code, namespace } = value
        if (typeof code !== 'string' || typeof namespace !== 'string') {
            return fail('Web access code entry requires string code and namespace')
        }
        if (code.length < CODE_MIN_LENGTH || code.length > CODE_MAX_LENGTH) {
            return fail('Web access code has an invalid length')
        }
        if (code.trim() !== code || /[\s\u0000-\u001f\u007f]/.test(code)) {
            return fail('Web access code must not contain whitespace or control characters')
        }
        if (!NAMESPACE_PATTERN.test(namespace)) {
            return fail('Web access code namespace is invalid')
        }
        if (seen.has(code)) {
            return fail('Web access code file contains duplicate codes')
        }
        seen.add(code)
        codes.push({ code, namespace })
    }

    return { version: 1, codes }
}

/**
 * Read and validate the registry. Returns null only when the file does not
 * exist. Every other failure throws WebAccessConfigError (fail closed).
 */
export function loadWebAccessCodeRegistry(dataDir: string): WebAccessCodeRegistry | null {
    const path = join(dataDir, WEB_ACCESS_CODES_FILENAME)

    let fd: number
    try {
        // O_NOFOLLOW rejects symlinks at open time; fstat then validates the
        // object actually opened, avoiding a lstat/open TOCTOU window.
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null
        }
        return fail('Web access code file cannot be opened securely')
    }

    try {
        const stat = fstatSync(fd)
        if (!stat.isFile()) {
            return fail('Web access code file must be a regular file')
        }
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            return fail('Web access code file must be owned by the hub process user')
        }
        if ((stat.mode & 0o777) !== 0o600) {
            return fail('Web access code file must have mode 0600')
        }
        if (stat.size > MAX_FILE_BYTES) {
            return fail('Web access code file is too large')
        }

        let text: string
        try {
            text = readFileSync(fd, 'utf8')
        } catch {
            return fail('Web access code file cannot be read')
        }
        return parseRegistry(text)
    } finally {
        closeSync(fd)
    }
}

/**
 * Resolve a presented web access token to a namespace.
 *
 * With a registry present, only exact registry codes are accepted; the CLI
 * token is rejected unless its literal value is itself listed as a code.
 * Without a registry, legacy CLI_API_TOKEN parsing is preserved.
 *
 * Throws WebAccessConfigError when the registry exists but is invalid or
 * cannot be read; callers must treat that as 503 and must not fall back.
 */
export function resolveWebAccessLogin(
    dataDir: string,
    cliApiToken: string,
    presentedToken: string
): WebAccessLoginResult {
    const registry = loadWebAccessCodeRegistry(dataDir)

    if (registry) {
        if (!presentedToken) {
            return { ok: false }
        }

        // Compare against every entry to avoid an early-exit timing signal.
        let matchedNamespace: string | null = null
        for (const entry of registry.codes) {
            if (safeEqual(presentedToken, entry.code)) {
                matchedNamespace = entry.namespace
            }
        }

        return matchedNamespace
            ? { ok: true, namespace: matchedNamespace, mode: 'registry' }
            : { ok: false }
    }

    const parsed = parseAccessToken(presentedToken)
    if (!parsed || !safeEqual(parsed.baseToken, cliApiToken)) {
        return { ok: false }
    }
    return { ok: true, namespace: parsed.namespace, mode: 'legacy' }
}
