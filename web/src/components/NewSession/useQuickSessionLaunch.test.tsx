import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type PropsWithChildren } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { savePreferredLaunchSettings } from './preferences'
import { useQuickSessionLaunch } from './useQuickSessionLaunch'

const mocks = vi.hoisted(() => ({
    spawnSession: vi.fn(),
    addRecentPath: vi.fn(),
    setLastUsedMachineId: vi.fn(),
}))
vi.mock('@/hooks/mutations/useSpawnSession', () => ({ useSpawnSession: () => ({ spawnSession: mocks.spawnSession }) }))
vi.mock('@/hooks/useRecentPaths', () => ({ useRecentPaths: () => mocks }))

const preset = { machineId: 'mac', directory: '/Users/example' }
function wrapper({ children }: PropsWithChildren) {
    const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
    return <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider>
}
const machines = [{ id: 'mac', active: true }, { id: 'other', active: true }] as Machine[]

function harness(overrides: Partial<Pick<ApiClient, 'getMachineCodexModels' | 'checkMachinePathsExists'>> = {}) {
    const api = {
        getMachineCodexModels: vi.fn().mockResolvedValue({
            success: true,
            models: [{ id: 'gpt-6.1-sol', supportedReasoningEfforts: ['low', 'medium', 'ultra'] }],
        }),
        checkMachinePathsExists: vi.fn().mockImplementation((_machine, paths: string[]) => Promise.resolve({
            exists: Object.fromEntries(paths.map(path => [path, true])),
        })),
        ...overrides,
    } as unknown as ApiClient
    return { api, ...renderHook(() => useQuickSessionLaunch(api, machines, preset), { wrapper }) }
}

describe('personal quick session launch', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        localStorage.clear()
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'new-chat' })
    })
    afterEach(cleanup)

    it('launches the requested preset instead of remembered agent/model/effort and preserves permissions', async () => {
        localStorage.setItem('hapi:newSession:agent', 'claude')
        savePreferredLaunchSettings('mac', 'codex', {
            model: 'gpt-6-sol', cursorSelectedBase: 'auto', effort: 'auto',
            modelReasoningEffort: 'ultra', permissionMode: 'yolo',
        })
        const { result } = harness()
        await act(async () => expect(await result.current.launch()).toBe('new-chat'))
        expect(mocks.spawnSession).toHaveBeenCalledWith({
            machineId: 'mac', directory: '/Users/example', agent: 'codex',
            model: 'gpt-6.1-sol', modelReasoningEffort: 'medium', permissionMode: 'yolo',
            sessionType: 'simple', collaborationMode: 'default',
        })
        expect(mocks.addRecentPath).toHaveBeenCalledWith('mac', '/Users/example')
        expect(mocks.setLastUsedMachineId).toHaveBeenCalledWith('mac')
    })

    it('prewarms and reuses verified model discovery across repeated launches', async () => {
        const { api, result } = harness()
        await act(async () => {})
        expect(api.getMachineCodexModels).toHaveBeenCalledTimes(1)
        await act(async () => { await result.current.launch(); await result.current.launch() })
        expect(api.getMachineCodexModels).toHaveBeenCalledTimes(1)
        // Workspace checks remain fresh for every click.
        expect(api.checkMachinePathsExists).toHaveBeenCalledTimes(2)
    })

    it('uses the directory and machine of an explicit project action', async () => {
        const { api, result } = harness()
        await act(async () => { await result.current.launch({ machineId: 'other', directory: '/project' }) })
        expect(api.getMachineCodexModels).toHaveBeenCalledWith('other')
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'other', directory: '/project', permissionMode: 'default' }))
    })

    it('does not guess a machine for an unassociated project', async () => {
        const { result } = harness()
        await act(async () => { await expect(result.current.launch({ machineId: null, directory: '/project' })).rejects.toThrow('no associated machine') })
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it.each([
        ['codex', 'yolo'],
        ['claude', 'default'],
    ])('migrates the legacy permission preference only for its original agent: %s', async (agent, permissionMode) => {
        localStorage.setItem('hapi:newSession:agent', agent)
        localStorage.setItem('hapi:newSession:yolo', 'true')
        const { result } = harness()
        await act(async () => { await result.current.launch() })
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode }))
    })

    it('does not fall back to another online machine when the target is offline', async () => {
        const { result } = renderHook(() => useQuickSessionLaunch({} as ApiClient, [machines[1]], preset), { wrapper })
        await act(async () => { await expect(result.current.launch()).rejects.toThrow('offline') })
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it.each([
        { success: true, models: [{ id: 'gpt-6.1-sol', supportedReasoningEfforts: ['low'] }] },
        { success: true, models: [{ id: 'gpt-6-sol', supportedReasoningEfforts: ['medium'] }] },
        { success: false, error: 'Catalog unavailable' },
    ])('fails closed when the exact model/effort cannot be verified: %j', async (catalog) => {
        const { result } = harness({ getMachineCodexModels: vi.fn().mockResolvedValue(catalog) })
        await act(async () => { await expect(result.current.launch()).rejects.toThrow() })
        expect(mocks.spawnSession).not.toHaveBeenCalled()
        expect(result.current.isPending).toBe(false)
    })

    it.each([
        { exists: { '/Users/example': false } },
        { exists: { '/Users/example': true }, outsideWorkspaceRoots: ['/Users/example'] },
    ])('does not create missing or excluded directories: %j', async (paths) => {
        const { result } = harness({ checkMachinePathsExists: vi.fn().mockResolvedValue(paths) })
        await act(async () => { await expect(result.current.launch()).rejects.toThrow('working directory') })
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('deduplicates rapid clicks during preflight and spawn', async () => {
        let finish!: (value: { type: 'success'; sessionId: string }) => void
        mocks.spawnSession.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        const { result } = harness()
        let launch!: Promise<string | null>
        await act(async () => {
            launch = result.current.launch()
            await expect(result.current.launch()).resolves.toBeNull()
        })
        expect(result.current.isPending).toBe(true)
        await act(async () => {
            await expect(result.current.launch()).resolves.toBeNull()
            finish({ type: 'success', sessionId: 'one-chat' })
            await expect(launch).resolves.toBe('one-chat')
        })
        expect(mocks.spawnSession).toHaveBeenCalledTimes(1)
        expect(result.current.isPending).toBe(false)
    })

    it('permits an explicit retry after a failed spawn without saving a successful path', async () => {
        mocks.spawnSession.mockResolvedValueOnce({ type: 'error', message: 'Spawn failed' })
        const { result } = harness()
        await act(async () => { await expect(result.current.launch()).rejects.toThrow('Spawn failed') })
        expect(mocks.addRecentPath).not.toHaveBeenCalled()
        expect(result.current.isPending).toBe(false)
        await act(async () => { await expect(result.current.launch()).resolves.toBe('new-chat') })
        expect(mocks.spawnSession).toHaveBeenCalledTimes(2)
    })
})
