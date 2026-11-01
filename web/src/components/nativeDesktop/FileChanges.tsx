import { useEffect, useState } from 'react'
export type FileChangeItem = { key: string; files?: {path: string; additions?: number; deletions?: number}[] }
type Detail = { output?: string; outputMore?: boolean }
type Command = <T,>(command: Record<string, unknown>) => Promise<T>
function FileDiff({ item, call, id }: {item: FileChangeItem; call: Command; id: string}) {
    const [detail, setDetail] = useState<Detail | null>(null)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)
    useEffect(() => {
        let cancelled = false
        void call<{item: Detail}>({op: 'read', id, itemKey: item.key}).then(result => { if (!cancelled) setDetail(result.item) }).catch(error => { if (!cancelled) setError(String(error.message ?? error)) }).finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [call, id, item.key])
    const more = async () => {
        setLoading(true); setError('')
        try {
            const result = await call<{item: Detail}>({op: 'read', id, itemKey: item.key, outputOffset: detail?.output?.length ?? 0})
            setDetail(value => ({...result.item, output: (value?.output ?? '') + (result.item.output ?? '')}))
        } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
        finally { setLoading(false) }
    }
    let changes: {path: string; diff?: string}[] = []
    try { const parsed = JSON.parse(detail?.output ?? '[]'); if (Array.isArray(parsed)) changes = parsed } catch { /* Retain paged original text until the complete JSON arrives. */ }
    return <div>{loading && !detail && <p className="nd-subtle">读取原始差异…</p>}{changes.length ? changes.map((change, index) => <div key={index}><strong>{change.path}</strong><pre>{(change.diff ?? '').split('\n').map((line, i) => <span key={i} data-diff={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'delete' : undefined}>{line}{'\n'}</span>)}</pre></div>) : detail && <pre>{detail.output || '原记录未提供文本差异'}</pre>}{detail?.outputMore && <button className="nd-text-btn" disabled={loading} onClick={() => void more()}>继续读取差异</button>}{error && <p role="alert">{error} <button className="nd-text-btn" disabled={loading} onClick={() => void more()}>重试</button></p>}</div>
}
export function FileChanges({items, call, id}: {items: FileChangeItem[]; call: Command; id: string}) {
    const [opened, setOpened] = useState(false)
    const [limit, setLimit] = useState(8)
    const files = new Map<string, {path: string; additions?: number; deletions?: number}>()
    for (const item of items) for (const file of item.files ?? []) {
        const previous = files.get(file.path)
        files.set(file.path, previous ? {path: file.path, additions: previous.additions === undefined || file.additions === undefined ? undefined : previous.additions + file.additions, deletions: previous.deletions === undefined || file.deletions === undefined ? undefined : previous.deletions + file.deletions} : {...file})
    }
    if (!files.size) return null
    return <div className="nd-file-changes">
        <div className="nd-file-heading" title="本轮原生修改记录；行数按各次修改累计">文件变更 <small>{files.size}</small></div>
        <div className="nd-file-list">{[...files.values()].map(file => <div key={file.path} title={file.path}><span>{file.path.split('/').at(-1)}</span>{file.additions !== undefined && <small className="nd-added">+{file.additions}</small>}{file.deletions !== undefined && <small className="nd-deleted">−{file.deletions}</small>}</div>)}</div>
        <details onToggle={event => setOpened(event.currentTarget.open)}><summary>查看更改 <i>›</i></summary>{opened && <div className="nd-file-diffs">{items.slice(0, limit).map(item => <FileDiff key={item.key} item={item} call={call} id={id} />)}{items.length > limit && <button className="nd-text-btn" onClick={() => setLimit(value => value + 8)}>更多修改记录</button>}</div>}</details>
    </div>
}
