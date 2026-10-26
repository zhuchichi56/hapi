import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import './nativeDesktop.css'

type Thread = { id: string; title: string; status: string; cwd?: string }
type Item = { id: string; key: string; role: string; text: string; phase?: string; hasDetail?: boolean; textTruncated?: boolean; output?: string; outputLength?: number; outputMore?: boolean; status?: string }
type Turn = { id: string; status: string; items: Item[] }
type View = { id: string; title: string; status: string; live: boolean; historyComplete: boolean; hasEarlier: boolean; before: string | null; revision: string; windowStart: number; turns: Turn[]; requests: Record<string, unknown>[] }
type ReadResult = View | { id: string; revision: string; unchanged: true }
type Command = <T,>(command: Record<string, unknown>) => Promise<T>
const active = (status?: string) => ['active', 'running', 'inProgress', 'busy'].includes(status ?? '')
const statusText = (status?: string) => active(status) ? '正在回复' : status === 'idle' ? '已就绪' : status === 'locked' ? 'Mac 已锁屏' : status === 'notLoaded' ? '未打开' : '同步状态中'
const cachedViews = new Map<string, View>()

const Message = memo(function Message({ item, call, id, app }: { item: Item; call: Command; id: string; app: string }) {
    const [detail, setDetail] = useState<Item | null>(null)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const load = async (more = false) => {
        if (loading) return
        setLoading(true); setError('')
        try {
            const result = await call<{ item: Item }>({ op: 'read', id, itemKey: item.key, outputOffset: more ? (detail?.output?.length ?? 0) : 0 })
            setDetail(previous => more && previous ? { ...result.item, output: (previous.output ?? '') + (result.item.output ?? '') } : result.item)
        } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { setLoading(false) }
    }
    const value = detail ?? item
    if (item.role === 'tool') return <div className="nd-tool-row">
        <details onToggle={event => { if (event.currentTarget.open && !detail && !loading) void load() }}>
            <summary><span className="nd-tool-dot" data-active={active(item.status)} /><span>{item.text || '工具调用'}</span><span className="nd-tool-chevron">›</span></summary>
            {loading && !detail && <p className="nd-subtle">读取工具结果…</p>}
            {detail && <pre>{detail.output || detail.text || '没有文本输出'}</pre>}
            {detail?.outputMore && <button className="nd-text-btn" onClick={() => void load(true)} disabled={loading}>{loading ? '读取中…' : '继续读取输出'}</button>}
            {error && <p role="alert" className="nd-inline-error">{error}</p>}
        </details>
    </div>
    return <article className={`nd-message nd-${item.role}`}>
        {item.role !== 'user' && <div className="nd-author"><span className={`nd-avatar nd-avatar-${app}`}>{app === 'codex' ? 'C' : '✳'}</span><span>{app === 'codex' ? 'Codex' : 'Claude'}</span>{item.phase === 'commentary' && <span className="nd-phase">进展</span>}</div>}
        <div className="nd-message-body">{item.role === 'user' ? <div className="nd-user-text">{value.text}</div> : <MarkdownRenderer content={value.text} standalone className="nd-render" />}</div>
        {item.textTruncated && !detail && <button className="nd-text-btn" onClick={() => void load()} disabled={loading}>{loading ? '读取全文…' : '展开全文'}</button>}
        {error && <p role="alert" className="nd-inline-error">{error}</p>}
    </article>
}, (before, after) => before.id === after.id && before.app === after.app && before.call === after.call && JSON.stringify(before.item) === JSON.stringify(after.item))

function HistoryTurn({ turn, call, id, app }: { turn: Turn; call: Command; id: string; app: string }) {
    const groups: { key: string; tools?: Item[]; item?: Item }[] = []
    for (const item of turn.items) {
        if (item.role === 'tool') {
            const previous = groups.at(-1)
            if (previous?.tools) previous.tools.push(item)
            else groups.push({ key: item.key, tools: [item] })
        } else groups.push({ key: item.key, item })
    }
    return <section className="nd-turn">{groups.map(group => group.item
        ? <Message key={group.key} item={group.item} call={call} id={id} app={app} />
        : <details className="nd-activity" key={group.key}>
            <summary><span className="nd-activity-icon">⌘</span><span>{group.tools!.some(item => active(item.status)) ? '正在使用工具' : '工具记录'}<span className="nd-count">{group.tools!.length}</span></span><span className="nd-tool-chevron">›</span></summary>
            <div>{group.tools!.map(item => <Message key={item.key} item={item} call={call} id={id} app={app} />)}</div>
        </details>)}</section>
}

export default function NativeDesktopPage() {
    const { api } = useAppContext()
    const [app, setApp] = useState<'codex' | 'claude'>('codex')
    const [threads, setThreads] = useState<Thread[]>([])
    const [selected, setSelected] = useState<string | null>(null)
    const [view, setView] = useState<View | null>(null)
    const [draft, setDraft] = useState('')
    const [filter, setFilter] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [creating, setCreating] = useState(false)
    const [connected, setConnected] = useState(false)
    const [older, setOlder] = useState<Turn[]>([])
    const [olderCursor, setOlderCursor] = useState<string | null>(null)
    const [loadingOlder, setLoadingOlder] = useState(false)
    const [hasOlder, setHasOlder] = useState(false)
    const [atBottom, setAtBottom] = useState(true)
    const [pendingText, setPendingText] = useState('')
    const scroll = useRef<HTMLDivElement>(null)
    const input = useRef<HTMLTextAreaElement>(null)
    const nearBottom = useRef(true)
    const preserveScroll = useRef<{ height: number; top: number } | null>(null)
    const current = useRef<View | null>(null)
    const refreshRef = useRef<(() => Promise<void>) | null>(null)
    const mutation = useRef(false)
    const epoch = useRef(0)
    const call = useCallback(async <T,>(command: Record<string, unknown>) => {
        const response = await api.nativeDesktopCommand<T>({ app, ...command })
        if (!response.ok) throw Error(response.error || '桌面请求失败')
        return response.result as T
    }, [api, app])
    useEffect(() => {
        let cancelled = false, pending = false
        setThreads([]); setError('')
        const refresh = async () => {
            if (pending) return
            pending = true
            try {
                const result = await call<{ threads: Thread[] }>({ op: 'list' })
                if (!cancelled) { setThreads(result.threads); setConnected(true) }
            } catch (e) { if (!cancelled && !current.current) { setConnected(false); setError(e instanceof Error ? e.message : String(e)) } }
            finally { pending = false }
        }
        void refresh()
        const timer = setInterval(() => { if (!document.hidden) void refresh() }, 15000)
        return () => { cancelled = true; clearInterval(timer) }
    }, [call])
    useEffect(() => {
        if (!selected) { current.current = null; setView(null); return }
        let cancelled = false, pending = false
        const generation = ++epoch.current
        const cached = cachedViews.get(`${app}:${selected}`) ?? null
        current.current = cached; setView(cached); setOlder([]); setOlderCursor(null); setLoadingOlder(false)
        setHasOlder(cached?.hasEarlier ?? false); nearBottom.current = true; setAtBottom(true)
        let timer: ReturnType<typeof setTimeout>
        const refresh = async () => {
            if (pending || cancelled) return
            clearTimeout(timer)
            pending = true
            try {
                const result = await call<ReadResult>({ op: 'read', id: selected, since: current.current?.revision })
                if (cancelled || generation !== epoch.current) return
                setConnected(true); setError('')
                if (!('unchanged' in result)) {
                    const previous = current.current
                    if (!nearBottom.current && previous) {
                        const latestKeys = new Set(result.turns.flatMap(turn => turn.items.map(item => item.key)))
                        const displaced = previous.turns.map(turn => ({...turn,items:turn.items.filter(item => !latestKeys.has(item.key))})).filter(turn => turn.items.length)
                        if (displaced.length) setOlder(older => [...older,...displaced])
                    }
                    current.current = result
                    if (cachedViews.size > 12) cachedViews.delete(cachedViews.keys().next().value!)
                    cachedViews.set(`${app}:${selected}`, result)
                    setView(result)
                }
            } catch (e) { if (!cancelled) { setConnected(false); setError(e instanceof Error ? e.message : String(e)) } }
            finally {
                pending = false
                if (!cancelled) timer = setTimeout(() => { if (document.hidden) { timer = setTimeout(() => void refresh(), 3000); return } void refresh() }, active(current.current?.status) ? 1200 : 3000)
            }
        }
        refreshRef.current = refresh
        void refresh()
        return () => { cancelled = true; clearTimeout(timer); refreshRef.current = null }
    }, [app, call, selected])
    useEffect(() => { if (view && !older.length) setHasOlder(view.hasEarlier) }, [view, older.length])
    useEffect(() => { if (pendingText && view?.turns.some(turn => turn.items.some(item => item.role === 'user' && item.text.trim() === pendingText.trim()))) setPendingText('') }, [view, pendingText])
    useLayoutEffect(() => {
        const el = scroll.current
        if (!el) return
        if (preserveScroll.current) {
            const previous = preserveScroll.current
            el.scrollTop = previous.top + el.scrollHeight - previous.height
            preserveScroll.current = null
        } else if (nearBottom.current) el.scrollTop = el.scrollHeight
    }, [view, older, pendingText])
    useLayoutEffect(() => {
        const el = input.current
        if (!el) return
        el.style.height = 'auto'
        if (draft) el.style.height = `${Math.min(el.scrollHeight, 180)}px`
    }, [draft, selected, creating])
    const loadOlder = async () => {
        if (!view || !selected || loadingOlder) return
        const generation = epoch.current
        setLoadingOlder(true)
        try {
            const cursor = olderCursor ?? view.before
            const result = await call<View>({ op: 'read', id: selected, before: cursor, complete: !view.historyComplete && !olderCursor && view.windowStart === 0 })
            if (generation !== epoch.current) return
            if (scroll.current) preserveScroll.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop }
            setOlder(previous => [...result.turns, ...previous]); setOlderCursor(result.before); setHasOlder(result.hasEarlier)
        } catch (e) { if (generation === epoch.current) setError(e instanceof Error ? e.message : String(e)) }
        finally { if (generation === epoch.current) setLoadingOlder(false) }
    }
    const act = async (op: string, extra: Record<string, unknown> = {}) => {
        if (mutation.current) return
        const generation = epoch.current
        mutation.current = true; setBusy(true); setError('')
        if (op === 'send' || op === 'create') { setPendingText(String(extra.text)); nearBottom.current = true; setAtBottom(true) }
        try {
            const result = await call<{ threadId?: string; sessionId?: string }>({ op, id: selected, actionId: crypto.randomUUID(), ...extra })
            if (generation !== epoch.current) return
            if (op === 'send' || op === 'create') setDraft('')
            if (op === 'create') { setCreating(false); setSelected(result.threadId ?? result.sessionId ?? null); setPendingText('') }
            else void refreshRef.current?.()
        } catch (e) { if (generation === epoch.current) { setPendingText(''); setError(e instanceof Error ? e.message : String(e)) } }
        finally { mutation.current = false; setBusy(false); input.current?.focus() }
    }
    const open = (id: string) => { if (mutation.current) return; setSelected(id); setCreating(false); setError(''); setDraft(''); setPendingText('') }
    const newChat = () => { if (mutation.current) return; setSelected(null); setCreating(true); setDraft(''); setPendingText(''); setError('') }
    const title = view?.title || threads.find(t => t.id === selected)?.title || '桌面会话'
    const allTurns: Turn[] = []
    const seen = new Set<string>()
    for (const turn of [...older, ...(view?.turns ?? [])]) {
        const items = turn.items.filter(item => { if (seen.has(item.key)) return false; seen.add(item.key); return true })
        if (items.length) {
            const existing = allTurns.find(previous => previous.id === turn.id)
            if (existing) existing.items.push(...items)
            else allTurns.push({ ...turn, items })
        }
    }
    return <div className="nd-root" data-open={!!selected || creating}>
        <aside className="nd-side">
            <header className="nd-side-head"><Link to="/sessions" className="nd-home">‹ HAPI</Link><button className="nd-new" onClick={newChat} disabled={busy}>＋ 新建</button></header>
            <div className="nd-side-title">桌面会话</div>
            <div className="nd-tabs">{(['codex', 'claude'] as const).map(name => <button key={name} aria-pressed={name === app} onClick={() => { if (busy) return; setApp(name); setSelected(null); setCreating(false); setDraft(''); setPendingText('') }}>{name === 'codex' ? 'Codex' : 'Claude Code'}</button>)}</div>
            <div className="nd-search"><span>⌕</span><input aria-label="搜索桌面会话" placeholder="搜索会话" value={filter} onChange={e => setFilter(e.target.value)} /></div>
            <div className="nd-list">{threads.filter(t => t.title?.toLowerCase().includes(filter.toLowerCase())).map(t => <button className="nd-thread" aria-current={t.id === selected ? 'true' : undefined} key={t.id} onClick={() => open(t.id)}><span className="nd-thread-title">{t.title || '未命名会话'}</span><small><span className="nd-dot" data-active={active(t.status)} />{statusText(t.status)}</small></button>)}{!threads.length && <div className="nd-empty">{connected ? '还没有桌面会话' : '正在连接…'}</div>}</div>
            {!selected && !creating && error && <div className="nd-error" role="alert">{error}</div>}
        </aside>
        <main className="nd-main">
            <header className="nd-head"><button className="nd-mobile-back nd-icon-btn" onClick={() => { if (!busy) { setSelected(null); setCreating(false) } }} aria-label="返回列表">‹</button><div className="nd-title"><strong>{creating ? `新建 ${app === 'codex' ? 'Codex' : 'Claude Code'} 会话` : title}</strong><div className="nd-status"><span className="nd-dot" data-active={active(view?.status)} />{selected ? connected ? statusText(view?.status) : '连接中断，正在重连' : '与桌面 App 同步'}</div></div>{selected && active(view?.status) && <button className="nd-stop" disabled={busy} onClick={() => void act('stop')}>■ 停止</button>}</header>
            <div className="nd-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) { const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100; nearBottom.current = bottom; setAtBottom(bottom) } }}><div className="nd-content">
                {selected && !view && <div className="nd-loading"><div /><div /><div /><p>读取最近的消息…</p></div>}
                {!selected && <div className="nd-welcome"><span className={`nd-avatar nd-avatar-${app}`}>{app === 'codex' ? 'C' : '✳'}</span><h2>{creating ? '开始新的对话' : '接着聊，接着做'}</h2><p>{creating ? '发出第一条消息后，会话也会出现在桌面 App 中。' : '选择左侧会话，继续桌面上的工作。'}</p></div>}
                {view && hasOlder && <div className="nd-history-more"><button onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? '正在读取…' : '↑ 更早的消息'}</button></div>}
                {allTurns.map(turn => <HistoryTurn key={turn.id} turn={turn} call={call} id={selected!} app={app} />)}
                {pendingText && <article className="nd-message nd-user nd-pending"><div className="nd-user-text">{pendingText}</div><span className="nd-subtle">{busy ? '发送中…' : '已发送，等待同步'}</span></article>}
                {active(view?.status) && <div className="nd-thinking"><span /><span /><span /><small>正在回复</small></div>}
                {view?.requests.map((request, index) => <div className="nd-request" key={index}><strong>需要你的确认</strong>{Array.isArray(request.buttons) ? <div className="nd-request-actions">{(request.buttons as string[]).map(button => <button disabled={busy} key={button} onClick={() => void act('respond', { requestId: request.id, button })}>{button}</button>)}</div> : String(request.method ?? '').includes('requestApproval') ? <div className="nd-request-actions">{['accept', 'decline'].map(decision => <button disabled={busy} key={decision} onClick={() => void act('respond', { requestId: request.id ?? request.requestId, decision })}>{decision === 'accept' ? '允许本次' : '拒绝'}</button>)}</div> : <p>请在桌面处理此请求。</p>}<details><summary>请求详情</summary><pre>{JSON.stringify(request, null, 2)}</pre></details></div>)}
            </div></div>
            {!atBottom && selected && <button className="nd-jump" onClick={() => { nearBottom.current = true; setAtBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }) }}>↓ 最新消息</button>}
            {error && (selected || creating) && <div className="nd-error" role="alert">{error}</div>}
            {(selected || creating) && <div className="nd-compose-wrap"><form className="nd-compose" onSubmit={e => { e.preventDefault(); if (draft.trim()) void act(creating ? 'create' : 'send', { text: draft }) }}><textarea ref={input} aria-label="消息" rows={2} placeholder={`发送给 ${app === 'codex' ? 'Codex' : 'Claude'}…`} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) { e.preventDefault(); void act(creating ? 'create' : 'send', { text: draft }) } }} /><button type="submit" aria-label="发送消息" disabled={busy || !connected || !draft.trim()}>{busy ? '···' : '↑'}</button></form><div className="nd-compose-hint">消息会发送到同一个桌面会话<span>⌘ Enter 发送</span></div></div>}
        </main>
    </div>
}
