import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
export type ImageLoader = (source: string, size?: 'large') => Promise<string>
const localImagePath = /^\/(?:Users|var|private|tmp|Volumes)\//

// Native transcripts can carry the CommonMark angle wrapper (and sometimes its
// HTML-escaped form) into the image src. Only unwrap local absolute paths so a
// remote URL that happens to contain angle brackets is left untouched.
export function normalizeLocalImageSource(source?: string): string | undefined {
    if (!source) return source
    let value = source.trim()
    // ReactMarkdown percent-encodes a CommonMark <...> destination before it
    // reaches the img component; decode only enough to reveal the wrapper.
    for (let i = 0; i < 2 && /^%3c[\s\S]*%3e$/i.test(value); i++) {
        try { value = decodeURIComponent(value) } catch { break }
    }
    value = value.replace(/^&amp;lt;([\s\S]+)&amp;gt;$/, '<$1>')
    value = value.replace(/^&lt;([\s\S]+)&gt;$/, '<$1>')
    value = value.replace(/^\\<([\s\S]+)\\>$/, '<$1>')
    value = value.replace(/^<([\s\S]+)>$/, '$1')
    value = value.replace(/\\([<>])/g, '$1')
    return localImagePath.test(value) ? value : source
}

export function InlineImage({ src, alt, load }: { src?: string; alt?: string; load?: ImageLoader }) {
    const image = normalizeLocalImageSource(src)
    const [expanded, setExpanded] = useState(false)
    const [zoomed, setZoomed] = useState(false)
    const [preview, setPreview] = useState('')
    const [large, setLarge] = useState('')
    const [failed, setFailed] = useState(false)
    const [largeFailed, setLargeFailed] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const [largeAttempt, setLargeAttempt] = useState(0)
    const button = useRef<HTMLButtonElement>(null)
    const local = !!image && localImagePath.test(image)
    useEffect(() => {
        setExpanded(false); setLarge(''); setLargeFailed(false)
    }, [image])
    useEffect(() => { if (!expanded) setZoomed(false) }, [expanded])
    useEffect(() => {
        setFailed(false); setPreview('')
        if (!local || !image || !load) return
        let cancelled = false, started = false
        const fetch = () => {
            if (started) return
            started = true
            void load(image).then(value => {
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
    }, [image, local, load, attempt])
    useEffect(() => {
        if (!expanded || !local || !image || !load || large) return
        let cancelled = false
        setLargeFailed(false)
        void load(image, 'large').then(value => { if (!cancelled) setLarge(value) }).catch(() => { if (!cancelled) setLargeFailed(true) })
        return () => { cancelled = true }
    }, [expanded, local, image, load, large, largeAttempt])
    const source = local ? preview : image
    return <Dialog.Root open={expanded} onOpenChange={setExpanded}>
        <Dialog.Trigger asChild><button type="button" ref={button} className="nd-image" aria-expanded={expanded} disabled={!image || !source && !failed} aria-label={`${failed ? '重试图片' : '放大预览'}：${alt || '图片'}`} onClick={event => { if (failed) { event.preventDefault(); setAttempt(value => value + 1) } }}>
            {failed || !image ? <span className="nd-image-fallback">▧ {alt || '图片'} · 预览不可用{image && <small>点按重试</small>}</span> : source ? <img key={attempt} src={source} alt={alt || '图片'} loading="lazy" onLoad={() => button.current?.dispatchEvent(new Event('native-image-loaded', { bubbles: true }))} onError={() => setFailed(true)} /> : <span className="nd-image-fallback">▧ {alt || '图片'} · 读取缩略图…</span>}
        </button></Dialog.Trigger>
        <Dialog.Portal>
            <Dialog.Overlay className="nd-image-overlay" />
            <Dialog.Content className="nd-image-viewer" aria-describedby={undefined}>
                <Dialog.Title className="nd-sr-only">{alt || '图片预览'}</Dialog.Title>
                <Dialog.Close className="nd-image-close" aria-label="关闭图片预览">×</Dialog.Close>
                <button className="nd-image-zoom" aria-label={zoomed ? '适应屏幕' : '查看原尺寸'} title={zoomed ? '适应屏幕' : '查看原尺寸'} aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>{zoomed ? '↙' : '1:1'}</button>
                {source && <div className="nd-image-canvas" data-zoomed={zoomed}><img src={large || source} alt={alt || '图片预览'} /></div>}
                {local && !large && <div className="nd-image-quality" role="status">{largeFailed ? <button onClick={() => setLargeAttempt(value => value + 1)}>高清预览暂不可用 · 重试</button> : '正在读取清晰图片…'}</div>}
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>
}
