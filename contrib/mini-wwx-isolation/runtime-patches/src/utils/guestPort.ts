/**
 * HAPI_GUEST_PORTS_V1
 *
 * Bounded, cross-process loopback port allocator for isolated HAPI guests.
 *
 * When HAPI_GUEST_PORT_MIN / HAPI_GUEST_PORT_MAX are unset this module is a
 * no-op and callers keep their historical port-0 behaviour (owner runtime is
 * unchanged). When they are set, every caller receives a port inside the
 * configured range, reserved with an atomic directory under
 * $HAPI_HOME/tmp/guest-ports so the runner and all agent sessions never pick
 * the same port. Stale reservations from dead PIDs are reclaimed.
 *
 * The range must match the exact literals allowed by the guest Seatbelt
 * profile. Seatbelt rejects port ranges, so the profile lists every port.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HAPI_GUEST_PORTS_V1 = 'HAPI_GUEST_PORTS_V1'

// A lock directory is created before its pid file is written. A concurrent
// allocator must not reclaim that freshly-created directory, so missing or
// malformed pid data is only treated as stale after this grace period.
const LOCK_WRITE_GRACE_MS = 5_000

const held = new Set<number>()
let cleanupRegistered = false

function guestHome(): string {
    return process.env.HAPI_HOME && process.env.HAPI_HOME.trim() !== ''
        ? process.env.HAPI_HOME
        : join(homedir(), '.hapi')
}

function range(): { min: number; max: number } | null {
    const minRaw = process.env.HAPI_GUEST_PORT_MIN
    const maxRaw = process.env.HAPI_GUEST_PORT_MAX
    const hasMin = minRaw !== undefined && minRaw.trim() !== ''
    const hasMax = maxRaw !== undefined && maxRaw.trim() !== ''
    if (minRaw === undefined && maxRaw === undefined) return null // legacy owner runtime: keep port 0
    if (!hasMin || !hasMax) {
        throw new Error(
            `${HAPI_GUEST_PORTS_V1}: HAPI_GUEST_PORT_MIN and HAPI_GUEST_PORT_MAX must be set together`,
        )
    }
    const min = Number(minRaw)
    const max = Number(maxRaw)
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
        throw new Error(`${HAPI_GUEST_PORTS_V1}: guest port bounds must be integers`)
    }
    if (min < 1024 || max > 65535 || min > max) {
        throw new Error(
            `${HAPI_GUEST_PORTS_V1}: invalid guest port range ${minRaw}..${maxRaw} (need 1024<=min<=max<=65535)`,
        )
    }
    return { min, max }
}

function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'EPERM'
    }
}

function lockIsStale(lockDir: string): boolean {
    let ageMs: number
    try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs
    } catch {
        return true // directory vanished: caller will race mkdir and lose safely
    }
    if (ageMs < LOCK_WRITE_GRACE_MS) {
        // Fresh mkdir, possibly before the owning process wrote its pid.
        return false
    }
    const pidFile = join(lockDir, 'pid')
    if (!existsSync(pidFile)) return true
    try {
        return !pidAlive(Number(readFileSync(pidFile, 'utf8').trim()))
    } catch {
        return true
    }
}

function releaseAll(): void {
    for (const port of held) {
        try {
            rmSync(join(guestHome(), 'tmp', 'guest-ports', String(port)), { recursive: true, force: true })
        } catch {
            // Best effort on exit; a stale lock is reclaimed by the next process.
        }
    }
    held.clear()
}

function registerCleanup(): void {
    if (cleanupRegistered) return
    cleanupRegistered = true
    // Only the exit event: installing SIGINT/SIGTERM handlers here would change
    // HAPI's own shutdown behaviour. Stale locks from signals are reclaimed by
    // the next allocator through the PID liveness check.
    process.once('exit', releaseAll)
}

function tryReserve(root: string, port: number, kind: string): boolean {
    const lockDir = join(root, String(port))
    try {
        mkdirSync(lockDir, { mode: 0o700 })
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return false
        if (!lockIsStale(lockDir)) return false
        const reaper = lockDir + '.reap'
        try { mkdirSync(reaper, { mode: 0o700 }) } catch { return false }
        try {
            // Serialize stale cleanup and recheck after taking the guard.
            if (!lockIsStale(lockDir)) return false
            rmSync(lockDir, { recursive: true, force: true })
            mkdirSync(lockDir, { mode: 0o700 })
        } catch {
            return false
        } finally {
            rmSync(reaper, { recursive: true, force: true })
        }
    }
    try {
        writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`, { mode: 0o600 })
        writeFileSync(join(lockDir, 'kind'), `${kind}\n`, { mode: 0o600 })
    } catch {
        try {
            rmSync(lockDir, { recursive: true, force: true })
        } catch {
            // ignore
        }
        return false
    }
    held.add(port)
    registerCleanup()
    return true
}

/**
 * Reserve one port for this process. `preferred` is tried first (used for the
 * runner control port so it is stable); the rest of the range is scanned.
 * Returns 0 only when the bounded mode is disabled, preserving old behaviour.
 * Throws when the bounded mode is enabled but no port is free: fail closed.
 */
export function reserveGuestPort(kind = 'generic', preferred = 0): number {
    const bounds = range()
    if (!bounds) return 0
    const root = join(guestHome(), 'tmp', 'guest-ports')
    mkdirSync(root, { recursive: true, mode: 0o700 })

    if (Number.isInteger(preferred) && preferred >= bounds.min && preferred <= bounds.max) {
        if (tryReserve(root, preferred, kind)) return preferred
    }
    for (let port = bounds.min; port <= bounds.max; port++) {
        if (tryReserve(root, port, kind)) return port
    }
    throw new Error(
        `${HAPI_GUEST_PORTS_V1}: no free guest port in ${bounds.min}..${bounds.max}; refusing dynamic fallback`,
    )
}

/** Test/helper only. Normal processes release on exit. */
export function releaseGuestPort(port: number): void {
    try {
        rmSync(join(guestHome(), 'tmp', 'guest-ports', String(port)), { recursive: true, force: true })
    } finally {
        held.delete(port)
    }
}
