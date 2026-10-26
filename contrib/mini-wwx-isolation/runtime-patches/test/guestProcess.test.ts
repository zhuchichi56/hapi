import {expect,test} from 'bun:test'
import {guestProcessStartMarker,guestProcessCommandLine,guestProcessSnapshots,guestProcessTree} from '../src/utils/guestProcess'

test('native process generation is stable and argv identifies this process',()=>{
    const marker=guestProcessStartMarker(process.pid)
    expect(marker).toMatch(/^darwin:\d+:\d+$/)
    expect(guestProcessStartMarker(process.pid)).toBe(marker)
    expect(guestProcessCommandLine(process.pid)).toContain('guestProcess.test.ts')
})
test('same-user snapshot includes this exact process generation',()=>{
    const self=guestProcessSnapshots().find(p=>p.pid===process.pid)
    expect(self?.startMarker).toBe(guestProcessStartMarker(process.pid))
})
test('child tree discovery and signaling work in the guest sandbox',async()=>{
    const child=Bun.spawn([process.execPath,'-e','console.log("ready");setTimeout(()=>{},30000)'],{stdout:'pipe',stderr:'pipe'})
    try{
        const reader=child.stdout.getReader();await reader.read();reader.releaseLock()
        const tree=guestProcessTree(process.pid)
        expect(Array.isArray(tree)).toBe(true)
        expect(tree).toContain(child.pid)
        child.kill('SIGTERM');await child.exited
    }finally{try{child.kill('SIGKILL')}catch{}}
})
test('sandbox cannot inspect or signal the owner hub',()=>{
    const pid=Number(process.env.OWNER_HUB_PID)
    if(!Number.isSafeInteger(pid)||pid<1)throw Error('Set OWNER_HUB_PID for the real sandbox check')
    expect(guestProcessStartMarker(pid)).toBeNull()
    expect(guestProcessCommandLine(pid)).toBeNull()
    expect(()=>process.kill(pid,0)).toThrow()
})
