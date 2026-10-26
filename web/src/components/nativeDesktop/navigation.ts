export type DesktopApp = 'codex' | 'claude'
export function parseNativeSearch(search: Record<string, unknown>): { app: DesktopApp; thread?: string } {
    return {
        app: search.app === 'claude' ? 'claude' : 'codex',
        thread: typeof search.thread === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(search.thread) ? search.thread : undefined,
    }
}
export function nativeConversationLink(app: DesktopApp, id: string) {
    const url = new URL('/desktop', window.location.origin)
    url.searchParams.set('app', app)
    url.searchParams.set('thread', id)
    return url.toString()
}
