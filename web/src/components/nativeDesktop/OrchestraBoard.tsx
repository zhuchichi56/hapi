import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppContext } from '@/lib/app-context'
import './OrchestraBoard.css'

const BACK_HREF = '/desktop?app=codex&thread=01a19339-39e6-7081-8920-82db9992402a'
const SNAPSHOT_PATH = '/api/orchestra/snapshot'
const ARTIFACT_PATH = '/api/orchestra/artifact'
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
    brief?: string
    briefAsOf?: string
    sessions?: { sessionId: string; threadId: string | null; role: string; execution: OrchestraExecution; review: OrchestraReview; responsibilityStatus: string; isMain: boolean; observedAt?: string | null }[]
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
    pendingTaskCount?: number
    runningSessionCount?: number
    workSessionTarget?: number
}

type FilterKey = 'all' | 'attention' | 'queued' | 'running' | 'awaiting' | 'archived'
type Selection = { id: string; nonce: number }
type ArtifactState = {
    status: 'idle' | 'loading' | 'ready' | 'error'
    taskId?: string
    index?: number
    name?: string
    content?: string
}

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

function artifactUrl(baseUrl: string, taskId: string, index: number): string {
    try {
        const url = new URL(ARTIFACT_PATH, baseUrl)
        url.searchParams.set('task', taskId)
        url.searchParams.set('index', String(index))
        return url.toString()
    } catch {
        return `${ARTIFACT_PATH}?task=${encodeURIComponent(taskId)}&index=${index}`
    }
}

function isHistoricalSettled(task: OrchestraTask): boolean {
    return task.archive === 'archived' && task.review === 'accepted'
}

function mergedStatus(task: OrchestraTask): { label: string; tone: string } {
    if (task.sessions?.some(session => !session.isMain && session.responsibilityStatus !== 'ended' && session.execution === 'running')) return { label: '进行中', tone: 'running' }
    if (task.review === 'awaiting') return { label: '待验收', tone: 'awaiting' }
    if (task.execution === 'blocked' || task.execution === 'failed' || task.execution === 'interrupted') return { label: '需处理', tone: 'attention' }
    if (task.execution === 'running') return { label: '进行中', tone: 'running' }
    if (task.execution === 'queued') return { label: task.threadId ? '排队中' : '未派发', tone: 'queued' }
    if (task.review === 'accepted') return { label: '已完成', tone: 'done' }
    if (task.archive === 'archived') return { label: '已归档', tone: 'muted' }
    if (task.execution === 'reported') return { label: '已回报', tone: 'reported' }
    return { label: '待核实', tone: 'muted' }
}

function taskBrief(task: OrchestraTask): string {
    if (text(task.brief)) return text(task.brief)
    if (task.execution === 'queued' && !task.threadId) return '尚未派发。'
    const candidates = isHistoricalSettled(task)
        ? [...textList(task.evidence), task.progress]
        : [task.progress]
    for (const candidate of candidates) {
        const summary = publicProgress(candidate).summary
        if (summary && !/^(?:暂无自然语言|未记录|读取任务|导入快照|只读历史快照|mtime|snapshot)/i.test(summary)) return summary
    }
    return '等待工作对话更新。'
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

function chunkTasks(tasks: OrchestraTask[]): OrchestraTask[][] {
    const rows: OrchestraTask[][] = []
    for (let index = 0; index < tasks.length; index += 2) rows.push(tasks.slice(index, index + 2))
    return rows
}

function StatusPill({ kind, label, value, labels }: { kind: string; label: string; value: unknown; labels: Record<string, string> }) {
    return <span className="ob-pill" data-kind={kind} data-value={text(value) || 'unknown'}>{label} · {statusLabel(labels, value)}</span>
}

function DetailSection({ title, count, children, open = false }: { title: string; count?: number; children: ReactNode; open?: boolean }) {
    return <details className="ob-detail-section" open={open}>
        <summary>{title}{count !== undefined && <span className="ob-count">{count}</span>}</summary>
        <div className="ob-detail-body">{children}</div>
    </details>
}

function ListBlock({ items, empty }: { items: string[]; empty: string }) {
    return items.length > 0 ? <ul>{items.map((item, index) => <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>)}</ul> : <p>{empty}</p>
}

export function publicProgress(value: unknown): { summary: string; detail: string } {
    const detail = text(value)
        .replace(/::[a-z][a-z0-9-]*\{[^}]*\}/gi, '')
        .replace(/::[a-z][a-z0-9-]*[^\n]*$/gim, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/\*\*|__/g, '')
        .trim()
    const prose = detail.split(/\n+/).map(line => line.replace(/^\s*[-*]\s+/, '').trim())
        .filter(line => line && !/^(?:diff |@@|[+-]{3}|[|]|(?:tool|assistant):|(?:Files? Changed|文件(?:变更|差异))[:：]|(?:mtime|snapshot)|(?:文件)?修改时间)/i.test(line))
        .filter(line => !/^(?:`?[/~]|[\w.-]+\.(?:tsx?|jsx?|py|json|md|css)(?:`|\s|$))/.test(line))
    const first = prose[0] || '暂无自然语言公开摘要，请查看任务目标与进展详情。'
    return { summary: first.length > 220 ? first.slice(0, 220) + '…' : first, detail }
}

function TreeTaskNode({ task, selected, onSelect }: {
    task: OrchestraTask
    selected: boolean
    onSelect: (task: OrchestraTask, trigger: HTMLElement) => void
}) {
    const title = text(task.title) || '未命名任务'
    const taskId = text(task.id)
    const status = mergedStatus(task)
    const attention = isAttention(task)
    return <button
        type="button"
        className="ob-node"
        data-testid="ob-tree-node"
        data-task-id={taskId || undefined}
        data-execution={task.execution}
        data-review={task.review}
        data-attention={attention ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        aria-pressed={selected}
        onClick={event => onSelect(task, event.currentTarget)}
    >
        <span className="ob-node-top">
            <span className="ob-node-dot" aria-hidden="true" />
            <span className="ob-node-title">{title}</span>
            <span className="ob-status" data-tone={status.tone}>{status.label}</span>
        </span>
        <span className="ob-node-progress">{taskBrief(task)}</span>
    </button>
}

function ExternalTaskCard({ task }: { task: OrchestraTask }) {
    const title = text(task.title) || '未命名任务'
    const taskId = text(task.id)
    const threadId = text(task.threadId)
    const progress = publicProgress(task.progress)
    const observedAt = formatTime(task.observedAt)
    const deliverables = textList(task.deliverables)
    const acceptance = textList(task.acceptance)
    const evidence = textList(task.evidence)
    return <article className="ob-card" data-testid="ob-external-card" data-stale="true" data-external="true">
        <header className="ob-card-head">
            <div className="ob-card-title">
                <div className="ob-card-meta">
                    {taskId && <span className="ob-id">{taskId}</span>}
                    <span className="ob-flag" data-tone="stale">历史快照 · 未接管</span>
                </div>
                <h3>{title}</h3>
            </div>
        </header>
        <div className="ob-pills" aria-label="历史任务状态">
            <StatusPill kind="execution" label="执行" value={task.execution} labels={EXECUTION_LABELS} />
            <StatusPill kind="review" label="验收" value={task.review} labels={REVIEW_LABELS} />
            <StatusPill kind="archive" label="归档" value={task.archive} labels={ARCHIVE_LABELS} />
        </div>
        <p className="ob-progress">{progress.summary}</p>
        <details className="ob-details">
            <summary>历史只读内容<span className="ob-count">{deliverables.length + acceptance.length + evidence.length}</span></summary>
            <div className="ob-details-body">
                <p><strong>目标：</strong>{text(task.goal) || '未记录目标'}</p>
                <p><strong>交付：</strong>{deliverables.join('；') || '暂无'}</p>
                <p><strong>验收：</strong>{acceptance.join('；') || '暂无'}</p>
                <p><strong>证据：</strong>{evidence.join('；') || '暂无'}</p>
                {observedAt && <p><strong>观测：</strong>{observedAt}</p>}
            </div>
        </details>
        <div className="ob-links">
            {threadId ? <a href={`/desktop?app=codex&thread=${encodeURIComponent(threadId)}`}>原对话（未接管）</a>
                : <span>未关联工作对话</span>}
        </div>
    </article>
}

function safeUrl(value: string): string | null {
    if (!/^(?:https?:|mailto:|tel:)/i.test(value)) return null
    try {
        const url = new URL(value)
        return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ? value : null
    } catch {
        return null
    }
}

function ArtifactResult({ task, state, onLoad }: {
    task: OrchestraTask
    state: ArtifactState
    onLoad: (task: OrchestraTask, index: number) => void
}) {
    if (state.status === 'idle' || state.taskId !== text(task.id)) return null
    if (state.status === 'loading') return <div className="ob-result" data-testid="ob-result" role="status">正在读取成果…</div>
    if (state.status === 'error' || !state.content) return <div className="ob-result" data-testid="ob-result" role="status">
        <p>成果暂不可用。</p>
        <p className="ob-result-hint">可先打开原工作对话继续查看。</p>
    </div>
    return <div className="ob-result" data-testid="ob-result">
        {state.name && <p className="ob-result-name">{state.name}</p>}
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
                a: ({ href, children }) => {
                    const safe = safeUrl(href ?? '')
                    if (safe) return <a href={safe} target="_blank" rel="noreferrer">{children}</a>
                    return <span title="附件请从原工作对话查看">{children}</span>
                }
            }}
        >{state.content}</ReactMarkdown>
    </div>
}

function TaskDetail({ task, stale, artifact, onLoadArtifact, onClose, detailRef }: {
    task: OrchestraTask
    stale: boolean
    artifact: ArtifactState
    onLoadArtifact: (task: OrchestraTask, index: number) => void
    onClose: () => void
    detailRef: RefObject<HTMLElement | null>
}) {
    const title = text(task.title) || '未命名任务'
    const taskId = text(task.id)
    const threadId = text(task.threadId)
    const status = mergedStatus(task)
    const brief = taskBrief(task)
    const attention = isAttention(task)
    const showStale = stale && !isHistoricalSettled(task)
    const checkpoint = text(task.checkpoint)
    const expectedAt = formatTime(task.expectedAt)
    const observedAt = formatTime(task.observedAt)
    const sourceAt = formatTime(task.sourceAt)
    const authorization = text(task.authorization)
    const goal = text(task.goal)
    const host = text(task.host)
    const deliverables = textList(task.deliverables)
    const acceptance = textList(task.acceptance)
    const ownership = textList(task.ownership)
    const evidence = textList(task.evidence)
    const progress = publicProgress(task.progress)
    const latestAction = publicProgress(task.latestAction).detail
    return <section
        ref={detailRef}
        className="ob-detail ob-mini"
        data-testid="ob-detail"
        data-task-id={taskId || undefined}
        data-attention={attention ? 'true' : undefined}
        aria-labelledby="ob-detail-title"
    >
        <header className="ob-detail-head">
            <div className="ob-detail-heading">
                <h2 id="ob-detail-title">{title}</h2>
                <span className="ob-status" data-tone={status.tone}>{status.label}</span>
            </div>
            <button type="button" className="ob-detail-close" aria-label="关闭任务详情" onClick={onClose}>×</button>
        </header>
        {showStale && <p className="ob-detail-stale" role="status">观测数据已过期，以下为上次快照。</p>}
        <p className="ob-mini-brief">{brief}</p>
        <div className="ob-task-actions">
            <button type="button" className="ob-primary" onClick={() => onLoadArtifact(task, 0)}>查看成果</button>
            {threadId ? <a className="ob-secondary" href={`/desktop?app=codex&thread=${encodeURIComponent(threadId)}`}>原工作对话</a>
                : <span className="ob-secondary">未关联工作对话</span>}
        </div>
        <ArtifactResult task={task} state={artifact} onLoad={onLoadArtifact} />
        <details className="ob-record" data-testid="ob-record">
            <summary>任务记录</summary>
            <div className="ob-record-body">
                <p><strong>目标：</strong>{goal || '未记录目标'}</p>
                <p><strong>授权：</strong>{authorization || '未记录授权'}</p>
                <p><strong>检查点：</strong>{checkpoint || '未设置'}</p>
                <p><strong>交付：</strong></p>
                {deliverables.length > 0 ? <ul>{deliverables.map((entry, index) => <li key={index}><button type="button" className="ob-link-button" onClick={() => onLoadArtifact(task, index)}>{entry.match(/\[([^\]]+)\]/)?.[1] || entry.split('/').pop()}</button></li>)}</ul> : <p>暂无</p>}
                <p><strong>验收：</strong>{acceptance.join('；') || '暂无'}</p>
                <p><strong>完整进展：</strong>{progress.detail || '暂无'}</p>
                {latestAction && <p><strong>最新动作：</strong>{latestAction}</p>}
                <p><strong>证据：</strong></p>
                <ListBlock items={evidence} empty="暂无证据" />
                {task.briefAsOf && <p className="ob-record-meta">简报截至：{formatTime(task.briefAsOf)}</p>}
                {task.sessions && task.sessions.length > 0 && <div className="ob-session-record"><strong>工作对话与分工</strong><ul>{task.sessions.map(session => <li key={session.sessionId}>
                    {session.threadId ? <a href={`/desktop?app=codex&thread=${encodeURIComponent(session.threadId)}`}>{session.isMain ? '主关联' : session.role}</a> : <span>尚未关联</span>}
                    {' · '}{statusLabel(EXECUTION_LABELS, session.execution)}{session.responsibilityStatus === 'ended' ? ' · 职责已结束' : ''}
                </li>)}</ul></div>}

                <p className="ob-record-meta">预计交付：{expectedAt || '未设定'} · 观测：{observedAt || '未观测'} · 来源：{host || '未知'}{sourceAt ? ` · ${sourceAt}` : ''}</p>
                <p className="ob-record-meta">所有权：{ownership.join('；') || '暂无'}</p>
                <p className="ob-record-meta">{taskId || '无任务 ID'}</p>
            </div>
        </details>
    </section>
}

export function OrchestraBoard() {
    const { token, baseUrl } = useAppContext()
    const [snapshot, setSnapshot] = useState<OrchestraSnapshot | null>(null)
    const [connection, setConnection] = useState<'loading' | 'online' | 'offline'>('loading')
    const [receivedAt, setReceivedAt] = useState<number | null>(null)
    const [filter, setFilter] = useState<FilterKey>('all')
    const [selection, setSelection] = useState<Selection | null>(null)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [artifact, setArtifact] = useState<ArtifactState>({ status: 'idle' })
    const artifactSeqRef = useRef(0)
    const mountedRef = useRef(false)
    const inFlightRef = useRef(false)
    const abortRef = useRef<AbortController | null>(null)
    const generationRef = useRef(0)
    const detailRef = useRef<HTMLElement | null>(null)
    const lastTriggerRef = useRef<HTMLElement | null>(null)

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
    const activeTreeTasks = useMemo(() => managedTasks.filter(task => task.archive !== 'archived'), [managedTasks])
    const archivedTasks = useMemo(() => managedTasks.filter(task => task.archive === 'archived'), [managedTasks])
    const treeRows = useMemo(() => chunkTasks(activeTreeTasks), [activeTreeTasks])
    const notices = useMemo(() => (snapshot?.notices ?? []).map(noticeText).filter(Boolean).slice(0, 5), [snapshot])
    const selectedId = selection?.id ?? ''
    const selectedTask = useMemo(() => (selectedId ? managedTasks.find(task => text(task.id) === selectedId) ?? null : null), [managedTasks, selectedId])

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

    const selectTask = useCallback((task: OrchestraTask, trigger: HTMLElement) => {
        const id = text(task.id)
        if (!id) return
        if (!matchesFilter(task, filter)) setFilter('all')
        lastTriggerRef.current = trigger
        setSelection(previous => ({ id, nonce: (previous?.nonce ?? 0) + 1 }))
    }, [filter])

    const loadArtifact = useCallback(async (task: OrchestraTask, index: number) => {
        const taskId = text(task.id)
        if (!taskId) return
        const generation = ++artifactSeqRef.current
        setArtifact({ status: 'loading', taskId, index })
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const response = await fetch(artifactUrl(baseUrl, taskId, index), {
                method: 'GET',
                headers: { accept: 'application/json', authorization: `Bearer ${token}` },
                cache: 'no-store',
                signal: controller.signal
            })
            if (!response.ok) throw Error('Orchestra artifact request failed')
            const value = (await response.json()) as { name?: unknown; content?: unknown }
            const name = text(value?.name)
            const content = text(value?.content)
            if (!content) throw Error('Orchestra artifact response is invalid')
            if (generation !== artifactSeqRef.current) return
            setArtifact({ status: 'ready', taskId, index, name, content })
        } catch {
            if (generation !== artifactSeqRef.current) return
            setArtifact({ status: 'error', taskId, index })
        } finally {
            window.clearTimeout(timer)
        }
    }, [baseUrl, token])

    const closeDetail = useCallback(() => {
        setSelection(null)
        const trigger = lastTriggerRef.current
        lastTriggerRef.current = null
        if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true })
    }, [])

    useEffect(() => {
        if (!selection) return
        const node = detailRef.current
        if (!node || typeof node.scrollIntoView !== 'function') return
        const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        node.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' })
    }, [selection])

    useEffect(() => {
        if (!selectedTask || selectedTask.archive !== 'archived') return
        setArchiveOpen(true)
    }, [selectedTask])

    return <div className="ob-root">
        <div className="ob-shell">
            <header className="ob-head">
                <a className="ob-back" href={BACK_HREF}>← 返回总控对话</a>
                <div className="ob-title-row">
                    <div className="ob-title-copy">
                        <h1>任务总控</h1>
                        <p className="ob-subtitle">任务进展与成果</p>
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
                <details><summary>待处理回报记录 · {notices.length}</summary><ul>{notices.map((notice, index) => <li key={`${index}-${notice.slice(0, 24)}`}>{notice}</li>)}</ul></details>
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
                <details className="ob-tree ob-tree-collapse" data-testid="ob-tree">
                    <summary className="ob-tree-summary">
                        <span>任务树（可选）</span>
                        <span className="ob-tree-count">{managedTasks.length} 个接管 · {counts.attention} 个需处理</span>
                    </summary>
                    <div className="ob-tree-track">
                        <div className="ob-tree-root" data-testid="ob-tree-root">
                            <span className="ob-root-icon" aria-hidden="true">◎</span>
                            <span className="ob-root-copy">
                                <strong>Orchestra 总控</strong>
                                <span>统一跟进 · 原聊天继续</span>
                            </span>
                            <span className="ob-root-stats">
                                <span data-tone="attention">{counts.attention} 需处理</span>
                                <span>{counts.running} 运行中</span>
                            </span>
                        </div>
                        <div className="ob-tree-branches">
                            {treeRows.map((row, index) => <div className="ob-tree-row" key={`row-${index}-${row.map(task => text(task.id)).join('-')}`}>
                                {row.map(task => <TreeTaskNode
                                    key={text(task.id) || text(task.title)}
                                    task={task}
                                    selected={selectedId !== '' && text(task.id) === selectedId}
                                    onSelect={selectTask}
                                />)}
                            </div>)}
                            {activeTreeTasks.length === 0 && archivedTasks.length === 0 && <p className="ob-tree-empty">当前快照没有已接管任务。</p>}
                            {archivedTasks.length > 0 && <details
                                className="ob-tree-archive"
                                open={archiveOpen}
                                onToggle={event => setArchiveOpen(event.currentTarget.open)}
                            >
                                <summary>
                                    <span>已归档任务</span>
                                    <span className="ob-count">{archivedTasks.length}</span>
                                    <span className="ob-tree-archive-hint">{archiveOpen ? '收起' : '展开'}</span>
                                </summary>
                                <div className="ob-tree-archive-list">
                                    {archivedTasks.map(task => <TreeTaskNode
                                        key={text(task.id) || text(task.title)}
                                        task={task}
                                        selected={selectedId !== '' && text(task.id) === selectedId}
                                        onSelect={selectTask}
                                    />)}
                                </div>
                            </details>}
                        </div>
                    </div>
                </details>

                {selectedTask && <TaskDetail
                    task={selectedTask}
                    stale={stale || selectedTask.stale === true}
                    artifact={artifact}
                    onLoadArtifact={(task, index) => { void loadArtifact(task, index) }}
                    onClose={closeDetail}
                    detailRef={detailRef}
                />}

                <section className="ob-table-section" aria-labelledby="ob-table-heading">
                    <header className="ob-table-head">
                        <div>
                            <h2 id="ob-table-heading">任务</h2>
                            <p>点任务查看简报，点“查看成果”读取登记报告。</p>
                        </div>
                        <span>{snapshot.pendingTaskCount ?? managedTasks.filter(task => task.review !== 'accepted' && task.archive !== 'archived').length} 项待办 · {snapshot.runningSessionCount ?? counts.running} 个对话运行</span>
                    </header>
                    <nav className="ob-filters" aria-label="任务筛选">
                        {filters.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
                            {item.label}<span>{item.count}</span>
                        </button>)}
                    </nav>
                    {visibleTasks.length > 0
                        ? <div className="ob-task-list">
                            {visibleTasks.map(task => {
                                const taskId = text(task.id)
                                const selected = selectedId !== '' && taskId === selectedId
                                const status = mergedStatus(task)
                                const attention = isAttention(task)
                                const threadId = text(task.threadId)
                                const showStale = (stale || task.stale === true) && !isHistoricalSettled(task)
                                return <article
                                    key={taskId || text(task.title)}
                                    data-testid="ob-table-row"
                                    data-task-id={taskId || undefined}
                                    data-attention={attention ? 'true' : undefined}
                                    data-selected={selected ? 'true' : undefined}
                                    aria-selected={selected}
                                    className="ob-task-card"
                                >
                                    <button
                                        type="button"
                                        className="ob-task-main"
                                        aria-pressed={selected}
                                        onClick={event => selectTask(task, event.currentTarget)}
                                    >
                                        <span className="ob-task-top">
                                            <span className="ob-row-title">{text(task.title) || '未命名任务'}</span>
                                            <span className="ob-status" data-tone={status.tone}>{status.label}</span>
                                            {showStale && <span className="ob-flag" data-tone="stale">观测过期</span>}
                                        </span>
                                        <span className="ob-task-brief">{taskBrief(task)}</span>
                                    </button>
                                    <div className="ob-task-actions">
                                        <button type="button" className="ob-primary" onClick={event => {
                                            event.stopPropagation()
                                            selectTask(task, event.currentTarget)
                                            void loadArtifact(task, 0)
                                        }}>查看成果</button>
                                        {threadId ? <a className="ob-secondary" href={`/desktop?app=codex&thread=${encodeURIComponent(threadId)}`}>原工作对话</a>
                                            : <span className="ob-secondary">未关联工作对话</span>}
                                    </div>
                                </article>
                            })}
                        </div>
                        : <p className="ob-empty">{managedTasks.length === 0 ? '当前没有已接管的任务。' : '当前筛选下没有任务。'}</p>}
                </section>

                {externalTasks.length > 0 && <details className="ob-external" aria-label={EXTERNAL_HISTORY_LABEL}>
                    <summary className="ob-external-summary">
                        <h2>{EXTERNAL_HISTORY_LABEL}</h2>
                        <span>{externalTasks.length} 条 · 外部导入，仅供只读追溯</span>
                    </summary>
                    <p>外部导入，仅供只读追溯；不进入当前队列和任务树，始终按过期处理。</p>
                    <div className="ob-external-list">{externalTasks.map(task => <ExternalTaskCard key={text(task.id) || text(task.title)} task={task} />)}</div>
                </details>}
            </>}
        </div>
    </div>
}

export default OrchestraBoard
