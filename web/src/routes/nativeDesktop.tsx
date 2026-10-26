import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

type Thread = { id: string; title: string; status: string; cwd?: string }
type Item = { id: string; role: string; text: string; output?: string; status?: string }
type View = { id: string; title: string; status: string; live: boolean; historyComplete: boolean; turns: { id: string; status: string; items: Item[] }[]; requests: Record<string, unknown>[] }
const isActive = (status?: string) => ['active', 'running', 'inProgress', 'busy'].includes(status ?? '')
const statusText = (status?: string) => isActive(status) ? '运行中' : status === 'idle' ? '空闲' : status === 'locked' ? 'Mac 已锁屏' : status === 'notLoaded' ? '未打开' : status === 'unknown' ? '状态待同步' : status ?? ''

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
    const [complete, setComplete] = useState(false)
    const [connected, setConnected] = useState(false)
    const scroll = useRef<HTMLDivElement>(null)
    const nearBottom = useRef(true)
    const epoch = useRef(0)
    const mutation = useRef(false)
    const call = useCallback(async <T,>(command: Record<string, unknown>) => {
        const response = await api.nativeDesktopCommand<T>({ app, ...command })
        if (!response.ok) throw Error(response.error || '桌面请求失败')
        return response.result as T
    }, [api, app])
    useEffect(() => {
        const generation = ++epoch.current
        let cancelled = false, pending = false
        setThreads([]); setView(null); setConnected(false); setError('')
        const refresh = async () => {
            if (pending) return
            pending = true
            try {
                const result = await call<{ threads: Thread[] }>({ op: 'list' })
                if (cancelled || epoch.current !== generation) return
                setThreads(result.threads); setConnected(true)
            } catch (e) { if (!cancelled) { setConnected(false); setError(String(e instanceof Error ? e.message : e)) } }
            finally { pending = false }
        }
        void refresh()
        const timer = setInterval(() => { if (!document.hidden) void refresh() }, 8000)
        return () => { cancelled = true; clearInterval(timer) }
    }, [call])
    useEffect(() => {
        if (!selected) return
        let cancelled = false, pending = false
        setView(null); nearBottom.current = true
        const refresh = async () => {
            if (pending) return
            pending = true
            try {
                const result = await call<View>({ op: 'read', id: selected, complete })
                if (!cancelled) { setView(result); setConnected(true) }
            } catch (e) { if (!cancelled) { setConnected(false); setError(e instanceof Error ? e.message : String(e)) } }
            finally { pending = false }
        }
        void refresh()
        const timer = setInterval(() => { if (!document.hidden) void refresh() }, 1800)
        return () => { cancelled = true; clearInterval(timer) }
    }, [call, selected, complete])
    useEffect(() => { if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [view])
    const act = async (op: string, extra: Record<string, unknown> = {}) => {
        if (mutation.current) return
        mutation.current = true; setBusy(true); setError('')
        try {
            const result = await call<{ threadId?: string; clientThreadId?: string; sessionId?: string }>({ op, id: selected, actionId: crypto.randomUUID(), ...extra })
            if (op === 'send' || op === 'create') setDraft('')
            if (op === 'create') {
                setCreating(false)
                const id = result.threadId ?? result.sessionId
                if (id) setSelected(id)
                else setError('桌面正在准备新会话，请稍后从列表打开。')
            }
            const list = await call<{ threads: Thread[] }>({ op: 'list' })
            setThreads(list.threads)
        } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { mutation.current = false; setBusy(false) }
    }
    const open = (id: string) => { setSelected(id); setCreating(false); setComplete(false); setError(''); setDraft('') }
    const newChat = () => { setSelected(null); setView(null); setCreating(true); setDraft(''); setError('') }
    const title = view?.title || threads.find(t => t.id === selected)?.title || '桌面原会话'
    return <div className="nd-root" data-open={selected || creating ? "true" : "false"}>
        <style>{`
.nd-root{height:100%;min-height:0;display:flex;background:var(--app-bg);color:var(--app-fg);font-size:15px}.nd-side{width:300px;min-width:0;border-right:1px solid var(--app-border);display:flex;flex-direction:column}.nd-head{padding:16px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--app-border)}.nd-side input{margin:10px 12px;padding:10px;background:var(--app-subtle-bg);border-radius:10px}.nd-tabs{display:flex;padding:8px 12px;gap:8px}.nd-tabs button{flex:1;padding:9px;border-radius:9px}.nd-chosen{background:var(--app-subtle-bg);font-weight:600}.nd-list{overflow:auto;flex:1}.nd-thread{display:block;text-align:left;width:100%;padding:14px 16px;border-bottom:1px solid var(--app-border)}.nd-thread small{display:block;color:var(--app-hint);font-size:12px;margin-top:5px}.nd-main{flex:1;min-width:0;display:flex;flex-direction:column}.nd-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nd-status{font-size:12px;color:var(--app-hint)}.nd-scroll{overflow:auto;flex:1;padding:20px 16px;overscroll-behavior:contain}.nd-content{max-width:820px;margin:auto}.nd-message{margin-bottom:22px;overflow-wrap:anywhere}.nd-user{background:var(--app-subtle-bg);padding:12px 16px;border-radius:14px;white-space:pre-wrap}.nd-label{font-size:11px;color:var(--app-hint);margin-bottom:6px}.nd-tool{font-size:12px;padding:10px;background:var(--app-subtle-bg);border-radius:9px}.nd-tool pre{white-space:pre-wrap;max-height:360px;overflow:auto}.nd-compose{border-top:1px solid var(--app-border);padding:12px max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom));display:flex;gap:10px;align-items:flex-end}.nd-compose textarea{resize:none;flex:1;min-width:0;max-height:180px;padding:12px;background:var(--app-subtle-bg);border-radius:12px;outline:none}.nd-btn{padding:9px 12px;border:1px solid var(--app-border);border-radius:9px;white-space:nowrap}.nd-primary{background:var(--app-fg);color:var(--app-bg)}.nd-btn:disabled{opacity:.4}.nd-error{font-size:13px;padding:10px 16px;color:#c45d3c;overflow-wrap:anywhere}.nd-empty{padding:60px 24px;color:var(--app-hint);text-align:center}.nd-mobile-back{display:none}.nd-request{padding:16px;border:1px solid var(--app-border);border-radius:12px;margin:12px 0}.nd-request pre{white-space:pre-wrap;font-size:12px;max-height:260px;overflow:auto}@media(max-width:700px){.nd-side{width:100%;border:0}.nd-root[data-open=true] .nd-side{display:none}.nd-root[data-open=false] .nd-main{display:none}.nd-mobile-back{display:block}.nd-scroll{padding:18px 14px}.nd-head{padding:12px}.nd-root{padding-top:env(safe-area-inset-top)}}`}</style>
        <aside className="nd-side" hidden={false}>
            <header className="nd-head"><Link to="/sessions">‹ HAPI</Link><strong style={{ flex: 1 }}>桌面会话</strong><button className="nd-btn" onClick={newChat}>＋ 新建</button></header>
            <div className="nd-tabs">{(['codex', 'claude'] as const).map(name => <button key={name} className={name === app ? 'nd-chosen' : ''} onClick={() => { setApp(name); setSelected(null); setCreating(false); setDraft('') }}>{name === 'codex' ? 'Codex' : 'Claude Code'}</button>)}</div>
            <input aria-label="搜索桌面会话" placeholder="搜索会话" value={filter} onChange={e => setFilter(e.target.value)} />
            <div className="nd-list">{threads.filter(t => t.title?.toLowerCase().includes(filter.toLowerCase())).map(t => <button className={`nd-thread ${t.id === selected ? 'nd-chosen' : ''}`} key={t.id} onClick={() => open(t.id)}><span>{t.title || '未命名会话'}</span><small>{statusText(t.status)}</small></button>)}{!threads.length && <div className="nd-empty">{connected ? '还没有桌面会话' : '正在连接桌面…'}</div>}</div>
            {!selected && !creating && error && <div className="nd-error" role="alert">{error}</div>}
        </aside>
        <main className="nd-main">
            <header className="nd-head"><button className="nd-mobile-back nd-btn" onClick={() => { setSelected(null); setCreating(false) }}>‹ 列表</button><div className="nd-title"><strong>{creating ? `新建 ${app === 'codex' ? 'Codex' : 'Claude Code'} 桌面会话` : title}</strong><div className="nd-status">{selected ? `${statusText(view?.status)} · ${connected ? '已连接桌面' : '连接中断'}` : '与桌面 App 使用同一个会话'}</div></div>{selected && isActive(view?.status) && <button className="nd-btn" disabled={busy} onClick={() => void act('stop')}>停止</button>}</header>
            <div className="nd-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}><div className="nd-content">
                {selected && !view && <div className="nd-empty">读取原会话…</div>}
                {!selected && <div className="nd-empty">{creating ? '发送第一条消息，会话会出现在桌面 App 中。' : '选择一个桌面会话，或新建会话。'}</div>}
                {view && !view.historyComplete && <button className="nd-btn" onClick={() => setComplete(true)}>加载更早记录</button>}
                {view?.turns.map(turn => <section key={turn.id}>{turn.items.map((item, i) => <div className="nd-message" key={`${item.id}:${i}`}>{item.role === 'tool' ? <details className="nd-tool"><summary>{item.text.slice(0, 140)} {item.status === 'inProgress' ? ' · 执行中' : ''}</summary>{item.output && <pre>{item.output}</pre>}</details> : <><div className="nd-label">{item.role === 'user' ? '你' : app === 'codex' ? 'Codex' : 'Claude'}</div>{item.role === 'user' ? <div className="nd-user">{item.text}</div> : <MarkdownRenderer content={item.text} standalone />}</>}</div>)}</section>)}
                {view?.requests.map((request, i) => <div className="nd-request" key={i}><strong>桌面需要处理请求</strong><pre>{JSON.stringify(request, null, 2)}</pre>{Array.isArray(request.buttons) ? <div style={{ display: 'flex', gap: 8 }}>{(request.buttons as string[]).map(button => <button className="nd-btn" disabled={busy} key={button} onClick={() => void act('respond', { requestId: request.id, button })}>{button}</button>)}</div> : String(request.method ?? '').includes('requestApproval') ? <div style={{ display: 'flex', gap: 8 }}>{['accept', 'decline'].map(decision => <button className="nd-btn" disabled={busy} key={decision} onClick={() => void act('respond', { requestId: request.id ?? request.requestId, decision })}>{decision === 'accept' ? '允许本次' : '拒绝'}</button>)}</div> : <p>请在桌面处理此类请求。</p>}</div>)}
            </div></div>
            {error && (selected || creating) && <div className="nd-error" role="alert">{error}</div>}
            {(selected || creating) && <form className="nd-compose" onSubmit={e => { e.preventDefault(); if (draft.trim()) void act(creating ? 'create' : 'send', { text: draft }) }}><textarea aria-label="消息" rows={3} placeholder="发送到桌面原会话…" value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} /><button type="submit" className="nd-btn nd-primary" disabled={busy || !connected || !draft.trim()}>{busy ? '发送中…' : '发送'}</button></form>}
        </main>
    </div>
}
