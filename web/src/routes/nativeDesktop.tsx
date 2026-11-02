import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { FileChanges } from '@/components/nativeDesktop/FileChanges'
import { InlineImage } from '@/components/nativeDesktop/InlineImage'
import { NativeMessageContent, isEmptyInertText, isPureHeartbeatText } from '@/components/nativeDesktop/MessageContent'
import { nativeConversationLink } from '@/components/nativeDesktop/navigation'
import { CopyLinkIcon, ThreadActions } from '@/components/nativeDesktop/ThreadActions'
import { composerStorageScope, useComposerDraft } from '@/components/nativeDesktop/useComposerDraft'
import type { DraftImage } from '@/components/nativeDesktop/attachments'
import { ModelPicker, type ModelSettings } from '@/components/nativeDesktop/ModelPicker'
import { PendingRequest } from '@/components/nativeDesktop/PendingRequest'
import { AppBrandIcon } from '@/components/nativeDesktop/AppBrandIcon'
import { AgentActivity, type Delegations } from '@/components/nativeDesktop/AgentActivity'
import { useCompletionReadState } from '@/components/nativeDesktop/useCompletionReadState'
import './nativeDesktop.css'
import { OrchestraWorkspace } from '@/components/nativeDesktop/OrchestraWorkspace'

type NativeStatus = string | { type?: string; activeFlags?: string[] } | null
type Thread = { id: string; title: string; status: NativeStatus; pendingState?: 'approval' | 'input' | string | null; updatedAt?: number | string; cwd?: string; pinned?: boolean; archived?: boolean }
type Item = { images?: string[]; files?: {path: string; additions?: number; deletions?: number}[]; id: string; key: string; role: string; text: string; phase?: string; hasDetail?: boolean; textTruncated?: boolean; output?: string; outputLength?: number; outputMore?: boolean; status?: string; error?: string; delegation?: { label: string; phase: string; status: string; numbers?: number[]; state?: string } }
type Turn = { id: string; status: string; items: Item[]; activityGroup?: string; durationMs?: number; startedAt?: string | number; completedAt?: string | number }
type View = { activeFlags?: string[]; pendingState?: 'approval' | 'input' | null; modelSettings?: ModelSettings; id: string; title: string; status: NativeStatus; live: boolean; historyComplete: boolean; hasEarlier: boolean; before: string | null; revision: string; windowStart: number; turns: Turn[]; requests: Record<string, unknown>[]; delegations?: Delegations }
type ReadResult = View | { id: string; revision: string; unchanged: true }
type Command = <T,>(command: Record<string, unknown>) => Promise<T>
type PendingMessage = { id: string; text: string; images: DraftImage[]; queued: boolean; sending: boolean; baseline: Set<string> }
const statusName = (status?: NativeStatus) => typeof status === 'string' ? status : status?.type ?? ''
const active = (status?: NativeStatus) => ['active', 'running', 'inProgress', 'busy'].includes(statusName(status))
const attentionText = (status?: NativeStatus) => statusName(status) === 'locked' ? 'Mac 已锁屏' : statusName(status) === 'notLoaded' ? '请先在桌面打开此会话' : ''
const settled = (status?: NativeStatus) => ['idle', 'completed'].includes(statusName(status))
type RequestKind = 'approval' | 'input' | ''
export function pendingRequestKind(request: Record<string, unknown>): RequestKind {
    const method = String(request.method ?? (request.request as { method?: unknown } | undefined)?.method ?? '')
    if (method === 'item/tool/requestUserInput') return 'input'
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method) || method === 'native/approval' && Array.isArray(request.buttons)) return 'approval'
    return ''
}
export function pendingStatus(status?: NativeStatus, pendingState?: string | null, requests?: Record<string, unknown>[]): string {
    if (pendingState === 'approval') return '等待审批'
    if (pendingState === 'input') return '需要输入'
    const flags = typeof status === 'object' ? status?.activeFlags ?? [] : []
    if (flags.includes('waitingOnApproval') || statusName(status) === 'waitingOnApproval') return '等待审批'
    if (flags.includes('waitingOnUserInput') || statusName(status) === 'waitingOnUserInput') return '需要输入'
    const kind = (requests ?? []).map(pendingRequestKind).find(Boolean)
    return kind === 'approval' ? '等待审批' : kind === 'input' ? '需要输入' : ''
}
const dshLabel = (value?: Item['delegation']) => value?.numbers?.length ? `${value.label} ${value.numbers.join(' · ')}` : value?.label || 'DSH'
const cachedViews = new Map<string, View>()
const CACHED_VIEW_LIMIT = 12
const LIVE_RECOVERY_GRACE_MS = 15000

function cacheView(key: string, next: View) {
    cachedViews.set(key, next)
    // Keep the previous bound: the oldest cached identity is evicted on insertion.
    while (cachedViews.size > CACHED_VIEW_LIMIT) {
        const oldest = cachedViews.keys().next().value
        if (oldest === undefined) break
        cachedViews.delete(oldest)
    }
}

class ReadIdentityMismatchError extends Error {
    constructor() { super('桌面返回了其他会话的内容，已保留当前会话'); this.name = 'ReadIdentityMismatchError' }
}

class ReadSourceRecoveryError extends Error {
    constructor() { super('实时连接正在恢复，已保留当前内容'); this.name = 'ReadSourceRecoveryError' }
}

const identityMismatch = () => new ReadIdentityMismatchError()
const isIdentityMismatch = (error: unknown): error is ReadIdentityMismatchError => error instanceof ReadIdentityMismatchError

function abortedReadError(): Error {
    const error = new Error('读取已取消')
    error.name = 'AbortError'
    return error
}

function transientDesktopReadError(error: unknown): boolean {
    if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return true
    if (!error || typeof error !== 'object' || !('status' in error) || ![502, 503, 504].includes(Number(error.status))) return false
    if ('body' in error && typeof error.body === 'string') {
        try {
            const detail = JSON.parse(error.body)
            if (detail?.code === 'desktop_transport_unavailable') return true
            if (typeof detail?.error === 'string') return false
        } catch { /* Gateway HTML has no native error. */ }
    }
    return true
}

function desktopError(error: unknown, mutation = false): Error {
    let detail: { error?: unknown; delivery?: unknown } | null = error && typeof error === 'object' ? error : null
    if (error && typeof error === 'object' && 'body' in error && typeof error.body === 'string') {
        try { detail = JSON.parse(error.body) } catch { /* Gateways may return HTML. */ }
        if (typeof detail?.error === 'string') return desktopError(detail, mutation)
        const status = 'status' in error && typeof error.status === 'number' ? error.status : error instanceof Error ? error.message.match(/^HTTP (\d{3})\b/)?.[1] : undefined
        return Error(`桌面连接暂时不可用${status ? `（HTTP ${status}）` : ''}`)
    }
    if (mutation && detail?.delivery === 'unknown') return Error('提交结果暂未确认，请先查看原会话，避免重复操作')
    if (typeof detail?.error === 'string') return Error(detail.error)
    return error instanceof Error ? error : Error(String(error))
}

const Message = memo(function Message({ item, call, id, app, visible = true }: { item: Item; call: Command; id: string; app: string; visible?: boolean }) {
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
        } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { setFetchedVersion(version); setLoading(false) }
    }, [loading, call, id, item.key, detail?.output?.length, version])
    useEffect(() => { if (visible && opened && !loading && fetchedVersion !== version) void load() }, [visible, opened, loading, fetchedVersion, version, load])
    const loadImage = useCallback(async (source: string, size?: 'large') => {
        const result = await call<{ image: { src: string } }>({ op: 'read', id, itemKey: item.key, imageSrc: source, ...(size ? { imageSize: size } : {}) })
        return result.image.src
    }, [call, id, item.key])
    const shownDetail = detail?.key === item.key && (item.role === 'tool' || fetchedVersion === version) ? detail : null
    const value = shownDetail ?? item
    if (item.role === 'tool') return <div className="nd-tool-row">
        <details onToggle={event => setOpened(event.currentTarget.open)}>
            <summary><span className="nd-tool-dot" data-active={active(item.status)} data-completed={item.status === 'completed'} /><span>{item.text || '工具调用'}</span>{item.delegation && <span className="nd-dsh" data-state={item.delegation.state} title={`${item.delegation.phase} · ${item.delegation.state === 'completed' ? '委派任务已完成' : item.delegation.status}`}>{dshLabel(item.delegation)}</span>}<span className="nd-tool-chevron">›</span></summary>
            {loading && !shownDetail && <p className="nd-subtle">读取工具结果…</p>}
            {shownDetail && <pre>{shownDetail.output || shownDetail.text || '没有文本输出'}</pre>}
            {shownDetail?.outputMore && <button className="nd-text-btn" onClick={() => void load(true)} disabled={loading}>{loading ? '读取中…' : '继续读取输出'}</button>}
            {error && <p role="alert" className="nd-inline-error">{error} <button className="nd-text-btn" disabled={loading} onClick={() => void load()}>重试</button></p>}
        </details>
    </div>
    return <article className={`nd-message nd-${item.role}`}>
        {item.role !== 'user' && <div className="nd-author"><span className={`nd-avatar nd-avatar-${app}`}><AppBrandIcon app={app} /></span><span>{app === 'codex' ? 'Codex' : 'Claude'}</span>{item.phase === 'commentary' && <span className="nd-phase">进展</span>}</div>}
        <div className="nd-message-body"><NativeMessageContent text={value.text} user={item.role === 'user'} loadImage={loadImage} />{item.images?.length ? <div className="nd-message-images">{item.images.map(source => <InlineImage key={source} src={source} alt="消息图片" load={loadImage} />)}</div> : null}</div>
        {item.textTruncated && !shownDetail && <button className="nd-text-btn" onClick={() => void load()} disabled={loading}>{loading ? '读取全文…' : '展开全文'}</button>}
        {error && <p role="alert" className="nd-inline-error">{error}</p>}
    </article>
}, (before, after) => before.id === after.id && before.app === after.app && before.call === after.call && before.visible === after.visible && JSON.stringify(before.item) === JSON.stringify(after.item))

function ToolGroup({ tools, call, id, app }: { tools: Item[]; call: Command; id: string; app: string }) {
    const [opened, setOpened] = useState(false)
    const [mounted, setMounted] = useState(false)
    const delegations = tools.flatMap(item => item.delegation ? [item.delegation] : [])
    const numbers = [...new Set(delegations.flatMap(item => item.numbers ?? []))].sort((a, b) => a - b)
    const label = [...new Set(delegations.map(item => item.label))].join(' / ')
    const state = numbers.length ? 'running' : delegations.length && delegations.every(item => item.state === 'completed') ? 'completed' : undefined
    return <details className="nd-activity" onToggle={event => { setOpened(event.currentTarget.open); if (event.currentTarget.open) setMounted(true) }}>
        <summary><span className="nd-activity-icon">⌘</span><span>{tools.some(item => active(item.status)) ? '正在使用工具' : '工具记录'}<span className="nd-count">{tools.length}</span></span>{delegations.length > 0 && <span className="nd-dsh" data-state={state} title="编号仅表示此会话当前同时运行的子 Agent，启动脚本退出不等于任务完成">{numbers.length ? `${label} ${numbers.join(' · ')}` : `${label} 委托`}</span>}<span className="nd-tool-chevron">›</span></summary>
        {mounted && <div>{tools.map(item => <Message key={item.key} item={item} call={call} id={id} app={app} visible={opened} />)}</div>}
    </details>
}

const emptyInertItem = (item: Item): boolean => {
    // Anything a user can see, expand, load or act on is meaningful.
    if (item.images?.length || item.files?.length || item.textTruncated || item.hasDetail || item.delegation || item.output?.trim() || item.outputLength || item.outputMore || item.error || active(item.status)) return false
    return (item.role === 'assistant' || item.role === 'tool') && isEmptyInertText(item.text)
}

const pureHeartbeatItem = (item: Item): boolean => (item.role === 'assistant' || item.role === 'user')
    && !item.images?.length && !item.files?.length && !item.textTruncated && !item.hasDetail
    && !item.delegation && !item.output?.trim() && !item.outputLength && !item.outputMore && !item.error && !active(item.status)
    && isPureHeartbeatText(item.text)

type HistoryGroup = { key: string; tools?: Item[]; item?: Item; heartbeats?: Item[] }

function HistoryItems({ items, call, id, app }: { items: Item[]; call: Command; id: string; app: string }) {
    const groups: HistoryGroup[] = []
    for (const original of items) {
        // Native reasoning is not user-facing conversation content.
        if (original.phase === 'reasoning') continue
        const item = original.files?.length ? { ...original, files: undefined } : original
        if (emptyInertItem(item)) continue
        if (pureHeartbeatItem(item)) {
            const previous = groups.at(-1)
            if (previous?.heartbeats) {
                previous.heartbeats.push(item)
                previous.key = `${previous.key}:${item.key}`
            } else groups.push({ key: item.key, heartbeats: [item] })
            continue
        }
        if (item.role === 'tool') {
            const previous = groups.at(-1)
            if (previous?.tools) previous.tools.push(item)
            else groups.push({ key: item.key, tools: [item] })
        } else groups.push({ key: item.key, item })
    }
    return <>{groups.map(group => group.item
        ? <Message key={group.key} item={group.item} call={call} id={id} app={app} />
        : group.heartbeats
            ? <div className="nd-heartbeat-run" key={group.key}><NativeMessageContent text={group.heartbeats.map(item => item.text).join('\n')} /></div>
            : <ToolGroup key={group.key} tools={group.tools!} call={call} id={id} app={app} />)}</>
}

function durationLabel(turn: Turn): string | null {
    const time = (value: string | number | undefined) => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : value ? Date.parse(value) : NaN
    const duration = turn.durationMs ?? time(turn.completedAt) - time(turn.startedAt)
    if (!Number.isFinite(duration) || duration < 0) return null
    const seconds = Math.max(1, Math.round(duration / 1000))
    return `用时 ${seconds >= 3600 ? `${Math.floor(seconds / 3600)}小时` : ''}${seconds >= 60 ? `${Math.floor(seconds % 3600 / 60)}分钟` : ''}${seconds % 60 || seconds < 60 ? `${seconds % 60}秒` : ''}`
}

function FinishedActivity({ items, label, call, id, app }: { items: Item[]; label: string; call: Command; id: string; app: string }) {
    const [opened, setOpened] = useState(false)
    return <details className="nd-finished-activity" onToggle={event => setOpened(event.currentTarget.open)}>
        <summary>{label}<span aria-hidden="true">›</span></summary>
        {opened && <div className="nd-finished-body"><HistoryItems items={items} call={call} id={id} app={app} /></div>}
    </details>
}

const ConversationHistory = memo(function ConversationHistory({ turns, call, id, app }: { turns: Turn[]; call: Command; id: string; app: string }) {
    const rounds: Turn[] = []
    const byId = new Map<string, Turn>()
    let claudeRound = ''
    for (const turn of turns) {
        if (app === 'claude' && (!claudeRound || turn.items.some(item => item.role === 'user'))) claudeRound = turn.id
        const key = turn.activityGroup ?? (app === 'claude' ? claudeRound : turn.id) ?? turn.items[0]?.key
        const existing = byId.get(key)
        if (existing) {
            // Pagination may split the same original turn. Keep a single ordered round.
            const items = new Map(existing.items.map(item => [item.key, item]))
            for (const item of turn.items) items.set(item.key, item)
            Object.assign(existing, turn, { items: [...items.values()], id: key })
        } else { const round = { ...turn, id: key, items: [...turn.items] }; rounds.push(round); byId.set(key, round) }
    }
    // A paginated or per-message turn can contain only a no-op heartbeat. Fold
    // adjacent pure checks across those boundaries, but never over real content.
    const rendered: (Turn & { heartbeatOnly?: boolean })[] = []
    for (const turn of rounds) {
        const items = turn.items.filter(item => item.phase !== 'reasoning')
        const pure = items.length > 0 && items.some(pureHeartbeatItem) && items.every(item => pureHeartbeatItem(item) || emptyInertItem(item))
        if (!pure && items.every(emptyInertItem)) continue
        const previous = rendered.at(-1)
        if (pure && previous?.heartbeatOnly) {
            previous.items.push(...items)
            previous.status = turn.status
            previous.durationMs = turn.durationMs ?? previous.durationMs
        } else rendered.push({ ...turn, items, heartbeatOnly: pure })
    }
    return <section className="nd-turn">{rendered.map(turn => {
        const complete = app === 'claude' ? turn.items.some(item => item.phase === 'final_answer') : settled(turn.status) || ['interrupted', 'failed'].includes(turn.status)
        const files = complete ? turn.items.filter(item => item.files?.length) : []
        const activity = turn.items.filter(item => !files.includes(item) && !pureHeartbeatItem(item) && !emptyInertItem(item) && (item.role === 'tool' || item.role === 'assistant' && item.phase === 'commentary'))
        const label = durationLabel(turn)
        // Completed native activity always folds, even when the original record has no timing metadata.
        const fold = complete && activity.length > 0
        if (!fold) return <div key={turn.id}><HistoryItems items={turn.items.filter(item => !files.includes(item))} call={call} id={id} app={app} />{files.length > 0 && <FileChanges items={files} call={call} id={id} />}</div>
        const first = turn.items.findIndex(item => activity.includes(item))
        return <div key={turn.id} className="nd-round">
            <HistoryItems items={turn.items.slice(0, first).filter(item => !files.includes(item))} call={call} id={id} app={app} />
            <FinishedActivity items={activity} label={label ?? '查看进展与工具记录'} call={call} id={id} app={app} />
            <HistoryItems items={turn.items.slice(first).filter(item => !activity.includes(item) && !files.includes(item))} call={call} id={id} app={app} />
            {files.length > 0 && <FileChanges items={files} call={call} id={id} />}
        </div>
    })}</section>
})

export default function NativeDesktopPage() {
    const { view } = useSearch({ from: '/desktop' })
    return view === 'orchestra' || view === 'orchestra-system' ? <OrchestraWorkspace view={view} /> : <NativeDesktopChat />
}

function NativeDesktopChat() {
    const { api, token, baseUrl } = useAppContext()
    const { app, thread } = useSearch({ from: '/desktop' })
    const navigate = useNavigate()
    const selected = thread ?? null
    const select = (nextApp: 'codex' | 'claude', id?: string) => { void navigate({ to: '/desktop', search: { app: nextApp, thread: id } }) }
    const [threads, setThreads] = useState<Thread[]>([])
    const [view, setView] = useState<View | null>(null)
    const draftScope = composerStorageScope(token, baseUrl)
    const { unread, markRead, observeRunning } = useCompletionReadState(draftScope.key)
    const listKey = `${draftScope.key}:${app}`
    const threadLists = useRef(new Map<string, Thread[]>())
    const conversationKey = `${app}:${selected ?? 'new'}`
    const viewCacheKey = `${draftScope.key}:${app}:${selected ?? ''}`
    const [draft, setDraft, images, setImages] = useComposerDraft(`${draftScope.key}:${conversationKey}`, draftScope.owner ? conversationKey : undefined)
    const [preparingImages, setPreparingImages] = useState(false)
    const imageInput = useRef<HTMLInputElement>(null)
    const [completion, setCompletion] = useState<Record<string, number>>({})
    const previousStatuses = useRef(new Map<string, NativeStatus>())
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
    const [error, setError] = useState('')
    const [readError, setReadError] = useState('')
    const [listError, setListError] = useState('')
    const [busy, setBusy] = useState(false)
    const [creating, setCreating] = useState(false)
    const [listHealth, setListHealth] = useState({ key: '', connected: false })
    const [readHealth, setReadHealth] = useState({ key: '', connected: false })
    const connected = selected ? readHealth.key === conversationKey && readHealth.connected : listHealth.key === listKey && listHealth.connected
    const [older, setOlder] = useState<Turn[]>([])
    const historyTurns = useMemo(() => [...older, ...(view?.turns ?? [])], [older, view?.turns])
    const [olderCursor, setOlderCursor] = useState<string | null>(null)
    const [loadingOlder, setLoadingOlder] = useState(false)
    const [hasOlder, setHasOlder] = useState(false)
    const [atBottom, setAtBottom] = useState(true)
    const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([])
    const confirmedUserKeys = useRef(new Set<string>())
    const scroll = useRef<HTMLDivElement>(null)
    const composeWrap = useRef<HTMLDivElement>(null)
    const [composeHeight, setComposeHeight] = useState(0)
    const input = useRef<HTMLTextAreaElement>(null)
    const nearBottom = useRef(true)
    const preserveScroll = useRef<{ height: number; top: number } | null>(null)
    const current = useRef<View | null>(null)
    const refreshRef = useRef<(() => Promise<void>) | null>(null)
    const listRefreshRef = useRef<(() => Promise<void>) | null>(null)
    const mutation = useRef(false)
    const modelSettingsEpoch = useRef(0)
    const composing = useRef(false)
    const epoch = useRef(0)
    const readAbort = useRef<AbortController | null>(null)
    const invoke = useCallback(async <T,>(command: Record<string, unknown>, external?: AbortSignal) => {
        const read = ['read', 'list', 'projects', 'models', 'model-settings'].includes(String(command.op))
        const controller = new AbortController()
        const cancel = () => controller.abort()
        if (external?.aborted) controller.abort()
        else external?.addEventListener('abort', cancel, { once: true })
        const timer = setTimeout(() => controller.abort(), read ? 25000 : 75000)
        try {
            try { return await api.nativeDesktopCommand<T>(command, { signal: controller.signal }) }
            catch (error) {
                if (!read || controller.signal.aborted || !transientDesktopReadError(error)) throw error
                await new Promise(resolve => setTimeout(resolve, 300))
                if (controller.signal.aborted) throw error
                return await api.nativeDesktopCommand<T>(command, { signal: controller.signal })
            }
        }
        catch (error) {
            if (external?.aborted) throw abortedReadError()
            if (controller.signal.aborted) throw Error(read ? '读取超时，正在重新连接' : '提交结果暂未确认，请先查看原会话，避免重复发送')
            throw error
        } finally { clearTimeout(timer); external?.removeEventListener('abort', cancel) }
    }, [api])
    const call = useCallback(async <T,>(command: Record<string, unknown>, signal?: AbortSignal) => {
        const write = ['create', 'set-model', 'send', 'stop', 'respond', 'archive', 'pin'].includes(String(command.op))
        try {
            const response = await invoke<T>({ app, ...command }, signal)
            if (!response.ok) throw desktopError({ error: response.error || '桌面请求失败', delivery: response.delivery }, write)
            return response.result as T
        } catch (error) { throw desktopError(error, write) }
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
        let cancelled = false
        const pending = new Set<'codex' | 'claude'>()
        setError(''); setListError('')
        setListHealth({ key: listKey, connected: false })
        const refresh = async () => {
            await Promise.all((['codex', 'claude'] as const).map(async name => {
                if (pending.has(name)) return
                pending.add(name)
                try {
                    const response = await invoke<{ threads: Thread[] }>({ app: name, op: 'list' })
                    if (cancelled) return
                    if (!response.ok || !response.result) throw Error(response.error || '读取会话列表失败')
                    const entries = response.result.threads
                    observeRunning(name, entries.filter(entry => active(entry.status)).map(entry => entry.id))
                    threadLists.current.set(`${draftScope.key}:${name}`, entries)
                    let ended = false
                    for (const entry of entries) {
                        const key = `${name}:${entry.id}`, previous = previousStatuses.current.get(key)
                        if (active(previous) && settled(entry.status)) ended = true
                        if (statusName(entry.status) !== 'unknown') previousStatuses.current.set(key, entry.status)
                    }
                    if (ended && name !== app) setCompletion(value => ({ ...value, [name]: Date.now() }))
                    if (name === app) { setThreads(entries); setListError(''); setDesktopArchives(previous => previous.filter(entry => !entries.some(active => active.id === entry.id))); setListHealth({ key: listKey, connected: true }) }
                } catch (e) { if (!cancelled && name === app) { setListHealth({ key: listKey, connected: false }); if (!current.current) setListError(desktopError(e).message) } }
                finally { pending.delete(name) }
            }))
        }
        listRefreshRef.current = refresh
        const reconnect = () => { if (!document.hidden) void refresh() }
        document.addEventListener('visibilitychange', reconnect)
        window.addEventListener('online', reconnect)
        void refresh()
        const timer = setInterval(() => { if (!document.hidden) void refresh() }, 5000)
        return () => { cancelled = true; clearInterval(timer); listRefreshRef.current = null; document.removeEventListener('visibilitychange', reconnect); window.removeEventListener('online', reconnect) }
    }, [invoke, app, draftScope.key, listKey, observeRunning])
    useLayoutEffect(() => {
        setReadError('')
        setReadHealth({ key: conversationKey, connected: false })
        const generation = ++epoch.current
        if (!selected) { current.current = null; setView(null); return }
        let cancelled = false, pending = false
        let readFailures = 0
        const controller = new AbortController()
        readAbort.current = controller
        const cached = cachedViews.get(viewCacheKey)
        if (cached && cached.id !== selected) cachedViews.delete(viewCacheKey)
        const cachedView = cached && cached.id === selected ? cached : null
        let lastLiveAt = cachedView?.live ? Date.now() : null
        let fallbackAfterLive = false
        current.current = cachedView; setView(cachedView); setOlder([]); setOlderCursor(null); setLoadingOlder(false)
        setHasOlder(cachedView?.hasEarlier ?? false); nearBottom.current = true; setAtBottom(true)
        let timer: ReturnType<typeof setTimeout>
        const refresh = async () => {
            if (pending || cancelled) return
            clearTimeout(timer)
            pending = true
            const started = performance.now()
            const settingsEpoch = modelSettingsEpoch.current
            try {
                let result = await call<ReadResult>({ op: 'read', id: selected, since: current.current?.revision }, controller.signal)
                if (cancelled || generation !== epoch.current) return
                // A read for another identity is a semantic rejection, never a transient retry.
                if (result.id !== selected) throw identityMismatch()
                if (!('unchanged' in result)) {
                    if (result.live) { lastLiveAt = Date.now(); fallbackAfterLive = false }
                    else if (current.current?.live && lastLiveAt !== null) {
                        if (Date.now() - lastLiveAt < LIVE_RECOVERY_GRACE_MS) throw new ReadSourceRecoveryError()
                        fallbackAfterLive = true
                    }
                } else if (current.current?.live) lastLiveAt = Date.now()
                readFailures = 0
                setReadHealth(previous => previous.key === conversationKey && previous.connected === !fallbackAfterLive ? previous : { key: conversationKey, connected: !fallbackAfterLive })
                setReadError(fallbackAfterLive ? '实时连接暂不可用，正在显示备用历史；恢复后会自动接续。' : '')
                if (!('unchanged' in result)) {
                    // Keep the new messages, but an older request cannot undo a confirmed model change.
                    if (settingsEpoch !== modelSettingsEpoch.current && current.current?.id === result.id) result = { ...result, modelSettings: current.current.modelSettings }
                    const previous = current.current
                    if (!nearBottom.current && previous) {
                        const latestKeys = new Set(result.turns.flatMap(turn => turn.items.map(item => item.key)))
                        const displaced = previous.turns.map(turn => ({...turn,items:turn.items.filter(item => !latestKeys.has(item.key))})).filter(turn => turn.items.length)
                        if (displaced.length) setOlder(older => [...older,...displaced])
                    }
                    current.current = result
                    cacheView(viewCacheKey, result)
                    setView(result)
                }
            } catch (e) {
                if (!cancelled && generation === epoch.current) {
                    readFailures++
                    if (isIdentityMismatch(e) || e instanceof ReadSourceRecoveryError || readFailures >= 2 || !current.current) {
                        setReadHealth({ key: conversationKey, connected: false }); setReadError(e instanceof Error ? e.message : String(e))
                    }
                }
            }
            finally {
                pending = false
                if (!cancelled) {
                    const running = active(current.current?.status), elapsed = performance.now() - started
                    // A slow successful read already consumed the refresh interval.
                    // Keep requests serial and leave failed/idle reads on their normal backoff.
                    const delay = running && !readFailures && elapsed > 100 ? Math.max(150, 1200 - elapsed) : running ? 1200 : 3000
                    timer = setTimeout(() => { if (!document.hidden) void refresh() }, delay)
                }
            }
        }
        refreshRef.current = refresh
        const reconnect = () => { if (!document.hidden) void refresh() }
        document.addEventListener('visibilitychange', reconnect)
        window.addEventListener('online', reconnect)
        void refresh()
        return () => {
            cancelled = true
            controller.abort()
            clearTimeout(timer)
            if (readAbort.current === controller) readAbort.current = null
            refreshRef.current = null
            document.removeEventListener('visibilitychange', reconnect)
            window.removeEventListener('online', reconnect)
        }
    }, [app, call, selected, conversationKey, viewCacheKey])
    useEffect(() => { if (selected) setCreating(false); setManualLink(''); setPendingMessages([]); confirmedUserKeys.current = new Set(); setError('') }, [app, selected])
    useEffect(() => { setNewModel('') }, [creating, app])
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
        // The composer grows for attachments, long drafts and inline errors. When it does,
        // the scroll viewport shrinks; keep a reader who was at the bottom pinned there.
        observer?.observe(element)
        element.addEventListener('native-image-loaded', follow)
        return () => { observer?.disconnect(); element.removeEventListener('native-image-loaded', follow) }
    }, [selected, creating])
    useLayoutEffect(() => {
        const element = composeWrap.current
        if (!element) { setComposeHeight(0); return }
        const measure = () => setComposeHeight(element.offsetHeight)
        measure()
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
        observer?.observe(element)
        window.addEventListener('resize', measure)
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
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
            const result = await call<View>({ op: 'read', id: selected, before: cursor, complete: !view.historyComplete && !olderCursor && view.windowStart === 0 }, readAbort.current?.signal)
            if (generation !== epoch.current) return
            if (result.id !== selected) throw identityMismatch()
            if (scroll.current) preserveScroll.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop }
            setOlder(previous => [...result.turns, ...previous]); setOlderCursor(result.before); setHasOlder(result.hasEarlier)
        } catch (e) {
            // Aborting on switch/unmount is cleanup, not a user-visible read failure.
            if (generation === epoch.current && !(e instanceof Error && e.name === 'AbortError')) setError(e instanceof Error ? e.message : String(e))
        }
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
    const open = (id: string) => {
        if (mutation.current) return
        const entry = [...threads, ...desktopArchives].find(entry => entry.id === id)
        if (entry && settled(entry.status)) markRead(app, entry)
        select(app, id); setCreating(false); setError('')
    }
    const newChat = () => { if (mutation.current) return; select(app); setCreating(true); setError('') }
    const statusFor = (entry: Thread) => entry.id === selected && view?.id === selected ? view.status : entry.status
    const pendingFor = (entry: Thread) => {
        const selectedView = entry.id === selected && view?.id === selected ? view : null
        if (selectedView?.live && (Object.hasOwn(selectedView, 'pendingState') || selectedView.activeFlags !== undefined || typeof selectedView.status === 'object')) {
            const status = typeof selectedView.status === 'string' ? { type: selectedView.status, activeFlags: selectedView.activeFlags ?? [] } : selectedView.status
            return pendingStatus(status, selectedView.pendingState, selectedView.requests)
        }
        return pendingStatus(statusFor(entry), entry.pendingState, selectedView?.requests)
    }
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
    const allTurns = useMemo(() => {
        const turns: Turn[] = [], seen = new Set<string>()
        for (const turn of historyTurns) {
            const items = turn.items.filter(item => { if (seen.has(item.key)) return false; seen.add(item.key); return true })
            if (items.length) {
                const existing = turns.find(previous => previous.id === turn.id)
                if (existing) existing.items.push(...items)
                else turns.push({ ...turn, items })
            }
        }
        return turns
    }, [historyTurns])
    const latestTool = [...allTurns].reverse().flatMap(turn => [...turn.items].reverse()).find(item => item.role === 'tool')
    useEffect(() => {
        if (view?.id === selected && active(view.status)) observeRunning(app, [view.id])
        const entry = [...threads, ...desktopArchives].find(entry => entry.id === selected)
        if (entry && settled(entry.status) && view?.id === selected && settled(view.status) && connected && atBottom && !document.hidden) markRead(app, entry)
    }, [app, selected, threads, desktopArchives, view?.id, view?.status, view?.revision, connected, atBottom, markRead, observeRunning])
    return <div className="nd-root" data-open={!!selected || creating} data-jump={!atBottom && !!selected} style={{ '--nd-compose-height': `${composeHeight}px` } as CSSProperties}>
        <aside className="nd-side">
            <header className="nd-side-head"><span className="nd-home">{app === 'codex' ? 'Codex' : 'Claude Code'}</span><button className="nd-new" onClick={newChat} disabled={busy}>＋ 新聊天</button></header>
            <a className="nd-orchestra-entry" href="/desktop?app=codex&view=orchestra">任务总控 ↗</a>
            <div className="nd-side-title">桌面会话</div>
            <div className="nd-tabs">{(['codex', 'claude'] as const).map(name => <button aria-pressed={name === app} data-notify={!!completion[name]} key={name + (completion[name] ?? 0)} onAnimationEnd={() => setCompletion(value => ({ ...value, [name]: 0 }))} onClick={() => { if (busy) return; setCompletion(value => ({ ...value, [name]: 0 })); select(name); setCreating(false); setFilter(''); setShowArchived(false) }}>{name === 'codex' ? 'Codex' : 'Claude Code'}</button>)}</div>
            <div className="nd-search"><span>⌕</span><input aria-label="搜索桌面会话" placeholder="搜索会话" value={filter} onChange={e => setFilter(e.target.value)} /></div>
            <div className="nd-list">{visibleThreads.map((t, index) => <div className="nd-list-entry" key={t.id}>
                {(index === 0 || !showArchived && pinned(visibleThreads[index - 1]) !== pinned(t)) && <div className="nd-list-label">{showArchived ? '已归档' : pinned(t) ? '置顶' : '最近'}</div>}
                <div className="nd-thread-row"><button className="nd-thread" aria-current={t.id === selected ? 'true' : undefined} onClick={() => open(t.id)}><span className="nd-thread-title">{t.title || '未命名会话'}</span>{pendingFor(t) ? <span className="nd-thread-waiting" data-kind={pendingFor(t) === '等待审批' ? 'approval' : 'input'} role="img" aria-label={pendingFor(t)} title={pendingFor(t)}>{pendingFor(t)}</span> : active(statusFor(t)) || settled(statusFor(t)) && unread(app, t) ? <span className="nd-thread-indicator nd-dot" data-active={active(statusFor(t))} data-completed={settled(statusFor(t))} role="img" aria-label={active(statusFor(t)) ? '任务运行中' : '已完成，未查看'} title={active(statusFor(t)) ? '任务运行中' : '已完成，未查看'}></span> : pinned(t) && <span className="nd-thread-pinned" aria-label="已置顶">↟</span>}</button>
                    <ThreadActions title={t.title} pinned={pinned(t)} archived={isArchived(t.id)} disabled={busy} onPin={() => void togglePin(t)} onCopy={() => void copyLink(t.id)} onArchive={() => void toggleArchive(t)} />
                </div>
            </div>)}{showArchived && archiveCursor && <button className="nd-text-btn" disabled={loadingArchives} onClick={() => void loadDesktopArchives(archiveCursor)}>{loadingArchives ? '读取中…' : '更多桌面归档'}</button>}{!visibleThreads.length && <div className="nd-empty">{filter ? '没有匹配的会话' : showArchived ? loadingArchives ? '读取桌面归档…' : '还没有归档的会话' : connected ? '还没有桌面会话' : '正在连接…'}</div>}</div>
            <button type="button" className="nd-archive-toggle" aria-pressed={showArchived} title="查看桌面原会话归档" onClick={() => { setShowArchived(value => !value); setFilter('') }}><span>{showArchived ? '‹ 返回最近' : '▤ 已归档'}</span>{!showArchived && desktopArchives.length > 0 && <small>{desktopArchives.length}</small>}</button>
            {!selected && !creating && visibleError && <div className="nd-error" role="alert">{visibleError}{(!connected || readError || listError) && <button className="nd-text-btn" onClick={reconnect}>重新连接</button>}</div>}
        </aside>
        <main className="nd-main">
            <header className="nd-head"><button className="nd-mobile-back nd-icon-btn" onClick={() => { if (!busy) { select(app); setCreating(false) } }} aria-label="返回列表">‹</button><div className="nd-title"><strong>{creating ? `新建 ${app === 'codex' ? 'Codex' : 'Claude Code'} 会话` : title}</strong>{selected && (!connected || attentionText(view?.status)) && <div className="nd-status" role="status">{connected ? attentionText(view?.status) : '连接中断，正在重连'}</div>}</div>{view && <AgentActivity delegations={view.delegations} />}{selected && <button type="button" className="nd-copy-link" aria-label="复制链接" title="复制链接" onClick={() => void copyLink(selected)}><CopyLinkIcon /></button>}{selected && (active(view?.status) || app === 'claude' && statusName(view?.status) === 'unknown') && <button className="nd-stop" disabled={busy || !connected} title="停止原 App 中此会话的当前轮" onClick={() => void act('stop')}>■ 停止</button>}</header>
            {selectedThread && isArchived(selectedThread.id) && <div className="nd-archived-notice">已同步桌面归档<button type="button" disabled={busy} onClick={() => void toggleArchive(selectedThread)}>恢复到最近</button></div>}
            <div className="nd-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) { const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100; nearBottom.current = bottom; setAtBottom(bottom) } }}><div className="nd-content">
                {selected && !view && <div className="nd-loading"><div /><div /><div /><p>读取最近的消息…</p></div>}
                {!selected && <div className="nd-welcome"><span className={`nd-avatar nd-avatar-${app}`}><AppBrandIcon app={app} /></span><h2>{creating ? '开始新的对话' : '接着聊，接着做'}</h2><p>{creating ? '发出第一条消息后，会话也会出现在桌面 App 中。' : '选择左侧会话，继续桌面上的工作。'}</p></div>}
                {view && hasOlder && <div className="nd-history-more"><button onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? '正在读取…' : '↑ 更早的消息'}</button></div>}
                {selected && <ConversationHistory turns={allTurns} call={call} id={selected} app={app} />}
                {view && active(view.status) && <div className="nd-live-activity" role="status" aria-label="任务运行中"><i /><span>{latestTool?.text ? `最近工具 · ${latestTool.text.slice(0, 90)}` : app === 'codex' ? 'Codex' : 'Claude Code'}</span></div>}
                {pendingMessages.map(message => <article key={message.id} className="nd-message nd-user nd-pending">{message.text && <div className="nd-user-text">{message.text}</div>}{message.images.length > 0 && <div className="nd-message-images">{message.images.map((image, index) => <InlineImage key={index} src={image.data} alt={image.name} />)}</div>}<span className="nd-subtle">{message.sending ? '发送中…' : message.queued ? '已排队，等待接续' : '已发送，等待同步'}</span></article>)}
                {view?.requests.map((request, index) => <PendingRequest key={`${app}:${selected}:${request.id ?? request.requestId ?? index}`} request={request} disabled={busy} respond={value => void act('respond', value)} />)}
            </div></div>
            {!atBottom && selected && <button className="nd-jump" onClick={() => { nearBottom.current = true; setAtBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }) }}>↓ 最新消息</button>}
            {visibleError && (selected || creating) && <div className="nd-error" role="alert">{visibleError}{(!connected || readError || listError) && <button className="nd-text-btn" onClick={reconnect}>重新连接</button>}</div>}
            {manualLink && <div className="nd-copy-fallback"><label>会话链接<input aria-label="会话链接" readOnly value={manualLink} onFocus={e => e.currentTarget.select()} autoFocus /></label><button type="button" aria-label="关闭链接" onClick={() => setManualLink('')}>×</button></div>}
            {(selected || creating) && <div className="nd-compose-wrap" ref={composeWrap}><form className="nd-compose" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void addImages(Array.from(e.dataTransfer.files)) } }} onSubmit={e => { e.preventDefault(); sendDraft() }}><input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label="选择图片" onChange={e => { void addImages(Array.from(e.target.files ?? [])); e.target.value = '' }} />{images.length > 0 && <div className="nd-attachment-previews">{images.map((image, index) => <div key={index}><img src={image.data} alt={image.name} /><button type="button" aria-label={`移除图片 ${index + 1}`} disabled={busy} onClick={() => setImages(value => value.filter((_, i) => i !== index))}>×</button></div>)}</div>}<textarea ref={input} aria-label="消息" rows={2} placeholder="问点什么，或继续这项工作…" value={draft} disabled={busy} onPaste={e => { const files = Array.from(e.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).flatMap(item => { const file = item.getAsFile(); return file ? [file] : [] }); if (files.length) { e.preventDefault(); void addImages(files) } }} onChange={e => setDraft(e.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current && e.keyCode !== 229) { e.preventDefault(); sendDraft() } }} /><div className="nd-compose-footer"><div className="nd-compose-left"><button type="button" className="nd-attach" aria-label="添加图片" title="选择图片，也可粘贴或拖入" disabled={busy || preparingImages || images.length >= 4} onClick={() => imageInput.current?.click()}>{preparingImages ? '…' : '＋'}</button><span className="nd-compose-app">{app === 'codex' ? (creating || view?.id === selected ? <ModelPicker key={conversationKey} id={selected ?? undefined} creating={creating} historyOnly={view?.id === selected && !view.live} settings={view?.id === selected ? view.modelSettings : undefined} value={newModel} onChange={setNewModel} call={call} disabled={busy} onUpdating={updating => { mutation.current = updating; setBusy(updating) }} onUpdated={settings => {
                    const previous = current.current
                    if (previous?.id === selected) {
                        modelSettingsEpoch.current++
                        const next = { ...previous, modelSettings: settings }
                        current.current = next; cacheView(viewCacheKey, next); setView(next)
                    }
                    void refreshRef.current?.()
                }} /> : <span>Codex</span>) : creating ? <span title="使用 Claude 桌面的默认模型">Claude Code · 桌面默认</span> : 'Claude Code'}</span></div><div className="nd-compose-controls"><span>Shift + Enter 换行</span><button type="submit" aria-label="发送消息" disabled={busy || preparingImages || !connected || (!draft.trim() && !images.length)}>{busy ? '···' : '↑'}</button></div></div></form></div>}
        </main>
        {notice && <div className="nd-toast" role="status">{notice}</div>}
    </div>
}
