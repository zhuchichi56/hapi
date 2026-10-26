/** macOS guest process queries without executing the system setuid ps binary. */
import { dlopen, FFIType, ptr } from 'bun:ffi'
const libproc = dlopen('/usr/lib/libproc.dylib', {
    proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 }
})
const system = dlopen('/usr/lib/libSystem.B.dylib', {
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 }
})
export function guestProcessStartMarker(pid: number): string | null {
    if (!Number.isSafeInteger(pid) || pid < 1) return null
    const buffer = new Uint8Array(136) // Darwin proc_bsdinfo, PROC_PIDTBSDINFO=3.
    if (libproc.symbols.proc_pidinfo(pid, 3, 0, ptr(buffer), buffer.length) !== buffer.length) return null
    const view = new DataView(buffer.buffer)
    const sec = view.getBigUint64(120, true), usec = view.getBigUint64(128, true)
    return sec > 0n ? `darwin:${sec}:${usec}` : null
}
export function guestProcessCommandLine(pid: number): string | null {
    if (!Number.isSafeInteger(pid) || pid < 1) return null
    const mib = new Int32Array([1, 49, pid]) // CTL_KERN, KERN_PROCARGS2.
    const buffer = new Uint8Array(1024 * 1024)
    const size = new BigUint64Array([BigInt(buffer.length)])
    if (system.symbols.sysctl(ptr(mib), mib.length, ptr(buffer), ptr(size), null, 0) !== 0) return null
    const end = Number(size[0]); if (end < 5 || end > buffer.length) return null
    const argc = new DataView(buffer.buffer).getInt32(0, true)
    if (argc < 1 || argc > 65536) return null
    let at = 4; while (at < end && buffer[at] !== 0) at++ // executable path
    while (at < end && buffer[at] === 0) at++
    const args: string[] = []; const decoder = new TextDecoder()
    for (let i = 0; i < argc && at < end; i++) {
        const start = at; while (at < end && buffer[at] !== 0) at++
        args.push(decoder.decode(buffer.subarray(start, at))); at++
    }
    return args.length === argc ? args.join(' ') : null
}

export function guestProcessSnapshots(): {pid:number;ppid:number;cmd:string;startMarker:string}[] {
    const pids = new Int32Array(16384)
    const bytes = libproc.symbols.proc_listpids(4, process.getuid!(), ptr(pids), pids.byteLength)
    if (bytes <= 0 || bytes >= pids.byteLength || bytes % 4) throw Error('Guest process enumeration failed')
    const result: {pid:number;ppid:number;cmd:string;startMarker:string}[] = []
    for (const pid of pids.subarray(0, bytes / 4)) {
        if (pid < 1) continue
        const before = guestProcessStartMarker(pid); if (!before) continue
        const cmd = guestProcessCommandLine(pid); if (!cmd) continue
        const info = new Uint8Array(136)
        if (libproc.symbols.proc_pidinfo(pid, 3, 0, ptr(info), info.length) !== info.length) continue
        if (guestProcessStartMarker(pid) !== before) continue // PID reuse while reading argv.
        result.push({pid,ppid:new DataView(info.buffer).getUint32(16,true),cmd,startMarker:before})
    }
    return result
}
export function guestProcessTree(root: number): number[] | 'scan_failed' {
    try {
        const rows = guestProcessSnapshots()
        if (!rows.some(p => p.pid === root)) return 'scan_failed'
        const seen = new Set<number>(), out: number[] = []
        const visit = (pid:number) => { if(seen.has(pid)) return;seen.add(pid);for(const p of rows)if(p.ppid===pid)visit(p.pid);out.push(pid) }
        visit(root); return out
    } catch { return 'scan_failed' }
}
