import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

const { command, api } = vi.hoisted(() => {
    const command = vi.fn()
    return { command, api: { nativeDesktopCommand: command } }
})
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api }) }))
const routing = vi.hoisted(() => ({ search: { app: 'codex' as 'codex' | 'claude', thread: 'original' as string | undefined } }))
vi.mock('@tanstack/react-router', () => ({
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
    useSearch: () => routing.search,
    useNavigate: () => () => Promise.resolve(),
}))
vi.mock('@/components/nativeDesktop/attachments', () => ({ prepareImage: async (file: File) => ({ name: file.name, data: 'data:image/png;base64,aW1hZ2U=' }) }))
vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }))
import NativeDesktopPage from './nativeDesktop'

const view = {
    id: 'original', title: 'Original desktop chat', status: 'idle', live: true, historyComplete: true,
    hasEarlier: false, before: null, revision: 'one', windowStart: 0, requests: [],
    modelSettings: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    turns: [{ id: 'native-turn', status: 'completed', items: [{ id: 'reply', key: 'reply-key', role: 'assistant', text: 'Readable reply' }] }]
}

class ResizeObserverMock {
    static instances: ResizeObserverMock[] = []
    readonly targets: Element[] = []
    private readonly callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        ResizeObserverMock.instances.push(this)
    }
    observe(target: Element) { this.targets.push(target) }
    unobserve() {}
    disconnect() {}
    trigger() { this.callback([], this as unknown as ResizeObserver) }
}

describe('native Desktop layout measurements', () => {
    beforeEach(() => {
        ResizeObserverMock.instances = []
        vi.stubGlobal('ResizeObserver', ResizeObserverMock)
        command.mockReset()
        command.mockImplementation(async (value: Record<string, unknown>) => ({ ok: true, result:
            value.op === 'list' ? { threads: [{ id: 'original', title: 'Original desktop chat', status: 'idle' }] }
            : value.op === 'models' ? { models: [{ id: 'gpt-6.1-sol', reasoningEfforts: ['high'] }] }
            : value.op === 'model-settings' ? { id: 'original', model: 'gpt-6.1-sol', reasoningEffort: 'high' }
            : view
        }))
    })
    afterEach(() => { cleanup(); vi.unstubAllGlobals() })

    it('reports the measured composer height to layout overlays', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            configurable: true,
            get() { return this.classList?.contains('nd-compose-wrap') ? 180 : 0 }
        })
        try {
            render(<NativeDesktopPage />)
            await screen.findByText('Readable reply')
            const root = document.querySelector<HTMLElement>('.nd-root')!
            await waitFor(() => expect(root.style.getPropertyValue('--nd-compose-height')).toBe('180px'))
        } finally {
            if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptor)
            else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
        }
    })

    it('follows the latest message when the composer shrinks the scroll viewport', async () => {
        render(<NativeDesktopPage />)
        await screen.findByText('Readable reply')
        const scroll = document.querySelector<HTMLElement>('.nd-scroll')!
        const observer = ResizeObserverMock.instances.find(item => item.targets.includes(scroll))
        expect(observer).toBeDefined()
        let top = 0
        Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 })
        Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 })
        Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => top, set: value => { top = value } })
        await act(async () => { observer!.trigger() })
        expect(top).toBe(1000)
    })
})
