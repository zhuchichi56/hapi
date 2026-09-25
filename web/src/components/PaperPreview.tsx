import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'

const MAX_PDF_BYTES = 20 * 1024 * 1024

export function PaperPreview({ api, sessionId }: { api: ApiClient; sessionId: string }) {
    const storageKey = `hapi.paper-preview.${sessionId}`
    const [path, setPath] = useState(() => localStorage.getItem(storageKey) || 'main.pdf')
    const [draftPath, setDraftPath] = useState(path)
    const [pdfUrl, setPdfUrl] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [refresh, setRefresh] = useState(0)
    const pdfUrlRef = useRef<string | null>(null)

    const openPath = useCallback(() => {
        const nextPath = draftPath.trim()
        if (!nextPath) return
        localStorage.setItem(storageKey, nextPath)
        if (nextPath !== path) {
            if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current)
            pdfUrlRef.current = null
            setPdfUrl(null)
        }
        setError(null)
        setPath(nextPath)
        setRefresh(value => value + 1)
    }, [draftPath, path, storageKey])

    useEffect(() => {
        let cancelled = false
        let checking = false
        let lastModified: number | undefined
        let lastSize: number | undefined

        const check = async () => {
            if (checking || document.hidden) return
            checking = true
            try {
                const metadata = await api.statSessionFile(sessionId, path)
                if (!metadata.success) throw new Error(metadata.error || 'Cannot check PDF')
                const entry = metadata.entries?.[0]
                if (!entry || entry.size === undefined || entry.modified === undefined) {
                    throw new Error('PDF not found. Enter a path relative to the session folder.')
                }
                if (entry.size > MAX_PDF_BYTES) throw new Error('PDF is larger than the 20 MB preview limit.')
                if (entry.modified === lastModified && entry.size === lastSize) return
                if (!cancelled) setLoading(true)
                const file = await api.readSessionFile(sessionId, path)
                if (!file.success || !file.content) throw new Error(file.error || 'Cannot read PDF')
                const binary = atob(file.content)
                if (!binary.startsWith('%PDF-')) throw new Error('The selected file is not a PDF.')
                const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
                const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
                if (cancelled) {
                    URL.revokeObjectURL(url)
                    return
                }
                const previousUrl = pdfUrlRef.current
                pdfUrlRef.current = url
                setPdfUrl(url)
                setError(null)
                lastModified = entry.modified
                lastSize = entry.size
                if (previousUrl) URL.revokeObjectURL(previousUrl)
            } catch (cause) {
                if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
            } finally {
                checking = false
                if (!cancelled) setLoading(false)
            }
        }

        void check()
        const timer = window.setInterval(() => { void check() }, 5000)
        document.addEventListener('visibilitychange', check)
        return () => {
            cancelled = true
            window.clearInterval(timer)
            document.removeEventListener('visibilitychange', check)
        }
    }, [api, sessionId, path, refresh])

    useEffect(() => () => {
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current)
    }, [])

    return (
        <section className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--app-bg)]" aria-label="Paper PDF preview">
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--app-border)] p-2">
                <strong className="text-sm">PDF</strong>
                <form className="flex min-w-0 flex-1 gap-1" onSubmit={event => { event.preventDefault(); openPath() }}>
                    <input
                        aria-label="PDF path relative to session folder"
                        className="min-w-0 flex-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs"
                        value={draftPath}
                        onChange={event => setDraftPath(event.target.value)}
                        placeholder="main.pdf"
                    />
                    <button className="rounded border border-[var(--app-border)] px-2 py-1 text-xs" type="submit">打开</button>
                </form>
                <button className="rounded border border-[var(--app-border)] px-2 py-1 text-xs" type="button" onClick={() => setRefresh(value => value + 1)}>刷新</button>
            </div>
            {error ? <div role="status" className="px-3 py-2 text-xs text-red-600">{error}</div> : null}
            {loading && !pdfUrl ? <div className="p-3 text-xs text-[var(--app-hint)]">正在加载 PDF…</div> : null}
            {pdfUrl ? <iframe className="min-h-0 w-full flex-1" src={pdfUrl} title="Paper PDF" /> : null}
        </section>
    )
}
