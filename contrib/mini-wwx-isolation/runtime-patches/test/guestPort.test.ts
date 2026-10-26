import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseGuestPort, reserveGuestPort } from '../src/utils/guestPort'

let home: string
const saved = { ...process.env }

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hapi-guest-port-'))
    process.env.HAPI_HOME = home
    delete process.env.HAPI_GUEST_PORT_MIN
    delete process.env.HAPI_GUEST_PORT_MAX
})

afterEach(() => {
    for (const key of ['HAPI_HOME', 'HAPI_GUEST_PORT_MIN', 'HAPI_GUEST_PORT_MAX']) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
    }
    rmSync(home, { recursive: true, force: true })
})

function setRange(min: string | undefined, max: string | undefined): void {
    if (min === undefined) delete process.env.HAPI_GUEST_PORT_MIN
    else process.env.HAPI_GUEST_PORT_MIN = min
    if (max === undefined) delete process.env.HAPI_GUEST_PORT_MAX
    else process.env.HAPI_GUEST_PORT_MAX = max
}

describe('reserveGuestPort', () => {
    test('is a no-op only when both bounds are absent', () => {
        expect(reserveGuestPort()).toBe(0)
    })

    test('allocates distinct port literals inside the range', () => {
        setRange('43100', '43103')
        const ports = [reserveGuestPort('a'), reserveGuestPort('b'), reserveGuestPort('c')]
        expect(ports).toEqual([43100, 43101, 43102])
        releaseGuestPort(ports[0]!)
        expect(reserveGuestPort('d')).toBe(43100)
    })

    test('honours an explicit preferred port first', () => {
        setRange('43100', '43103')
        expect(reserveGuestPort('runner-control', 43102)).toBe(43102)
    })

    test('ignores a preferred port outside the allowed range', () => {
        setRange('43100', '43103')
        expect(reserveGuestPort('runner-control', 3026)).toBe(43100)
    })

    test('fails closed on a partial range instead of returning 0', () => {
        setRange('43100', undefined)
        expect(() => reserveGuestPort()).toThrow(/must be set together/)
        setRange(undefined, '43131')
        expect(() => reserveGuestPort()).toThrow(/must be set together/)
    })

    test('fails closed on an invalid configured range', () => {
        setRange('', '')
        expect(() => reserveGuestPort()).toThrow(/must be set together/)
        setRange('5000', '4000')
        expect(() => reserveGuestPort()).toThrow(/invalid guest port range/)
        setRange('not-a-port', '43103')
        expect(() => reserveGuestPort()).toThrow(/must be integers/)
    })

    test('does not reclaim a fresh mkdir before its pid is written', () => {
        setRange('43100', '43101')
        const lock = join(home, 'tmp', 'guest-ports', '43100')
        mkdirSync(lock, { recursive: true })
        expect(reserveGuestPort()).toBe(43101)
    })

    test('does not reclaim a fresh lock with a partially-written pid', () => {
        setRange('43100', '43101')
        const lock = join(home, 'tmp', 'guest-ports', '43100')
        mkdirSync(lock, { recursive: true })
        writeFileSync(join(lock, 'pid'), '')
        expect(reserveGuestPort()).toBe(43101)
    })

    test('reclaims an old reservation whose PID is gone', () => {
        setRange('43100', '43100')
        const lock = join(home, 'tmp', 'guest-ports', '43100')
        mkdirSync(lock, { recursive: true })
        writeFileSync(join(lock, 'pid'), '999999\n')
        const old = new Date(Date.now() - 60_000)
        utimesSync(lock, old, old)
        expect(reserveGuestPort()).toBe(43100)
    })

    test('fails closed instead of falling back to port 0 when exhausted', () => {
        setRange('43100', '43100')
        expect(reserveGuestPort()).toBe(43100)
        expect(() => reserveGuestPort()).toThrow(/no free guest port/)
    })

    test('four concurrent processes reclaim stale locks without duplicate ports', async () => {
        for(let port=43100;port<43112;port++){
            const lock=join(home,'tmp','guest-ports',String(port));mkdirSync(lock,{recursive:true});writeFileSync(join(lock,'pid'),'999999\n');const old=new Date(Date.now()-60000);utimesSync(lock,old,old)
        }
        const fixture = new URL('./fixtures/reserve.ts', import.meta.url).pathname
        const env = {
            ...process.env,
            HAPI_HOME: home,
            HAPI_GUEST_PORT_MIN: '43100',
            HAPI_GUEST_PORT_MAX: '43131',
        }
        const procs = Array.from({ length: 4 }, () =>
            Bun.spawn([process.execPath, fixture], { env, stdout: 'pipe', stderr: 'pipe' }),
        )
        const outputs = await Promise.all(procs.map(async (p) => {
            const [out, err, code] = await Promise.all([
                new Response(p.stdout).text(),
                new Response(p.stderr).text(),
                p.exited,
            ])
            if (code !== 0) throw new Error(`fixture failed (${code}): ${err}`)
            return JSON.parse(out.trim()) as number[]
        }))
        const ports = outputs.flat()
        expect(ports).toHaveLength(12)
        expect(new Set(ports).size).toBe(12)
        expect(ports.every((p) => p >= 43100 && p <= 43131)).toBe(true)
    })
})
