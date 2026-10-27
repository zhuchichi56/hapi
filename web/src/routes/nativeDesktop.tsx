import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { InlineImage } from '@/components/nativeDesktop/InlineImage'
import { NativeMessageContent } from '@/components/nativeDesktop/MessageContent'
import { nativeConversationLink } from '@/components/nativeDesktop/navigation'
import { CopyLinkIcon, ThreadActions } from '@/components/nativeDesktop/ThreadActions'
import { composerStorageScope, useComposerDraft } from '@/components/nativeDesktop/useComposerDraft'
import type { DraftImage } from '@/components/nativeDesktop/attachments'
import { PendingRequest } from '@/components/nativeDesktop/PendingRequest'
import './nativeDesktop.css'

type Thread = { id: string; title: string; status: string; cwd?: string; pinned?: boolean; archived?: boolean }
type Item = { images?: string[]; id: string; key: string; role: string; text: string; phase?: string; hasDetail?: boolean; textTruncated?: boolean; output?: string; outputLength?: number; outputMore?: boolean; status?: string; delegation?: { label: string; phase: string; status: string; numbers?: number[]; state?: string } }
type Turn = { id: string; status: string; items: Item[] }
type View = { id: string; title: string; status: string; live: boolean; historyComplete: boolean; hasEarlier: boolean; before: string | null; revision: string; windowStart: number; turns: Turn[]; requests: Record<string, unknown>[]; delegations?: { running: number; tasks: { id: string; number?: number; title: string; state: string }[] } }
type ReadResult = View | { id: string; revision: string; unchanged: true }
type Command = <T,>(command: Record<string, unknown>) => Promise<T>
type PendingMessage = { id: string; text: string; images: DraftImage[]; queued: boolean; sending: boolean; baseline: Set<string> }
const active = (status?: string) => ['active', 'running', 'inProgress', 'busy'].includes(status ?? '')
const attentionText = (status?: string) => status === 'locked' ? 'Mac 已锁屏' : status === 'notLoaded' ? '请先在桌面打开此会话' : ''
const settled = (status?: string) => ['idle', 'completed'].includes(status ?? '')
const dshLabel = (value?: Item['delegation']) => value?.numbers?.length ? `DSH ${value.numbers.join(' · ')}` : 'DSH'
const cachedViews = new Map<string, View>()

function desktopError(error: unknown): Error {
    if (error && typeof error === 'object' && 'body' in error && typeof error.body === 'string') {
        let detail: { error?: unknown } | null = null
        try { detail = JSON.parse(error.body) } catch { /* Gateways may return HTML. */ }
        if (typeof detail?.error === 'string') return Error(detail.error)
        const status = 'status' in error && typeof error.status === 'number' ? error.status : error instanceof Error ? error.message.match(/^HTTP (\d{3})\b/)?.[1] : undefined
        return Error(`桌面连接暂时不可用${status ? `（HTTP ${status}）` : ''}`)
    }
    return error instanceof Error ? error : Error(String(error))
}

const Message = memo(function Message({ item, call, id, app }: { item: Item; call: Command; id: string; app: string }) {
    const [detail, setDetail] = useState<Item | null>(null)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const [opened, setOpened] = useState(false)
    const [fetchedVersion, setFetchedVersion] = useState('')
    const version = JSON.stringify([item.key, item.status, item.outputLength, item.text])
    const load = useCallback(async (more = false) => {
        if (loading) return
        setLoading(true); setError('')
        try {
            const result = await call<{ item: Item }>({ op: 'read', id, itemKey: item.key, outputOffset: more ? (detail?.output?.length ?? 0) : 0 })
            setDetail(previous => more && previous ? { ...result.item, output: (previous.output ?? '') + (result.item.output ?? '') } : result.item)
        } catch (e) { if (!more) setDetail(null); setError(e instanceof Error ? e.message : String(e)) }
        finally { setFetchedVersion(version); setLoading(false) }
    }, [loading, call, id, item.key, detail?.output?.length, version])
    useEffect(() => { if (opened && !loading && fetchedVersion !== version) void load() }, [opened, loading, fetchedVersion, version, load])
    const loadImage = useCallback(async (source: string, size?: 'large') => {
        const result = await call<{ image: { src: string } }>({ op: 'read', id, itemKey: item.key, imageSrc: source, ...(size ? { imageSize: size } : {}) })
        return result.image.src
    }, [call, id, item.key])
    const shownDetail = fetchedVersion === version ? detail : null
    const value = shownDetail ?? item
    if (item.role === 'tool') return <div className="nd-tool-row">
        <details onToggle={event => setOpened(event.currentTarget.open)}>
            <summary><span className="nd-tool-dot" data-active={active(item.status)} data-completed={item.status === 'completed'} /><span>{item.text || '工具调用'}</span>{item.delegation && <span className="nd-dsh" data-state={item.delegation.state} title={`${item.delegation.phase} · ${item.delegation.state === 'completed' ? 'DSH 任务已完成' : item.delegation.status}`}>{dshLabel(item.delegation)}</span>}<span className="nd-tool-chevron">›</span></summary>
            {loading && !shownDetail && <p className="nd-subtle">读取工具结果…</p>}
            {shownDetail && <pre>{shownDetail.output || shownDetail.text || '没有文本输出'}</pre>}
            {shownDetail?.outputMore && <button className="nd-text-btn" onClick={() => void load(true)} disabled={loading}>{loading ? '读取中…' : '继续读取输出'}</button>}
            {error && <p role="alert" className="nd-inline-error">{error} <button className="nd-text-btn" disabled={loading} onClick={() => void load()}>重试</button></p>}
        </details>
    </div>
    return <article className={`nd-message nd-${item.role}`}>
        {item.role !== 'user' && <div className="nd-author"><span className={`nd-avatar nd-avatar-${app}`}>{app === 'codex' ? 'C' : '✳'}</span><span>{app === 'codex' ? 'Codex' : 'Claude'}</span>{item.phase === 'commentary' && <span className="nd-phase">进展</span>}</div>}
        <div className="nd-message-body"><NativeMessageContent text={value.text} user={item.role === 'user'} loadImage={loadImage} />{item.images?.length ? <div className="nd-message-images">{item.images.map(source => <InlineImage key={source} src={source} alt="消息图片" load={loadImage} />)}</div> : null}</div>
        {item.textTruncated && !shownDetail && <button className="nd-text-btn" onClick={() => void load()} disabled={loading}>{loading ? '读取全文…' : '展开全文'}</button>}
        {error && <p role="alert" className="nd-inline-error">{error}</p>}
    </article>
}, (before, after) => before.id === after.id && before.app === after.app && before.call === after.call && JSON.stringify(before.item) === JSON.stringify(after.item))

function ToolGroup({ tools, call, id, app }: { tools: Item[]; call: Command; id: string; app: string }) {
    const [opened, setOpened] = useState(false)
    const delegations = tools.flatMap(item => item.delegation ? [item.delegation] : [])
    const numbers = [...new Set(delegations.flatMap(item => item.numbers ?? []))].sort((a, b) => a - b)
    const state = numbers.length ? 'running' : delegations.length && delegations.every(item => item.state === 'completed') ? 'completed' : undefined
    return <details className="nd-activity" onToggle={event => { if (event.currentTarget.open) setOpened(true) }}>
        <summary><span className="nd-activity-icon">⌘</span><span>{tools.some(item => active(item.status)) ? '正在使用工具' : '工具记录'}<span className="nd-count">{tools.length}</span></span>{delegations.length > 0 && <span className="nd-dsh" data-state={state} title="编号仅表示此会话当前同时运行的 DSH，启动脚本退出不等于任务完成">{numbers.length ? `DSH ${numbers.join(' · ')}` : 'DSH 委托'}</span>}<span className="nd-tool-chevron">›</span></summary>
        {opened && <div>{tools.map(item => <Message key={item.key} item={item} call={call} id={id} app={app} />)}</div>}
    </details>
}

function ConversationHistory({ turns, call, id, app }: { turns: Turn[]; call: Command; id: string; app: string }) {
    const groups: { key: string; tools?: Item[]; item?: Item }[] = []
    for (const item of turns.flatMap(turn => turn.items)) {
        if (item.role === 'tool') {
            const previous = groups.at(-1)
            if (previous?.tools) previous.tools.push(item)
            else groups.push({ key: item.key, tools: [item] })
        } else groups.push({ key: item.key, item })
    }
    return <section className="nd-turn">{groups.map(group => group.item
        ? <Message key={group.key} item={group.item} call={call} id={id} app={app} />
        : <ToolGroup key={group.key} tools={group.tools!} call={call} id={id} app={app} />)}</section>
}

export default function NativeDesktopPage() {
    const { api, token, baseUrl } = useAppContext()
    const { app, thread } = useSearch({ from: '/desktop' })
    const navigate = useNavigate()
    const selected = thread ?? null
    const select = (nextApp: 'codex' | 'claude', id?: string) => { void navigate({ to: '/desktop', search: { app: nextApp, thread: id } }) }
    const [threads, setThreads] = useState<Thread[]>([])
    const [view, setView] = useState<View | null>(null)
    const draftScope = composerStorageScope(token, baseUrl)
    const listKey = `${draftScope.key}:${app}`
    const threadLists = useRef(new Map<string, Thread[]>())
    const conversationKey = `${app}:${selected ?? 'new'}`
    const [draft, setDraft, images, setImages] = useComposerDraft(`${draftScope.key}:${conversationKey}`, draftScope.owner ? conversationKey : undefined)
    const [preparingImages, setPreparingImages] = useState(false)
    const imageInput = useRef<HTMLInputElement>(null)
    const [completion, setCompletion] = useState<Record<string, number>>({})
    const previousStatuses = useRef(new Map<string, string>())
    const [filter, setFilter] = useState('')
    const [showArchived, setShowArchived] = useState(false)
    const [desktopArchives, setDesktopArchives] = useState<Thread[]>([])
    const [archiveCursor, setArchiveCursor] = useState<string | null>(null)
    const [loadingArchives, setLoadingArchives] = useState(false)
    const archiveApp = useRef(app)
    archiveApp.current = app
    const [notice, setNotice] = useState('')
    const [manualLink, setManualLink] = useState('')
    const [newModel, setNewModel] = useState('')
    const [models, setModels] = useState<{ id: string }[]>([])
    const [error, setError] = useState('')
    const [readError, setReadError] = useState('')
    const [listError, setListError] = useState('')
    const [busy, setBusy] = useState(false)
    const [creating, setCreating] = useState(false)
    const [connected, setConnected] = useState(false)
    const [older, setOlder] = useState<Turn[]>([])
    const [olderCursor, setOlderCursor] = useState<string | null>(null)
    const [loadingOlder, setLoadingOlder] = useState(false)
    const [hasOlder, setHasOlder] = useState(false)
    const [atBottom, setAtBottom] = useState(true)
    const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([])
    const confirmedUserKeys = useRef(new Set<string>())
    const scroll = useRef<HTMLDivElement>(null)
    const input = useRef<HTMLTextAreaElement>(null)
    const nearBottom = useRef(true)
    const preserveScroll = useRef<{ height: number; top: number } | null>(null)
    const current = useRef<View | null>(null)
    const refreshRef = useRef<(() => Promise<void>) | null>(null)
    const listRefreshRef = useRef<(() => Promise<void>) | null>(null)
    const mutation = useRef(false)
    const composing = useRef(false)
    const epoch = useRef(0)
    const invoke = useCallback(async <T,>(command: Record<string, unknown>) => {
        const read = ['read', 'list', 'projects', 'models'].includes(String(command.op))
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), read ? 25000 : 75000)
        try { return await api.nativeDesktopCommand<T>(command, { signal: controller.signal }) }
        catch (error) {
            if (controller.signal.aborted) throw Error(read ? '读取超时，正在重新连接' : '提交结果暂未确认，请先查看原会话，避免重复发送')
            throw error
        } finally { clearTimeout(timer) }
    }, [api])
    const call = useCallback(async <T,>(command: Record<string, unknown>) => {
        try {
            const response = await invoke<T>({ app, ...command })
            if (!response.ok) throw Error(response.error || '桌面请求失败')
            return response.result as T
        } catch (error) { throw desktopError(error) }
    }, [invoke, app])
    const loadDesktopArchives = useCallback(async (cursor?: string) => {
        setLoadingArchives(true)
        try {
            const result = await call<{ threads: Thread[]; nextCursor?: string | null }>({ op: 'list', archived: true, ...(cursor ? { cursor } : {}) })
            if (archiveApp.current !== app) return
            setDesktopArchives(previous => cursor ? [...previous, ...result.threads.filter(entry => !previous.some(old => old.id === entry.id))] : result.threads)
            setArchiveCursor(result.nextCursor ?? null)
        } catch (e) { if (archiveApp.current === app) setError(e instanceof Error ? e.message : String(e)) }
        finally { if (archiveApp.current === app) setLoadingArchives(false) }
    }, [app, call])
    useEffect(() => { setDesktopArchives([]); setArchiveCursor(null) }, [app])
    useEffect(() => { if (showArchived) void loadDesktopArchives() }, [showArchived, loadDesktopArchives])
    useLayoutEffect(() => { setThreads(threadLists.current.get(listKey) ?? []) }, [listKey])
    useEffect(() => {
        let cancelled = false, pending = false
        setError(''); setListError('')
        const refresh = async () => {
            if (pending) return
            pending = true
            await Promise.all((['codex', 'claude'] as const).map(async name => {
                try {
                    const response = await invoke<{ threads: Thread[] }>({ app: name, op: 'list' })
                    if (cancelled) return
                    if (!response.ok || !response.result) throw Error(response.error || '读取会话列表失败')
                    const entries = response.result.threads
                    threadLists.current.set(`${draftScope.key}:${name}`, entries)
                    let ended = false
                    for (const entry of entries) {
                        const key = `${name}:${entry.id}`, previous = previousStatuses.current.get(key)
                        if (active(previous) && settled(entry.status)) ended = true
                        if (entry.status !== 'unknown') previousStatuses.current.set(key, entry.status)
                    }
                    if (ended && name !== app) setCompletion(value => ({ ...value, [name]: Date.now() }))
                    if (name === app) { setThreads(entries); setListError(''); setDesktopArchives(previous => previous.filter(entry => !entries.some(active => active.id === entry.id))); setConnected(true) }
                } catch (e) { if (!cancelled && name === app && !current.current) { setConnected(false); setListError(desktopError(e).message) } }
            }))
            pending = false
        }
        listRefreshRef.current = refresh
        const reconnect = () => { if (!document.hidden) void refresh() }
        document.addEventListener('visibilitychange', reconnect)
        window.addEventListener('online', reconnect)
        void refresh()
        const timer = setInterval(() => { if (!document.hidden) void refresh() }, 5000)
        return () => { cancelled = true; clearInterval(timer); listRefreshRef.current = null; document.removeEventListener('visibilitychange', reconnect); window.removeEventListener('online', reconnect) }
    }, [invoke, app, draftScope.key])
    useEffect(() => {
        setReadError('')
        const generation = ++epoch.current
        if (!selected) { current.current = null; setView(null); return }
        let cancelled = false, pending = false
        let readFailures = 0
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
                readFailures = 0
                setConnected(true); setReadError('')
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
            } catch (e) {
                if (!cancelled && (++readFailures >= 2 || !current.current)) {
                    setConnected(false); setReadError(e instanceof Error ? e.message : String(e))
                }
            }
            finally {
                pending = false
                if (!cancelled) timer = setTimeout(() => { if (document.hidden) { timer = setTimeout(() => void refresh(), 3000); return } void refresh() }, active(current.current?.status) ? 1200 : 3000)
            }
        }
        refreshRef.current = refresh
        const reconnect = () => { if (!document.hidden) void refresh() }
        document.addEventListener('visibilitychange', reconnect)
        window.addEventListener('online', reconnect)
        void refresh()
        return () => { cancelled = true; clearTimeout(timer); refreshRef.current = null; document.removeEventListener('visibilitychange', reconnect); window.removeEventListener('online', reconnect) }
    }, [app, call, selected])
    useEffect(() => { if (selected) setCreating(false); setManualLink(''); setPendingMessages([]); confirmedUserKeys.current = new Set(); setError('') }, [app, selected])
    useEffect(() => { setNewModel(''); setModels([]); if (!creating || app !== 'codex') return; let cancelled = false; void call<{ models: { id: string }[] }>({ op: 'models' }).then(result => { if (!cancelled) setModels(result.models ?? []) }).catch(() => {}); return () => { cancelled = true } }, [creating, app, call])
    useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 2500); return () => clearTimeout(timer) }, [notice])
    useEffect(() => { if (view && !older.length) setHasOlder(view.hasEarlier) }, [view, older.length])
    useEffect(() => {
        if (!view || !pendingMessages.length) return
        const users = view.turns.flatMap(turn => turn.items).filter(item => item.role === 'user')
        const used = new Set(confirmedUserKeys.current), resolved = new Set<string>()
        for (const message of pendingMessages) {
            const match = users.find(item => !used.has(item.key) && !message.baseline.has(item.key) && (message.text.trim() ? item.text.trim() === message.text.trim() : !!item.images?.length || /!\[/.test(item.text)))
            if (match) { used.add(match.key); resolved.add(message.id) }
        }
        if (resolved.size) { confirmedUserKeys.current = used; setPendingMessages(previous => previous.filter(message => !resolved.has(message.id))) }
    }, [view, pendingMessages])
    useLayoutEffect(() => {
        const el = scroll.current
        if (!el) return
        if (preserveScroll.current) {
            const previous = preserveScroll.current
            el.scrollTop = previous.top + el.scrollHeight - previous.height
            preserveScroll.current = null
        } else if (nearBottom.current) el.scrollTop = el.scrollHeight
    }, [view, older, pendingMessages])
    useEffect(() => {
        const element = scroll.current, content = element?.firstElementChild
        if (!element || !content) return
        const follow = () => { if (nearBottom.current) element.scrollTop = element.scrollHeight }
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow)
        observer?.observe(content)
        element.addEventListener('native-image-loaded', follow)
        return () => { observer?.disconnect(); element.removeEventListener('native-image-loaded', follow) }
    }, [selected, creating])
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
        const actionId = crypto.randomUUID()
        mutation.current = true; setBusy(true); setError('')
        if (op === 'send' || op === 'create') { setPendingMessages(previous => [...previous, { id: actionId, text: String(extra.text ?? ''), images: (extra.images as DraftImage[] | undefined) ?? [], queued: false, sending: true, baseline: new Set(current.current?.turns.flatMap(turn => turn.items.map(item => item.key))) }]); nearBottom.current = true; setAtBottom(true) }
        try {
            const result = await call<{ threadId?: string; sessionId?: string; queued?: boolean }>({ op, id: selected, actionId, ...extra })
            if (generation !== epoch.current) return
            if (op === 'send' || op === 'create') { setDraft(''); setImages([]); setPendingMessages(previous => previous.map(message => message.id === actionId ? { ...message, queued: result.queued === true, sending: false } : message)) }
            if (op === 'create') { setCreating(false); select(app, result.threadId ?? result.sessionId); setPendingMessages([]) }
            else void refreshRef.current?.()
        } catch (e) { if (generation === epoch.current) { setPendingMessages(previous => previous.filter(message => message.id !== actionId)); setError(e instanceof Error ? e.message : String(e)) } }
        finally { mutation.current = false; setBusy(false); input.current?.focus() }
    }
    const addImages = async (files: File[]) => {
        if (preparingImages || busy) return
        setPreparingImages(true); setError('')
        try {
            if (files.length + images.length > 4) throw Error('每条消息最多附加 4 张图片')
            const { prepareImage } = await import('@/components/nativeDesktop/attachments')
            const added = await Promise.all(files.map(prepareImage))
            setImages(previous => [...previous, ...added].slice(0, 4))
        } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { setPreparingImages(false) }
    }
    const sendDraft = () => { if ((draft.trim() || images.length) && !busy && !preparingImages && connected) void act(creating ? 'create' : 'send', { text: draft, ...(images.length ? { images } : {}), ...(creating && app === 'codex' && newModel ? { model: newModel } : {}) }) }
    const open = (id: string) => { if (mutation.current) return; select(app, id); setCreating(false); setError('') }
    const newChat = () => { if (mutation.current) return; select(app); setCreating(true); setError('') }
    const statusFor = (entry: Thread) => entry.id === selected && view?.id === selected ? view.status : entry.status
    const pinned = (thread: Thread) => !!thread.pinned
    const sourceThreads = showArchived ? desktopArchives : threads
    const visibleThreads = sourceThreads.filter(t => t.title?.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => Number(pinned(b)) - Number(pinned(a)))
    const togglePin = async (entry: Thread) => {
        if (mutation.current) return
        mutation.current = true; setBusy(true); setError('')
        const target = !entry.pinned
        try {
            const result = await call<{ id: string; native: boolean; pinned: boolean }>({ op: 'pin', id: entry.id, pinned: target, actionId: crypto.randomUUID() })
            if (!result.native || result.id !== entry.id || result.pinned !== target) throw Error('桌面置顶状态尚未确认，请刷新后查看')
            const update = (entries: Thread[]) => entries.map(thread => thread.id === entry.id ? { ...thread, pinned: result.pinned } : thread)
            setThreads(update); setDesktopArchives(update)
            threadLists.current.set(listKey, update(threadLists.current.get(listKey) ?? []))
            setNotice(target ? '已同步置顶到桌面 App' : '已在桌面 App 取消置顶')
        } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { mutation.current = false; setBusy(false) }
    }
    const toggleArchive = async (entry: Thread) => {
        if (mutation.current) return
        const nativeArchived = desktopArchives.some(record => record.id === entry.id) || !!entry.archived
        mutation.current = true; setBusy(true); setError('')
        try {
            const result = await call<{ native: boolean; archived: boolean }>({ op: 'archive', id: entry.id, archived: !nativeArchived, actionId: crypto.randomUUID() })
            if (!result.native || result.archived !== !nativeArchived) throw Error('桌面归档状态尚未确认，请刷新后查看')
            if (!nativeArchived) {
                setThreads(previous => previous.filter(record => record.id !== entry.id))
                threadLists.current.set(listKey, (threadLists.current.get(listKey) ?? []).filter(record => record.id !== entry.id))
                setDesktopArchives(previous => [{ ...entry, archived: true }, ...previous.filter(record => record.id !== entry.id)])
            } else {
                setDesktopArchives(previous => previous.filter(record => record.id !== entry.id))
                setThreads(previous => [{ ...entry, archived: false }, ...previous.filter(record => record.id !== entry.id)])
                threadLists.current.set(listKey, [{ ...entry, archived: false }, ...(threadLists.current.get(listKey) ?? []).filter(record => record.id !== entry.id)])
            }
            setNotice(nativeArchived ? '已在桌面 App 恢复会话' : '已同步归档到桌面 App')
        } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { mutation.current = false; setBusy(false) }
    }
    const copyLink = async (id: string) => {
        const link = nativeConversationLink(app, id)
        try {
            if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable')
            await navigator.clipboard.writeText(link)
            setManualLink(''); setNotice('链接已复制')
        } catch { setManualLink(link) }
    }
    const reconnect = () => { void refreshRef.current?.(); void listRefreshRef.current?.() }
    const visibleError = error || (selected ? readError : listError)
    const title = view?.title || threads.find(t => t.id === selected)?.title || '桌面会话'
    const selectedThread: Thread | null = selected ? [...threads, ...desktopArchives].find(t => t.id === selected) ?? { id: selected, title, status: view?.status ?? 'unknown' } : null
    const isArchived = (id: string) => !threads.some(entry => entry.id === id) && desktopArchives.some(entry => entry.id === id)
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
    const latestTool = [...allTurns].reverse().flatMap(turn => [...turn.items].reverse()).find(item => item.role === 'tool')
    return <div className="nd-root" data-open={!!selected || creating}>
        <aside className="nd-side">
            <header className="nd-side-head"><span className="nd-home">{app === 'codex' ? 'Codex' : 'Claude Code'}</span><button className="nd-new" onClick={newChat} disabled={busy}>＋ 新聊天</button></header>
            <div className="nd-side-title">桌面会话</div>
            <div className="nd-tabs">{(['codex', 'claude'] as const).map(name => <button aria-pressed={name === app} data-notify={!!completion[name]} key={name + (completion[name] ?? 0)} onAnimationEnd={() => setCompletion(value => ({ ...value, [name]: 0 }))} onClick={() => { if (busy) return; setCompletion(value => ({ ...value, [name]: 0 })); select(name); setCreating(false); setFilter(''); setShowArchived(false) }}>{name === 'codex' ? 'Codex' : 'Claude Code'}</button>)}</div>
            <div className="nd-search"><span>⌕</span><input aria-label="搜索桌面会话" placeholder="搜索会话" value={filter} onChange={e => setFilter(e.target.value)} /></div>
            <div className="nd-list">{visibleThreads.map((t, index) => <div className="nd-list-entry" key={t.id}>
                {(index === 0 || !showArchived && pinned(visibleThreads[index - 1]) !== pinned(t)) && <div className="nd-list-label">{showArchived ? '已归档' : pinned(t) ? '置顶' : '最近'}</div>}
                <div className="nd-thread-row"><button className="nd-thread" aria-current={t.id === selected ? 'true' : undefined} onClick={() => open(t.id)}><span className="nd-thread-title">{t.title || '未命名会话'}</span>{active(statusFor(t)) || settled(statusFor(t)) ? <span className="nd-thread-indicator nd-dot" data-active={active(statusFor(t))} data-completed={settled(statusFor(t))} role="img" aria-label={active(statusFor(t)) ? '任务运行中' : '本轮已结束'} title={active(statusFor(t)) ? '任务运行中' : '本轮已结束'}></span> : pinned(t) && <span className="nd-thread-pinned" aria-label="已置顶">↟</span>}</button>
                    <ThreadActions title={t.title} pinned={pinned(t)} archived={isArchived(t.id)} disabled={busy} onPin={() => void togglePin(t)} onCopy={() => void copyLink(t.id)} onArchive={() => void toggleArchive(t)} />
                </div>
            </div>)}{showArchived && archiveCursor && <button className="nd-text-btn" disabled={loadingArchives} onClick={() => void loadDesktopArchives(archiveCursor)}>{loadingArchives ? '读取中…' : '更多桌面归档'}</button>}{!visibleThreads.length && <div className="nd-empty">{filter ? '没有匹配的会话' : showArchived ? loadingArchives ? '读取桌面归档…' : '还没有归档的会话' : connected ? '还没有桌面会话' : '正在连接…'}</div>}</div>
            <button type="button" className="nd-archive-toggle" aria-pressed={showArchived} title="查看桌面原会话归档" onClick={() => { setShowArchived(value => !value); setFilter('') }}><span>{showArchived ? '‹ 返回最近' : '▤ 已归档'}</span>{!showArchived && desktopArchives.length > 0 && <small>{desktopArchives.length}</small>}</button>
            {!selected && !creating && visibleError && <div className="nd-error" role="alert">{visibleError}{(!connected || readError || listError) && <button className="nd-text-btn" onClick={reconnect}>重新连接</button>}</div>}
        </aside>
        <main className="nd-main">
            <header className="nd-head"><button className="nd-mobile-back nd-icon-btn" onClick={() => { if (!busy) { select(app); setCreating(false) } }} aria-label="返回列表">‹</button><div className="nd-title"><strong>{creating ? `新建 ${app === 'codex' ? 'Codex' : 'Claude Code'} 会话` : title}</strong>{selected && (!connected || attentionText(view?.status)) && <div className="nd-status" role="status">{connected ? attentionText(view?.status) : '连接中断，正在重连'}</div>}</div>{selected && <button type="button" className="nd-copy-link" aria-label="复制链接" title="复制链接" onClick={() => void copyLink(selected)}><CopyLinkIcon /></button>}{selected && (active(view?.status) || app === 'claude' && view?.status === 'unknown') && <button className="nd-stop" disabled={busy || !connected} title="停止原 App 中此会话的当前轮" onClick={() => void act('stop')}>■ 停止</button>}</header>
            {view?.delegations && view.delegations.running > 0 && <div className="nd-dsh-live" aria-label="当前 DSH 任务">{view.delegations.tasks.filter(task => task.state === 'running').map(task => <span key={task.id} title={task.title}><i />DSH {task.number}</span>)}</div>}
            {selectedThread && isArchived(selectedThread.id) && <div className="nd-archived-notice">已同步桌面归档<button type="button" disabled={busy} onClick={() => void toggleArchive(selectedThread)}>恢复到最近</button></div>}
            <div className="nd-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) { const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100; nearBottom.current = bottom; setAtBottom(bottom) } }}><div className="nd-content">
                {selected && !view && <div className="nd-loading"><div /><div /><div /><p>读取最近的消息…</p></div>}
                {!selected && <div className="nd-welcome"><span className={`nd-avatar nd-avatar-${app}`}>{app === 'codex' ? 'C' : '✳'}</span><h2>{creating ? '开始新的对话' : '接着聊，接着做'}</h2><p>{creating ? '发出第一条消息后，会话也会出现在桌面 App 中。' : '选择左侧会话，继续桌面上的工作。'}</p></div>}
                {view && hasOlder && <div className="nd-history-more"><button onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? '正在读取…' : '↑ 更早的消息'}</button></div>}
                {selected && <ConversationHistory turns={allTurns} call={call} id={selected} app={app} />}
                {view && active(view.status) && <div className="nd-live-activity" role="status" aria-label="任务运行中"><i /><span>{latestTool?.text ? `最近工具 · ${latestTool.text.slice(0, 90)}` : app === 'codex' ? 'Codex' : 'Claude Code'}</span></div>}
                {pendingMessages.map(message => <article key={message.id} className="nd-message nd-user nd-pending">{message.text && <div className="nd-user-text">{message.text}</div>}{message.images.length > 0 && <div className="nd-message-images">{message.images.map((image, index) => <InlineImage key={index} src={image.data} alt={image.name} />)}</div>}<span className="nd-subtle">{message.sending ? '发送中…' : message.queued ? '已排队，等待接续' : '已发送，等待同步'}</span></article>)}
                {view?.requests.map((request, index) => <PendingRequest key={`${app}:${selected}:${request.id ?? request.requestId ?? index}`} request={request} disabled={busy} respond={value => void act('respond', value)} />)}
            </div></div>
            {!atBottom && selected && <button className="nd-jump" onClick={() => { nearBottom.current = true; setAtBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }) }}>↓ 最新消息</button>}
            {visibleError && (selected || creating) && <div className="nd-error" role="alert">{visibleError}{(!connected || readError || listError) && <button className="nd-text-btn" onClick={reconnect}>重新连接</button>}</div>}
            {manualLink && <div className="nd-copy-fallback"><label>会话链接<input aria-label="会话链接" readOnly value={manualLink} onFocus={e => e.currentTarget.select()} autoFocus /></label><button type="button" aria-label="关闭链接" onClick={() => setManualLink('')}>×</button></div>}
            {(selected || creating) && <div className="nd-compose-wrap"><form className="nd-compose" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void addImages(Array.from(e.dataTransfer.files)) } }} onSubmit={e => { e.preventDefault(); sendDraft() }}><input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label="选择图片" onChange={e => { void addImages(Array.from(e.target.files ?? [])); e.target.value = '' }} />{images.length > 0 && <div className="nd-attachment-previews">{images.map((image, index) => <div key={index}><img src={image.data} alt={image.name} /><button type="button" aria-label={`移除图片 ${index + 1}`} disabled={busy} onClick={() => setImages(value => value.filter((_, i) => i !== index))}>×</button></div>)}</div>}<textarea ref={input} aria-label="消息" rows={2} placeholder="问点什么，或继续这项工作…" value={draft} disabled={busy} onPaste={e => { const files = Array.from(e.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).flatMap(item => { const file = item.getAsFile(); return file ? [file] : [] }); if (files.length) { e.preventDefault(); void addImages(files) } }} onChange={e => setDraft(e.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current && e.keyCode !== 229) { e.preventDefault(); sendDraft() } }} /><div className="nd-compose-footer"><div className="nd-compose-left"><button type="button" className="nd-attach" aria-label="添加图片" title="选择图片，也可粘贴或拖入" disabled={busy || preparingImages || images.length >= 4} onClick={() => imageInput.current?.click()}>{preparingImages ? '…' : '＋'}</button><span className="nd-compose-app">{creating && app === 'codex' ? <select aria-label="新会话模型" value={newModel} disabled={busy} onChange={e => setNewModel(e.target.value)}><option value="">桌面默认模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}</select> : creating ? <span title="使用 Claude 桌面的默认模型">Claude Code · 桌面默认</span> : app === 'codex' ? 'Codex' : 'Claude Code'}</span></div><div className="nd-compose-controls"><span>Shift + Enter 换行</span><button type="submit" aria-label="发送消息" disabled={busy || preparingImages || !connected || (!draft.trim() && !images.length)}>{busy ? '···' : '↑'}</button></div></div></form></div>}
        </main>
        {notice && <div className="nd-toast" role="status">{notice}</div>}
    </div>
}
