import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
afterEach(() => {vi.unstubAllEnvs();vi.resetModules()})
it('hides configured test entries and exact parent roots while keeping project history available', async () => {
    vi.stubEnv('VITE_HAPI_HIDDEN_SESSION_IDS', 'probe')
    vi.stubEnv('VITE_HAPI_HIDDEN_PROJECT_DIRECTORIES', '/Users/zhuhe/Workspaces')
    vi.resetModules()
    const {filterSidebarMachines} = await import('./sidebarVisibility')
    const sessions = [
        {id:'probe',metadata:{path:'/Users/zhuhe/Workspaces/wwx'}},
        {id:'parent',metadata:{path:'/Users/zhuhe/Workspaces'}},
        {id:'wwx',metadata:{path:'/Users/zhuhe/Workspaces/wwx'}},
        {id:'rjj',metadata:{path:'/Users/zhuhe/Workspaces/ruanjingjing'}}
    ] as SessionSummary[]
    expect(filterSidebarMachines(sessions,new Set()).map(s=>s.id)).toEqual(['wwx','rjj'])
    expect(sessions).toHaveLength(4)
})
