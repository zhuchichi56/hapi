import { useEffect, useState } from 'react'

export type FileChangeItem = { key: string; files?: { path: string; additions?: number; deletions?: number }[] }
type Detail = { output?: string; outputMore?: boolean }
type Command = <T,>(command: Record<string, unknown>) => Promise<T>
type FileCount = { path: string; additions?: number; deletions?: number }

const FILE_PAGE = 8
const FILE_INITIAL = 3

function FileDiff({ item, call, id }: { item: FileChangeItem; call: Command; id: string }) {
    const [detail, setDetail] = useState<Detail | null>(null)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)
    useEffect(() => {
        let cancelled = false
        void call<{ item: Detail }>({ op: 'read', id, itemKey: item.key }).then(result => { if (!cancelled) setDetail(result.item) }).catch(error => { if (!cancelled) setError(String(error.message ?? error)) }).finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [call, id, item.key])
    const more = async () => {
        setLoading(true); setError('')
        try {
            const result = await call<{ item: Detail }>({ op: 'read', id, itemKey: item.key, outputOffset: detail?.output?.length ?? 0 })
            setDetail(value => ({ ...result.item, output: (value?.output ?? '') + (result.item.output ?? '') }))
        } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
        finally { setLoading(false) }
    }
    let changes: { path: string; diff?: string }[] = []
    try { const parsed = JSON.parse(detail?.output ?? '[]'); if (Array.isArray(parsed)) changes = parsed } catch { /* Keep the paged original text until the complete JSON is available. */ }
    return <div className="nd-file-diff">{loading && !detail && <p className="nd-subtle">读取原始差异…</p>}{changes.length ? changes.map((change, index) => <div key={index}><strong>{change.path}</strong><pre>{(change.diff ?? '').split('\n').map((line, i) => <span key={i} data-diff={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'delete' : undefined}>{line}{'\n'}</span>)}</pre></div>) : detail && <pre>{detail.output || '原记录未提供文本差异'}</pre>}{detail?.outputMore && <button type="button" className="nd-text-btn" disabled={loading} onClick={() => void more()}>继续读取差异</button>}{error && <p role="alert">{error} <button type="button" className="nd-text-btn" disabled={loading} onClick={() => void more()}>重试</button></p>}</div>
}

function aggregateFiles(items: FileChangeItem[]): FileCount[] {
    const files = new Map<string, FileCount>()
    const seen = new Set<string>()
    for (const item of items) {
        // Paging can repeat the exact original item; count it only once.
        if (seen.has(item.key)) continue
        seen.add(item.key)
        for (const file of item.files ?? []) {
            if (typeof file.path !== 'string' || !file.path) continue
            const previous = files.get(file.path)
            if (!previous) {
                files.set(file.path, {
                    path: file.path,
                    ...(typeof file.additions === 'number' ? { additions: file.additions } : {}),
                    ...(typeof file.deletions === 'number' ? { deletions: file.deletions } : {}),
                })
                continue
            }
            // An unknown count on any original record stays unknown; never turn it into zero.
            const additions = typeof file.additions === 'number' && typeof previous.additions === 'number' ? previous.additions + file.additions : undefined
            const deletions = typeof file.deletions === 'number' && typeof previous.deletions === 'number' ? previous.deletions + file.deletions : undefined
            files.set(file.path, { path: file.path, ...(additions === undefined ? {} : { additions }), ...(deletions === undefined ? {} : { deletions }) })
        }
    }
    return [...files.values()]
}

function splitPath(path: string): { parent: string; name: string } {
    const slash = path.lastIndexOf('/')
    return slash < 0 ? { parent: '', name: path } : { parent: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

export function FileChanges({ items, call, id }: { items: FileChangeItem[]; call: Command; id: string }) {
    const [opened, setOpened] = useState(false)
    const [visible, setVisible] = useState(FILE_INITIAL)
    const [diffLimit, setDiffLimit] = useState(8)
    const files = aggregateFiles(items)
    const uniqueItems = [...new Map(items.map(item => [item.key, item] as const)).values()]
    if (!files.length) return null
    const knownAdditions = files.filter(file => typeof file.additions === 'number')
    const knownDeletions = files.filter(file => typeof file.deletions === 'number')
    const additions = knownAdditions.reduce((total, file) => total + (file.additions ?? 0), 0)
    const deletions = knownDeletions.reduce((total, file) => total + (file.deletions ?? 0), 0)
    const remaining = Math.max(0, files.length - visible)
    return <section className="nd-file-changes" role="region" aria-label="文件变更">
        <div className="nd-file-head">
            <span className="nd-file-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M4 1.8h5l3 3v9.4H4z" /><path d="M9 1.8v3h3" /></svg>
            </span>
            <div className="nd-file-meta">
                <span className="nd-file-title" title="本轮原生修改记录；行数按各次修改累计">已编辑 {files.length} 个文件</span>
                {(knownAdditions.length === files.length || knownDeletions.length === files.length) && <span className="nd-file-totals" role="group" aria-label={[knownAdditions.length === files.length ? `新增 ${additions} 行` : '', knownDeletions.length === files.length ? `删除 ${deletions} 行` : ''].filter(Boolean).join('，')}>{knownAdditions.length === files.length && <span className="nd-added">+{additions}</span>}{knownDeletions.length === files.length && <span className="nd-deleted">−{deletions}</span>}</span>}
            </div>
            <details className="nd-file-diff-details" onToggle={event => setOpened(event.currentTarget.open)}>
                <summary className="nd-file-view">查看更改<span className="nd-file-chevron" aria-hidden="true">›</span></summary>
            </details>
        </div>
        <div className="nd-file-list">
            {files.slice(0, visible).map(file => {
                const { parent, name } = splitPath(file.path)
                return <div className="nd-file-row" key={file.path} title={file.path}>
                    <span className="nd-file-path">
                        {parent && <span className="nd-file-parent">{parent}</span>}
                        <span className="nd-file-name">{name}</span>
                    </span>
                    <span className="nd-file-counts">{typeof file.additions === 'number' && <small className="nd-added">+{file.additions}</small>}{typeof file.deletions === 'number' && <small className="nd-deleted">−{file.deletions}</small>}</span>
                </div>
            })}
        </div>
        {remaining > 0 && <button type="button" className="nd-file-more" onClick={() => setVisible(value => value + FILE_PAGE)}>再显示 {Math.min(FILE_PAGE, remaining)} 个文件<span aria-hidden="true">⌄</span></button>}
        {opened && <div className="nd-file-diffs">{uniqueItems.slice(0, diffLimit).map(item => <FileDiff key={item.key} item={item} call={call} id={id} />)}{uniqueItems.length > diffLimit && <button type="button" className="nd-text-btn" onClick={() => setDiffLimit(value => value + 8)}>更多修改记录</button>}</div>}
    </section>
}
