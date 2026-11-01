import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import './OrchestraBoard.css'

const BACK_HREF = '/desktop?app=codex&thread=01a19339-39e6-7081-8920-82db9992402a'
const SNAPSHOT_PATH = '/api/orchestra/snapshot'
const POLL_MS = 5000
const REQUEST_TIMEOUT_MS = 4000
const STALE_AFTER_MS = 30_000
const EXTERNAL_HISTORY_LABEL = '11月1日13:27历史快照 未接管'

export type OrchestraExecution = 'queued' | 'running' | 'reported' | 'failed' | 'interrupted' | 'unknown' | 'blocked'
export type OrchestraReview = 'pending' | 'awaiting' | 'accepted' | 'rejected'
export type OrchestraArchive = 'none' | 'pending' | 'archived' | 'unknown'

export type OrchestraCollector = {
    connected?: boolean
    stale?: boolean
    lastSuccessAt?: string | null
    lastObservedAt?: string | null
    error?: string | null
}

export type OrchestraTask = {
    id: string
    title: string
    goal: string
    deliverables: string[]
    acceptance: string[]
    ownership: string[]
    authorization: string
    threadId: string | null
    host: string
    createdAt: string
    checkpoint: string
    expectedAt: string | null
    execution: OrchestraExecution
    review: OrchestraReview
    archive: OrchestraArchive
    observedAt: string | null
    sourceAt: string | null
    progress: string
    latestAction: string
    evidence: string[]
    stale: boolean
    attention: boolean
    external: boolean
}

export type OrchestraSnapshot = {
    version: 1
    generatedAt: string
    controllerThreadId: string
    collector: OrchestraCollector
    tasks: OrchestraTask[]
    notices?: unknown[]
    operations?: unknown[]
}

type FilterKey = 'all' | 'attention' | 'queued' | 'running' | 'awaiting' | 'archived'

const EXECUTION_LABELS: Record<string, string> = {
    queued: '排队中',
    running: '运行中',
    reported: '已回报',
    failed: '失败',
    interrupted: '已中断',
    unknown: '未知',
    blocked: '已阻塞'
}
const REVIEW_LABELS: Record<string, string> = {
    pending: '未开始验收',
    awaiting: '待验收',
    accepted: '已验收',
    rejected: '已退回'
}
const ARCHIVE_LABELS: Record<string, string> = {
    none: '未归档',
    pending: '归档中',
    archived: '已归档',
    unknown: '未知'
}
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
})

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function textList(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
}

function timestampMs(value: unknown): number | null {
    const raw = text(value)
    if (!raw) return null
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : null
}

function formatTime(value: unknown): string {
    const parsed = timestampMs(value)
    return parsed === null ? '' : timeFormat.format(new Date(parsed))
}

function formatAge(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '刚刚'
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds} 秒前`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes} 分钟前`
    return `${Math.floor(minutes / 60)} 小时前`
}

function statusLabel(labels: Record<string, string>, value: unknown): string {
    const key = text(value)
    return labels[key] ?? '未知'
}

function isSnapshot(value: unknown): value is OrchestraSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as { version?: unknown; tasks?: unknown }
    return record.version === 1 && Array.isArray(record.tasks)
}

function snapshotUrl(baseUrl: string): string {
    try {
        return new URL(SNAPSHOT_PATH, baseUrl).toString()
    } catch {
        return SNAPSHOT_PATH
    }
}

function isAttention(task: OrchestraTask): boolean {
    return task.attention === true || task.execution === 'blocked' || task.execution === 'failed' || task.review === 'awaiting'
}

function attentionRank(task: OrchestraTask): number {
    if (task.review === 'awaiting') return 0
    if (task.execution === 'blocked') return 1
    if (task.execution === 'failed') return 2
    return 3
}

function byAttentionThenAge(left: OrchestraTask, right: OrchestraTask): number {
    const attention = Number(isAttention(right)) - Number(isAttention(left))
    if (attention !== 0) return attention
    if (isAttention(left) && isAttention(right)) {
        const rank = attentionRank(left) - attentionRank(right)
        if (rank !== 0) return rank
    }
    const created = (timestampMs(left.createdAt) ?? Number.MAX_SAFE_INTEGER) - (timestampMs(right.createdAt) ?? Number.MAX_SAFE_INTEGER)
    if (created !== 0) return created
    return text(left.id).localeCompare(text(right.id))
}

function matchesFilter(task: OrchestraTask, filter: FilterKey): boolean {
    if (filter === 'attention') return isAttention(task)
    if (filter === 'queued') return task.execution === 'queued'
    if (filter === 'running') return task.execution === 'running'
    if (filter === 'awaiting') return task.review === 'awaiting'
    if (filter === 'archived') return task.archive === 'archived'
    return true
}

function noticeText(value: unknown): string {
    if (typeof value === 'string') return value.trim()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
    const record = value as Record<string, unknown>
    return text(record.message) || text(record.text)
}

function StatusPill({ kind, label, value, labels }: { kind: string; label: string; value: unknown; labels: Record<string, string> }) {
    return <span className="ob-pill" data-kind={kind} data-value={text(value) || 'unknown'}>{label} · {statusLabel(labels, value)}</span>
}

function DetailList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
    return <details className="ob-details">
        <summary>{title}<span className="ob-count">{items.length}</span></summary>
        <div className="ob-details-body">
            {items.length > 0 ? <ul>{items.map((item, index) => <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>)}</ul> : <p>{empty}</p>}
        </div>
    </details>
}

function TaskCard({ task, forceStale = false, external = false }: { task: OrchestraTask; forceStale?: boolean; external?: boolean }) {
    const title = text(task.title) || '未命名任务'
    const taskId = text(task.id)
    const threadId = text(task.threadId)
    const progress = text(task.progress)
    const latestAction = text(task.latestAction)
    const checkpoint = text(task.checkpoint)
    const expectedAt = formatTime(task.expectedAt)
    const observedAt = formatTime(task.observedAt)
    const sourceAt = formatTime(task.sourceAt)
    const authorization = text(task.authorization)
    const stale = forceStale || task.stale === true
    const attention = isAttention(task)
    const deliverables = textList(task.deliverables)
    const acceptance = textList(task.acceptance)
    const ownership = textList(task.ownership)
    const evidence = textList(task.evidence)
    return <article className="ob-card" data-attention={attention ? 'true' : undefined} data-stale={stale ? 'true' : undefined} data-external={external ? 'true' : undefined}>
        <header className="ob-card-head">
            <div className="ob-card-title">
                <div className="ob-card-meta">
                    {taskId && <span className="ob-id">{taskId}</span>}
                    {attention && <span className="ob-flag" data-tone="attention">需处理</span>}
                    {stale && <span className="ob-flag" data-tone="stale">{external ? '历史快照 · 未接管' : '数据过期'}</span>}
                </div>
                <h2>{title}</h2>
            </div>
            <div className="ob-links">
                {threadId ? <a href={`/desktop?app=codex&thread=${encodeURIComponent(threadId)}`}>{external ? '原对话（未接管）' : '工作对话'}</a>
                        : <span>未关联工作对话</span>}
            </div>
        </header>
        <div className="ob-pills" aria-label="任务状态">
            <StatusPill kind="execution" label="执行" value={task.execution} labels={EXECUTION_LABELS} />
            <StatusPill kind="review" label="验收" value={task.review} labels={REVIEW_LABELS} />
            <StatusPill kind="archive" label="归档" value={task.archive} labels={ARCHIVE_LABELS} />
        </div>
        <p className="ob-progress">{progress || '暂无公开进展'}</p>
        {latestAction && <p className="ob-action"><span>最新动作</span>{latestAction}</p>}
        <dl className="ob-times">
            <div><dt>检查点</dt><dd>{checkpoint || '未设置'}</dd></div>
            <div><dt>预计交付</dt><dd>{expectedAt || '未设定'}</dd></div>
            <div><dt>观测时间</dt><dd>{observedAt || '未观测'}</dd></div>
            <div><dt>来源时间</dt><dd>{sourceAt || '来源未知'}</dd></div>
        </dl>
        <details className="ob-details">
            <summary>目标与授权</summary>
            <div className="ob-details-body">
                <p>{text(task.goal) || '未记录目标'}</p>
                {authorization && <p className="ob-authorization"><strong>授权：</strong>{authorization}</p>}
            </div>
        </details>
        <DetailList title="交付物" items={deliverables} empty="暂无交付物" />
        <DetailList title="验收标准" items={acceptance} empty="暂无验收标准" />
        <DetailList title="所有权" items={ownership} empty="暂无所有权记录" />
        <DetailList title="证据" items={evidence} empty="暂无证据" />
    </article>
}

export function OrchestraBoard() {
    const { token, baseUrl } = useAppContext()
    const [snapshot, setSnapshot] = useState<OrchestraSnapshot | null>(null)
    const [connection, setConnection] = useState<'loading' | 'online' | 'offline'>('loading')
    const [receivedAt, setReceivedAt] = useState<number | null>(null)
    const [filter, setFilter] = useState<FilterKey>('all')
    const mountedRef = useRef(false)
    const inFlightRef = useRef(false)
    const abortRef = useRef<AbortController | null>(null)
    const generationRef = useRef(0)

    const load = useCallback(async () => {
        if (!mountedRef.current || inFlightRef.current) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        inFlightRef.current = true
        const generation = ++generationRef.current
        const controller = new AbortController()
        abortRef.current = controller
        const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const response = await fetch(snapshotUrl(baseUrl), {
                method: 'GET',
                headers: { accept: 'application/json', authorization: `Bearer ${token}` },
                cache: 'no-store',
                signal: controller.signal
            })
            if (!response.ok) throw Error('Orchestra snapshot request failed')
            const value: unknown = await response.json()
            if (!isSnapshot(value)) throw Error('Orchestra snapshot response is invalid')
            if (!mountedRef.current || generation !== generationRef.current) return
            setSnapshot(value)
            setReceivedAt(Date.now())
            setConnection('online')
        } catch {
            if (!mountedRef.current || generation !== generationRef.current) return
            setConnection('offline')
        } finally {
            window.clearTimeout(timer)
            if (abortRef.current === controller) abortRef.current = null
            if (generation === generationRef.current) inFlightRef.current = false
        }
    }, [baseUrl, token])

    useEffect(() => {
        mountedRef.current = true
        const tick = () => {
            if (document.visibilityState === 'visible') void load()
        }
        tick()
        const interval = window.setInterval(tick, POLL_MS)
        const onVisibility = () => {
            if (document.visibilityState === 'visible') void load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
            mountedRef.current = false
            generationRef.current += 1
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', onVisibility)
            abortRef.current?.abort()
            abortRef.current = null
            inFlightRef.current = false
        }
    }, [load])

    const allTasks = useMemo(() => (snapshot?.tasks ?? []).filter((task): task is OrchestraTask => !!task && typeof task === 'object' && !Array.isArray(task)), [snapshot])
    const managedTasks = useMemo(() => allTasks.filter(task => task.external !== true).sort(byAttentionThenAge), [allTasks])
    const externalTasks = useMemo(() => allTasks.filter(task => task.external === true), [allTasks])
    const counts = useMemo(() => ({
        attention: managedTasks.filter(isAttention).length,
        queued: managedTasks.filter(task => task.execution === 'queued').length,
        running: managedTasks.filter(task => task.execution === 'running').length,
        awaiting: managedTasks.filter(task => task.review === 'awaiting').length,
        archived: managedTasks.filter(task => task.archive === 'archived').length
    }), [managedTasks])
    const visibleTasks = useMemo(() => managedTasks.filter(task => matchesFilter(task, filter)), [managedTasks, filter])
    const notices = useMemo(() => (snapshot?.notices ?? []).map(noticeText).filter(Boolean).slice(0, 5), [snapshot])

    const collector = snapshot?.collector
    const generatedAtMs = timestampMs(snapshot?.generatedAt)
    const generatedLate = generatedAtMs !== null && receivedAt !== null && receivedAt - generatedAtMs > STALE_AFTER_MS
    const staleReason = collector?.connected === false ? '采集器未连接'
        : collector?.stale === true ? '采集器报告数据已过期'
            : generatedLate ? '当前快照生成时间较早，可能已过期'
                : ''
    const stale = connection === 'offline' || staleReason.length > 0
    const lastSuccess = receivedAt === null ? '' : formatTime(new Date(receivedAt).toISOString())
    const connectionLabel = connection === 'loading' ? '正在连接采集器'
        : connection === 'offline' ? '采集器已断开'
            : stale ? '快照可能已过期' : '采集器已连接'
    const filters: { key: FilterKey; label: string; count: number }[] = [
        { key: 'all', label: '全部', count: managedTasks.length },
        { key: 'attention', label: '需处理', count: counts.attention },
        { key: 'queued', label: '排队', count: counts.queued },
        { key: 'running', label: '运行中', count: counts.running },
        { key: 'awaiting', label: '待验收', count: counts.awaiting },
        { key: 'archived', label: '已归档', count: counts.archived }
    ]

    return <div className="ob-root">
        <div className="ob-shell">
            <header className="ob-head">
                <a className="ob-back" href={BACK_HREF}>← 返回总控对话</a>
                <div className="ob-title-row">
                    <div className="ob-title-copy">
                        <h1>任务总控</h1>
                        <p className="ob-subtitle">只读视图 · 队列、进展、工作对话与交付</p>
                    </div>
                    <span className="ob-connection" data-state={connection} role="status" aria-live="polite">
                        <span className="ob-dot" aria-hidden="true" />{connectionLabel}
                    </span>
                </div>
                {lastSuccess && <p className="ob-last-success">上次成功读取：{lastSuccess}</p>}
            </header>

            {snapshot && stale && <div className="ob-banner" data-tone={connection === 'offline' ? 'offline' : 'stale'} role="status">
                <strong>{connection === 'offline' ? '采集器已断开' : '数据可能已过期'}</strong>
                <span>{connection === 'offline' ? '显示上次成功快照，实时状态暂停更新。' : staleReason}</span>
                {lastSuccess && <span>上次成功：{lastSuccess}</span>}
            </div>}

            {notices.length > 0 && <section className="ob-notices" aria-label="采集器提示">
                <ul>{notices.map((notice, index) => <li key={`${index}-${notice.slice(0, 24)}`}>{notice}</li>)}</ul>
            </section>}

            {!snapshot && connection === 'loading' && <div className="ob-loading" role="status" aria-busy="true">
                <p>正在读取任务总控…</p>
                <span>只读快照，不会修改任何任务。</span>
            </div>}

            {!snapshot && connection === 'offline' && <div className="ob-error" role="alert">
                <strong>任务总控数据暂时不可用</strong>
                <p>采集器未连接。看板不会用空数据覆盖真实状态。</p>
                <button type="button" onClick={() => { setConnection('loading'); void load() }}>重试</button>
            </div>}

            {snapshot && <>
                <nav className="ob-filters" aria-label="任务筛选">
                    {filters.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
                        {item.label}<span>{item.count}</span>
                    </button>)}
                </nav>
                {visibleTasks.length > 0
                    ? <div className="ob-list">{visibleTasks.map(task => <TaskCard key={text(task.id) || text(task.title)} task={task} forceStale={connection === 'offline'} />)}</div>
                    : <p className="ob-empty">{managedTasks.length === 0 ? '当前没有已接管的任务。' : '当前筛选下没有任务。'}</p>}
                {externalTasks.length > 0 && <section className="ob-external" aria-label={EXTERNAL_HISTORY_LABEL}>
                    <h2>{EXTERNAL_HISTORY_LABEL}</h2>
                    <p>外部导入，仅供只读追溯；不进入当前队列，始终按过期处理。</p>
                    <div className="ob-list">{externalTasks.map(task => <TaskCard key={text(task.id) || text(task.title)} task={task} forceStale external />)}</div>
                </section>}
            </>}
        </div>
    </div>
}

export default OrchestraBoard
