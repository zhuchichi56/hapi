import { useEffect, useRef, useState } from 'react'
export type ImageLoader = (source: string) => Promise<string>
export function InlineImage({ src, alt, load }: { src?: string; alt?: string; load?: ImageLoader }) {
    const [expanded, setExpanded] = useState(false)
    const [preview, setPreview] = useState('')
    const [failed, setFailed] = useState(false)
    const button = useRef<HTMLButtonElement>(null)
    const local = !!src && /^\/(?:Users|var|private|tmp|Volumes)\//.test(src)
    useEffect(() => {
        setFailed(false); setPreview('')
        if (!local || !src || !load) return
        let cancelled = false, started = false
        const fetch = () => {
            if (started) return
            started = true
            void load(src).then(value => {
                if (!cancelled) setPreview(value)
            }).catch(() => { if (!cancelled) setFailed(true) })
        }
        if (typeof IntersectionObserver === 'undefined') fetch()
        else {
            const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); fetch() } }, { rootMargin: '160px' })
            if (button.current) observer.observe(button.current)
            return () => { cancelled = true; observer.disconnect() }
        }
        return () => { cancelled = true }
    }, [src, local, load])
    const source = local ? preview : src
    return <button type="button" ref={button} className="nd-image" data-expanded={expanded} aria-expanded={expanded} aria-label={`${expanded ? '缩小' : '放大预览'}：${alt || '图片'}`} onClick={() => setExpanded(value => !value)}>
        {failed || !src ? <span className="nd-image-fallback">▧ {alt || '图片'} · 预览不可用</span> : source ? <img src={source} alt={alt || '图片'} loading="lazy" onError={() => setFailed(true)} /> : <span className="nd-image-fallback">▧ {alt || '图片'} · 读取缩略图…</span>}
    </button>
}
