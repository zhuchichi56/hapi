import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppContext } from '@/lib/app-context'
import './OrchestraBoard.css'

const BACK_HREF = '/desktop?app=codex'
const SNAPSHOT_PATH = '/api/orchestra/snapshot'
const ARTIFACT_PATH = '/api/orchestra/artifact'
const POLL_MS = 2000
const REQUEST_TIMEOUT_MS = 4000
const STALE_AFTER_MS = 30_000

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

export type OrchestraTelemetryWarning = {
    code?: string | null
    severity?: string | null
    since?: string | null
    detail?: string | null
}

export type OrchestraTelemetry = {
    runtimeSeconds?: number | null
    startedAt?: string | null
    lastProgressAt?: string | null
    phase?: string | null
    waitReason?: string | null
    tokenRate?: number | null
    tokenRateWindowSeconds?: number | null
    tokenRateBasis?: string | null
    tokenRateObservedAt?: string | null
    outputTokens?: number | null
    coarseOutputTokensPerSecond?: number | null
    observedAt?: string | null
    stale?: boolean
    lastProgressBasis?: string | null
    warnings?: OrchestraTelemetryWarning[] | null
}

export type OrchestraPresentation = {
    title: string
    delivery: string
    summary: string
    summaryAt: string | null
    nextStep: string
    phaseState?: 'blocked' | 'ended'
    phaseAt?: string | null
    phaseEvidence?: string | string[] | null
}
export type OrchestraArtifact = { index: number; name: string; preparedAt: string }

export type OrchestraTask = {
    id: string
    title: string
    brief?: string
    briefAsOf?: string
    presentation?: OrchestraPresentation | null
    artifacts?: OrchestraArtifact[]
    telemetry?: OrchestraTelemetry | null
    sessions?: { sessionId: string; threadId: string | null; role: string; execution: OrchestraExecution; review: OrchestraReview; responsibilityStatus: string; isMain: boolean; nativeArchived?: boolean; observedAt?: string | null; telemetry?: OrchestraTelemetry | null }[]
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
    waitingForUser?: boolean
    needsUserAction?: boolean
    external: boolean
}

export type OrchestraSnapshot = {
    version: 1
    generatedAt: string
    controllerThreadId: string
    collector: OrchestraCollector
    tasks: OrchestraTask[]
    projectCatalog?: ProjectCatalog
    projectCatalogError?: string
    notices?: unknown[]
    operations?: unknown[]
    pendingTaskCount?: number
    runningSessionCount?: number
    workSessionTarget?: number
}

export type ProjectAssignment = { projectId: string; directionId: string; evidence: string }
export type CatalogThread = {
    id: string; title: string; updatedAt: string | null; archived: boolean; source: string
    projectId?: string; cwd?: string; summary?: string
}
export type CatalogDirection = { id: string; name: string; parentId?: string | null }
export type CatalogProject = { id: string; name: string; directions: CatalogDirection[] }
export type ProjectCatalog = {
    version: 1; asOf: string | null
    coverage: { indexed: number; emitted: number; truncated: boolean }
    projects: CatalogProject[]
    assignments: Record<string, ProjectAssignment>
    taskAssignments: Record<string, ProjectAssignment>
    threads: CatalogThread[]
}
export type ProjectEntry = {
    key: string; task?: OrchestraTask; thread?: CatalogThread
    projectId: string; directionId: string | null; historical: boolean; searchText: string
}

function catalogProjects(catalog?: ProjectCatalog): CatalogProject[] {
    const projects = Array.isArray(catalog?.projects) ? catalog.projects : []
    return projects.some(project => project.id === 'misc') ? projects : [...projects, { id: 'misc', name: '杂项', directions: [{ id: 'general', name: '未分类' }] }]
}

export function buildProjectEntries(tasks: OrchestraTask[], catalog?: ProjectCatalog, referenceMs: number | null = null): ProjectEntry[] {
    const projects = catalogProjects(catalog)
    const indexed = new Map((catalog?.threads ?? []).map(thread => [thread.id, thread]))
    const represented = new Set<string>()
    const seenTasks = new Set<string>()
    const seenThreads = new Set<string>()
    const entries: ProjectEntry[] = []
    function assigned(values: Record<string, ProjectAssignment> | undefined, id: string) {
        return values && Object.prototype.hasOwnProperty.call(values, id) ? values[id] : undefined
    }
    const misc = { projectId: 'misc', directionId: projects.find(project => project.id === 'misc')?.directions[0]?.id ?? null }
    function location(assignment?: ProjectAssignment, projectId?: string) {
        const project = projects.find(item => item.id === (assignment?.projectId ?? projectId))
        if (!project) return misc
        if (!assignment) return { projectId: project.id, directionId: null }
        return project.directions.some(direction => direction.id === assignment.directionId)
            ? { projectId: project.id, directionId: assignment.directionId } : misc
    }
    function searchable(entry: Omit<ProjectEntry, 'searchText'>): ProjectEntry {
        const project = projects.find(item => item.id === entry.projectId)
        const direction = project?.directions.find(item => item.id === entry.directionId)
        const task = entry.task
        const identities = task ? [task.threadId, ...(task.sessions ?? []).flatMap(session => [session.threadId, session.sessionId])].filter(Boolean) as string[] : []
        return { ...entry, searchText: JSON.stringify([project?.name, direction?.name, task, entry.thread,
            identities.map(id => indexed.get(id))]).toLocaleLowerCase() }
    }
    // Include every session, including ended/source-only sessions, in deduplication.
    for (const task of tasks) {
        if (text(task.threadId)) represented.add(text(task.threadId))
        for (const session of task.sessions ?? []) {
            for (const identity of [text(session.threadId), text(session.sessionId)]) {
                if (identity) represented.add(identity)
            }
        }
    }
    for (const task of tasks) {
        const identity = text(task.id) || text(task.threadId) || text(task.title)
        if (seenTasks.has(identity)) continue
        seenTasks.add(identity)
        const originalThreads = [text(task.threadId), ...(task.sessions ?? []).filter(session => session.isMain).flatMap(session => [text(session.threadId), text(session.sessionId)]),
            ...(task.sessions ?? []).filter(session => !session.isMain).flatMap(session => [text(session.threadId), text(session.sessionId)])].filter(Boolean)
        const assignment = assigned(catalog?.taskAssignments, task.id) ?? originalThreads.map(id => assigned(catalog?.assignments, id)).find(Boolean)
        const projectId = originalThreads.map(id => indexed.get(id)?.projectId).find(Boolean)
        const hasReplacement = responsibleSessions(task).some(session => !session.isMain && session.responsibilityStatus !== 'ended' && !['interrupted', 'failed'].includes(session.execution))
        entries.push(searchable({ key: `task:${identity}`, task, ...location(assignment, projectId), historical: task.external === true || (!taskIsRunning(task, referenceMs) && (isHistorical(task, referenceMs) || (!hasReplacement && indexed.get(text(task.threadId))?.archived === true))) }))
    }
    for (const thread of catalog?.threads ?? []) {
        if (represented.has(thread.id) || seenThreads.has(thread.id)) continue
        seenThreads.add(thread.id)
        entries.push(searchable({ key: `thread:${thread.id}`, thread, ...location(assigned(catalog?.assignments, thread.id), thread.projectId), historical: thread.archived === true }))
    }
    return entries
}

function LazyBranch({ label, count, children, defaultOpen = false, searchKey = '', className = '' }: {
    label: string; count: number | string; children: ReactNode; defaultOpen?: boolean; searchKey?: string; className?: string
}) {
    const [open, setOpen] = useState(defaultOpen)
    const [collapsedSearch, setCollapsedSearch] = useState('')
    const expanded = searchKey ? collapsedSearch !== searchKey : open
    return <details className={`ob-branch ${className}`} open={expanded} onToggle={event => {
        if (searchKey) setCollapsedSearch(event.currentTarget.open ? '' : searchKey)
        else setOpen(event.currentTarget.open)
    }}>
        <summary>{label}<span className="ob-count">{count}</span></summary>
        {expanded && <div className="ob-branch-body">{children}</div>}
    </details>
}

function TaskColumns() {
    return <div className="ob-columns" aria-hidden="true"><span>任务与交付目标</span><span>进展</span><span>投入</span><span>结果</span></div>
}

function SessionLeaves({ task, referenceMs, live }: { task: OrchestraTask; referenceMs: number | null; live: boolean }) {
    const owner = primarySession(task, referenceMs)
    const seen = new Set<string>()
    const sessions = (task.sessions ?? []).filter(session => {
        const id = text(session.threadId)
        if (!id || seen.has(id)) return false
        seen.add(id)
        return true
    })
    if (!sessions.length) return null
    const ended = (session: typeof sessions[number]) => session.nativeArchived === true || session.responsibilityStatus === 'ended' || ['reported', 'failed', 'interrupted'].includes(session.execution)
    const current = sessions.filter(session => !ended(session))
    const history = sessions.filter(ended)
    const render = (session: typeof sessions[number]) => {
        const fresh = freshRunningSession(session, task, referenceMs, true)
        const wait = text(session.telemetry?.waitReason)
        const label = session.nativeArchived ? '已归档' : ended(session) ? session.execution === 'interrupted' ? '已中断' : session.execution === 'failed' ? '执行失败' : '本轮结束'
            : /approval|permission/.test(wait) ? '等待审批' : fresh && live ? '运行中' : session.execution === 'queued' ? '排队中' : '状态暂不可用'
        const scope = session === owner ? taskPresentation(task).delivery || '当前任务交付' : session.isMain ? '原始工作记录' : sourceOnlySession(session) ? '参考记录' : text(session.role) || '协作工作'
        return <li key={session.threadId} className="ob-session-leaf" data-session-thread={session.threadId}>
            <a href={conversationHref(text(session.threadId))}>{session === owner ? '当前负责对话' : session.isMain ? '原主对话' : '协作对话'}</a>
            <span className="ob-leaf-scope" title={scope}>{scope}</span><span className="ob-status" data-tone={fresh && live ? 'running' : 'muted'}>{label}</span>
        </li>
    }
    return <LazyBranch label="工作对话" count={sessions.length} defaultOpen={!isHistorical(task, referenceMs)} className="ob-task-sessions">
        {current.length > 0 && <ul>{current.map(render)}</ul>}
        {history.length > 0 && <LazyBranch label="已结束对话" count={history.length} className="ob-ended-sessions"><ul>{history.map(render)}</ul></LazyBranch>}
    </LazyBranch>
}

function EntryRow({ entry, referenceMs, live, stale, running, selected, onSelect, onArtifact }: {
    entry: ProjectEntry; referenceMs: number | null; live: boolean; stale: boolean; running: boolean; selected: boolean
    onSelect: (task: OrchestraTask, trigger: HTMLElement) => void
    onArtifact: (task: OrchestraTask, index: number, trigger: HTMLElement) => void
}) {
    const task = entry.task
    if (!task) {
        const thread = entry.thread!
        return <article className="ob-entry" data-testid="ob-index-row" data-thread-id={thread.id}>
            <a className="ob-entry-title" href={conversationHref(thread.id)}>{thread.title || '未命名对话'}</a>
            <div className="ob-entry-meta">
                <span className="ob-status" data-tone="muted">索引 · 状态未知</span>
                {thread.archived && <span className="ob-flag">原生已归档</span>}
                <a href={conversationHref(thread.id)}>原对话</a>
                {thread.summary && <LazyBranch label="摘要" count={0} className="ob-index-detail"><p>{thread.summary}</p></LazyBranch>}
            </div>
        </article>
    }
    const session = primarySession(task, referenceMs)
    const threadId = text(session?.threadId) || text(task.threadId)
    const status = task.external ? { label: '历史快照 · 未接管', tone: 'muted' } : mergedStatus(task, running, live, entry.historical)
    const rowStale = stale || task.stale === true || task.external === true
    const view = taskPresentation(task)
    const artifacts = readyArtifacts(task)
    return <article className="ob-entry ob-task-grid" data-testid="ob-task-row" data-task-id={task.id}
        data-selected={selected ? 'true' : undefined} data-attention={isAttention(task) ? 'true' : undefined}>
        <div className="ob-cell ob-task-target" data-label="任务与交付目标">
            <button type="button" className="ob-entry-title" aria-pressed={selected} onClick={event => onSelect(task, event.currentTarget)}>{view.title}</button>
            {view.delivery && <p className="ob-delivery" title={view.delivery}>{view.delivery}</p>}
            <div className="ob-entry-meta">
                <span className="ob-status" data-tone={status.tone}>{status.tone === 'running' && <span className="ob-status-dot" aria-hidden="true" />}{status.label}</span>
                {isAttention(task) && <span className="ob-flag" data-tone="attention">等待你决定</span>}
                {rowStale && <span className="ob-flag" data-tone="stale">已过期</span>}
                {threadId && <a href={conversationHref(threadId)} title={session?.role}>{session?.isMain ? '主工作对话' : '工作对话'}</a>}
            </div>
        </div>
        <div className="ob-cell ob-progress" data-label="进展"><p>{view.summary}</p>{view.summaryAt && <time dateTime={view.summaryAt}>观测 {formatTime(view.summaryAt)}</time>}</div>
        <div className="ob-cell ob-investment" data-label="投入"><span>未采集</span></div>
        <div className="ob-cell ob-artifacts" data-label="结果">{artifacts.length > 0 ? artifacts.map(item =>
            <button key={item.index} type="button" className="ob-artifact-button" onClick={event => onArtifact(task, item.index, event.currentTarget)}>{item.name}</button>
        ) : <span className="ob-muted">尚未交付</span>}</div>
        <SessionLeaves task={task} referenceMs={referenceMs} live={live && !rowStale} />
    </article>
}

type FilterKey = 'all' | 'attention' | 'queued' | 'running' | 'awaiting'
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
const PHASE_LABELS: Record<string, string> = {
    running: '运行中',
    tool: '工具执行中',
    waiting_approval: '等待审批',
    waiting_user: '等待用户',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    unknown: '未知'
}
const WAIT_LABELS: Record<string, string> = {
    approval: '审批',
    user_input: '用户输入',
    long_tool: '长工具',
    long_request: '长请求',
    no_recent_progress: '无近期进展'
}
const PROGRESS_BASIS_LABELS: Record<string, string> = {
    native_public_event: '原生公开事件',
    native_turn_time: '原生轮次时间',
    observed_state_change: '观测状态变化',
    unavailable: '不可用'
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

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeNumber(value: unknown): number | null {
    const parsed = finiteNumber(value)
    return parsed !== null && parsed >= 0 ? parsed : null
}

function formatMetric(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatRuntime(seconds: number): string {
    const total = Math.max(0, Math.round(seconds))
    if (total < 60) return `${total} 秒`
    const minutes = Math.floor(total / 60)
    const rest = total % 60
    if (minutes < 60) return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
    const hours = Math.floor(minutes / 60)
    const minuteRest = minutes % 60
    return minuteRest > 0 ? `${hours} 小时 ${minuteRest} 分` : `${hours} 小时`
}

function telemetryOutdated(telemetry: OrchestraTelemetry | null | undefined, outerStale: boolean): boolean {
    return outerStale || telemetry?.stale === true
}

function progressBasisLabel(telemetry: OrchestraTelemetry | null | undefined): string {
    const basis = text(telemetry?.lastProgressBasis)
    return basis ? PROGRESS_BASIS_LABELS[basis] ?? '依据未知' : ''
}

function generationRateLabel(telemetry: OrchestraTelemetry | null | undefined, outdated: boolean): string {
    // A generation-only rate is credible only with the native-generation basis.
    // Any numeric tokenRate under a coarse/absent basis is intentionally not shown.
    if (text(telemetry?.tokenRateBasis) !== 'native_generation_window') return '未知'
    const rate = nonNegativeNumber(telemetry?.tokenRate)
    if (rate === null) return '待采集'
    if (outdated) return '已过期，待重新采集'
    const window = nonNegativeNumber(telemetry?.tokenRateWindowSeconds)
    return `${formatMetric(rate)} tok/s${window === null ? '' : `（窗口 ${formatMetric(window)} 秒）`}`
}

function coarseRateLabel(telemetry: OrchestraTelemetry | null | undefined, outdated: boolean): string {
    const coarse = nonNegativeNumber(telemetry?.coarseOutputTokensPerSecond)
    if (coarse === null) return text(telemetry?.tokenRateBasis) === 'final_usage_wall_clock_coarse' ? '待采集' : '未知'
    if (outdated) return '已过期，待重新采集'
    return `${formatMetric(coarse)} tok/s`
}

function sessionTelemetryLine(telemetry: OrchestraTelemetry | null | undefined, outerStale: boolean): string {
    if (!telemetry) return '运行数据：待采集'
    const outdated = telemetryOutdated(telemetry, outerStale)
    const parts: string[] = []
    const runtime = nonNegativeNumber(telemetry.runtimeSeconds)
    if (runtime !== null) parts.push(`运行 ${formatRuntime(runtime)}`)
    const phase = text(telemetry.phase)
    if (phase) parts.push(`阶段 ${statusLabel(PHASE_LABELS, phase)}`)
    const wait = text(telemetry.waitReason)
    if (wait) parts.push(`等待 ${WAIT_LABELS[wait] ?? wait}`)
    else if (phase.startsWith('waiting')) parts.push('等待原因待采集')
    const progressAt = formatTime(telemetry.lastProgressAt)
    if (progressAt) {
        const basis = progressBasisLabel(telemetry)
        parts.push(`进展 ${progressAt}${basis ? `（${basis}）` : ''}`)
    }
    if (!outdated) {
        const generation = generationRateLabel(telemetry, false)
        if (generation !== '未知') parts.push(`生成 ${generation}`)
        const coarse = coarseRateLabel(telemetry, false)
        if (coarse !== '未知') parts.push(`粗略·含工具等待 ${coarse}`)
    }
    const outputTokens = nonNegativeNumber(telemetry.outputTokens)
    if (outputTokens !== null) parts.push(`输出 ${formatMetric(outputTokens)} tokens`)
    if (parts.length === 0) return outdated ? '运行数据：已过期' : '运行数据：待采集'
    return `${parts.join(' · ')}${outdated ? '（已过期）' : ''}`
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

function isQaTask(task: OrchestraTask): boolean {
    return /^QA/i.test(text(task.id))
}

function isReviewOnlySession(session: NonNullable<OrchestraTask['sessions']>[number]): boolean {
    // Collector roles are arbitrary human prose, so do not
    // run broad regexes against them. Only exact synthetic review roles are inert.
    const role = text(session.role).toLowerCase()
    return /^(?:qa|review|reviewer|eval|evaluator|evidence)$/.test(role)
}

function freshRunningSession(session: NonNullable<OrchestraTask['sessions']>[number], task: OrchestraTask, referenceMs: number | null, includeMain: boolean): boolean {
    if (task.external || task.archive === 'archived' || isQaTask(task)) return false
    if (session.isMain && !includeMain) return false
    if (!text(session.threadId) || session.execution !== 'running') return false
    if (session.responsibilityStatus === 'ended' || isReviewOnlySession(session)) return false
    const observedAt = timestampMs(session.observedAt)
    if (observedAt === null || referenceMs === null) return false
    const age = referenceMs - observedAt
    return age >= -5000 && age <= STALE_AFTER_MS
}

function hasFreshLinkedRunning(task: OrchestraTask, referenceMs: number | null, includeMain: boolean): boolean {
    return (task.sessions ?? []).some(session => text(session.threadId) && !sourceOnlySession(session) && freshRunningSession(session, task, referenceMs, includeMain))
}

function isHistorical(task: OrchestraTask, referenceMs: number | null = null): boolean {
    if (task.external || task.archive === 'archived') return true
    if (taskIsRunning(task, referenceMs)) return false
    if (task.presentation?.phaseState === 'blocked') return false
    if (task.presentation?.phaseState === 'ended') return true
    if (responsibleSessions(task).some(session => !session.isMain && session.responsibilityStatus !== 'ended' && !['reported', 'failed', 'interrupted'].includes(session.execution))) return false
    if (['reported', 'failed', 'interrupted'].includes(task.execution)) return true
    return task.review === 'accepted'
}

function taskIsRunning(task: OrchestraTask, referenceMs: number | null): boolean {
    if (task.external || task.archive === 'archived' || isQaTask(task)) return false
    // Only a fresh linked responsibility proves actual execution. An accepted
    // main remains provenance; a fresh non-main owner may resume its work.
    return hasFreshLinkedRunning(task, referenceMs, task.review !== 'accepted')
}

function phaseEvidence(task: OrchestraTask): string[] {
    const value = task.presentation?.phaseEvidence
    return typeof value === 'string' ? textList([value]) : textList(value)
}

function mergedStatus(task: OrchestraTask, running: boolean, live: boolean, historical = isHistorical(task)): { label: string; tone: string } {
    if (running) return live ? { label: '进行中', tone: 'running' } : { label: '状态暂不可用', tone: 'muted' }
    if (historical) {
        if (task.execution === 'interrupted') return { label: '已取消', tone: 'muted' }
        if (task.review === 'rejected' || task.execution === 'failed') return { label: '未达标', tone: 'attention' }
        if (task.review === 'accepted') return { label: '已完成', tone: 'done' }
        if (task.presentation?.phaseState === 'ended' && phaseEvidence(task).some(value => /(?:用户|主人|负责人)(?:已|明确|决定|要求|主动|手动|确认|选择|指示)[^。\n]{0,20}(?:关闭|取消|终止|结束)|user[ -](?:closed|cancelled|canceled)/i.test(value))) return { label: '已取消', tone: 'muted' }
        if (task.archive === 'archived') return { label: '已归档', tone: 'muted' }
        return { label: '已结束', tone: 'muted' }
    }
    if (task.execution === 'queued' && task.presentation?.phaseState !== 'blocked') return { label: '排队中', tone: 'queued' }
    if (task.presentation?.phaseState === 'blocked' || task.execution === 'blocked') return { label: '受阻', tone: 'waiting' }
    return { label: '状态暂不可用', tone: 'muted' }
}

function readyArtifacts(task: OrchestraTask): OrchestraArtifact[] {
    const seen = new Set<number>()
    return (Array.isArray(task.artifacts) ? task.artifacts : []).filter(item => {
        if (!item || !Number.isInteger(item.index) || item.index < 0 || !text(item.name) || timestampMs(item.preparedAt) === null || seen.has(item.index)) return false
        seen.add(item.index)
        return true
    })
}

function publicSummary(value: unknown): string {
    if (!text(value)) return ''
    const summary = publicProgress(value).summary
    return summary.startsWith('暂无自然语言公开摘要') ? '' : summary
}

function taskPresentation(task: OrchestraTask) {
    const summary = text(task.presentation?.summary) || publicSummary(task.brief) || publicSummary(task.progress) || '等待进展更新。'
    const summaryAt = text(task.presentation?.summary)
        ? task.presentation?.summaryAt
        : (publicSummary(task.brief) ? task.briefAsOf || task.observedAt : task.observedAt)
    return {
        title: text(task.presentation?.title) || text(task.title) || '未命名任务',
        delivery: text(task.presentation?.delivery) || publicSummary(task.goal),
        summary,
        summaryAt: timestampMs(summaryAt) === null ? '' : text(summaryAt),
        nextStep: text(task.presentation?.nextStep)
    }
}

function isAttention(task: OrchestraTask): boolean {
    return task.needsUserAction === true || task.waitingForUser === true
}

function attentionRank(task: OrchestraTask): number {
    if (task.review === 'awaiting') return 0
    if (task.execution === 'blocked') return 1
    if (task.execution === 'failed' || task.execution === 'interrupted') return 2
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

function matchesFilter(task: OrchestraTask, filter: FilterKey, running: boolean): boolean {
    if (filter === 'attention') return isAttention(task)
    if (filter === 'queued') return !running && task.execution === 'queued' && task.presentation?.phaseState !== 'blocked'
    if (filter === 'running') return running
    if (filter === 'awaiting') return task.review === 'awaiting'
    return true
}

function responsibleSessions(task: OrchestraTask): NonNullable<OrchestraTask['sessions']> {
    return (task.sessions ?? []).filter(session => text(session.threadId) && session.responsibilityStatus !== 'ended')
}

function sourceOnlySession(session: NonNullable<OrchestraTask['sessions']>[number]): boolean {
    // Roles are human prose. Only treat a role as source-only when it carries no
    // current-assignment word (负责人/当前/接手/交接/继续).
    const role = text(session.role)
    if (!role || /(?:负责人|当前|接手|交接|继续)/.test(role)) return false
    return /(?:只读|来源|证据|参考|存档)/.test(role)
}

function currentAssignmentSession(session: NonNullable<OrchestraTask['sessions']>[number]): boolean {
    return /(?:负责人|当前|接手|交接|继续)/.test(text(session.role))
}

function primarySessionRank(session: NonNullable<OrchestraTask['sessions']>[number], task: OrchestraTask, referenceMs: number | null): number {
    const fresh = freshRunningSession(session, task, referenceMs, true)
    if (!session.isMain && fresh) return 0
    // An explicit current assignment outranks a merely resumable old main, and
    // keeps ownership when its execution turns unknown/reported. Running still
    // requires a fresh real execution elsewhere in taskIsRunning.
    if (!session.isMain && currentAssignmentSession(session)) return 1
    if (fresh) return 2
    if (!session.isMain) return 3
    return 4
}

function primarySession(task: OrchestraTask, referenceMs: number | null): NonNullable<OrchestraTask['sessions']>[number] | null {
    // A main session stays as the provenance fallback, but read-only/source-only
    // associated sessions never outrank (or replace) the current responsibility.
    const sessions = responsibleSessions(task).filter(session => session.isMain || !sourceOnlySession(session))
    if (sessions.length === 0) return null
    return sessions.slice().sort((left, right) => {
        const rank = primarySessionRank(left, task, referenceMs) - primarySessionRank(right, task, referenceMs)
        if (rank !== 0) return rank
        const observed = (timestampMs(right.observedAt) ?? 0) - (timestampMs(left.observedAt) ?? 0)
        if (observed !== 0) return observed
        return text(left.sessionId).localeCompare(text(right.sessionId))
    })[0] ?? null
}

function conversationHref(threadId: string): string {
    return `/desktop?app=codex&thread=${encodeURIComponent(threadId)}`
}


function noticeText(value: unknown): string {
    if (typeof value === 'string') return value.trim()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
    const record = value as Record<string, unknown>
    return text(record.message) || text(record.text)
}

function TelemetryDetails({ telemetry, stale, taskId, testId = 'ob-telemetry' }: {
    telemetry: OrchestraTelemetry | null | undefined
    stale: boolean
    taskId?: string
    testId?: string
}) {
    const outdated = telemetryOutdated(telemetry, stale)
    const runtime = nonNegativeNumber(telemetry?.runtimeSeconds)
    const phase = text(telemetry?.phase)
    const wait = text(telemetry?.waitReason)
    const progressAt = formatTime(telemetry?.lastProgressAt)
    const progressBasis = progressBasisLabel(telemetry)
    const observedAt = formatTime(telemetry?.observedAt)
    const outputTokens = nonNegativeNumber(telemetry?.outputTokens)
    const warnings = Array.isArray(telemetry?.warnings)
        ? telemetry.warnings.map(item => text(item?.code)).filter(Boolean).slice(0, 3)
        : []
    const generation = generationRateLabel(telemetry, outdated)
    const coarse = coarseRateLabel(telemetry, outdated)
    if (runtime === null && !phase && !progressAt && !wait && generation === '未知' && coarse === '未知' && outputTokens === null && !observedAt && warnings.length === 0) return null
    return <details
        className="ob-telemetry"
        data-testid={testId}
        data-task-id={taskId || undefined}
        data-stale={outdated ? 'true' : 'false'}
    >
        <summary>运行数据{outdated && <span className="ob-telemetry-stale">（已过期）</span>}</summary>
        <div className="ob-telemetry-lines">
            {runtime !== null && <span data-field="runtime">运行时长：{formatRuntime(runtime)}</span>}
            {phase && <span data-field="phase">阶段：{statusLabel(PHASE_LABELS, phase)}</span>}
            {progressAt && <span data-field="progress">最近有效进展：{progressAt}{progressBasis ? `（${progressBasis}）` : ''}</span>}
            {wait && <span data-field="wait">等待：{WAIT_LABELS[wait] ?? wait}</span>}
            {generation !== '未知' && <span data-field="generation-rate">生成速度：{generation}</span>}
            {coarse !== '未知' && <span data-field="coarse-rate">粗略·含工具等待：{coarse}</span>}
            {outputTokens !== null && <span data-field="output">输出：{formatMetric(outputTokens)} tokens</span>}
            {observedAt && <span data-field="observed">观测：{observedAt}</span>}
            {warnings.length > 0 && <span data-field="warnings">提示：{warnings.join('、')}</span>}
        </div>
    </details>
}

function TelemetryLine({ telemetry, stale }: { telemetry: OrchestraTelemetry | null | undefined; stale: boolean }) {
    const outdated = telemetryOutdated(telemetry, stale)
    const line = sessionTelemetryLine(telemetry, stale)
    if (line === '运行数据：待采集') return null
    return <span
        className="ob-session-telemetry"
        data-testid="ob-session-telemetry"
        data-stale={outdated ? 'true' : 'false'}
    >{line}</span>
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
        .filter(line => !/(?:授权|审批|权限|Full Access|workspace-write|sandbox|danger-full-access|approval policy|authorization)/i.test(line))
        .filter(line => !/^(?:`?[/~]|[\w.-]+\.(?:tsx?|jsx?|py|json|md|css)(?:`|\s|$))/.test(line))
    const first = prose[0] || '暂无自然语言公开摘要，请查看任务目标与进展详情。'
    return { summary: first.length > 220 ? first.slice(0, 220) + '…' : first, detail }
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

function ArtifactResult({ task, state }: { task: OrchestraTask; state: ArtifactState }) {
    if (state.status === 'idle' || state.taskId !== text(task.id) || !readyArtifacts(task).some(item => item.index === state.index)) return null
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

function TaskDetail({ task, status, stale, referenceMs, artifact, onLoadArtifact, onClose, detailRef }: {
    task: OrchestraTask
    status: { label: string; tone: string }
    stale: boolean
    referenceMs: number | null
    artifact: ArtifactState
    onLoadArtifact: (task: OrchestraTask, index: number) => void
    onClose: () => void
    detailRef: RefObject<HTMLElement | null>
}) {
    const view = taskPresentation(task)
    const taskId = text(task.id)
    const primary = primarySession(task, referenceMs)
    const threadId = text(primary?.threadId) || text(task.threadId)
    const artifacts = readyArtifacts(task)
    const showStale = stale && !isHistoricalSettled(task)
    const deliverables = textList(task.deliverables)
    const acceptance = textList(task.acceptance)
    const ownership = textList(task.ownership)
    const evidence = textList(task.evidence)
    const phaseNotes = phaseEvidence(task)
    const brief = publicProgress(task.brief).detail
    const progress = publicProgress(task.progress).detail
    const latestAction = publicProgress(task.latestAction).detail
    return <section ref={detailRef} className="ob-detail ob-mini" data-testid="ob-detail" data-task-id={taskId || undefined}
        data-attention={isAttention(task) ? 'true' : undefined} aria-labelledby="ob-detail-title" tabIndex={-1}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }}>
        <header className="ob-detail-head">
            <div className="ob-detail-heading"><h2 id="ob-detail-title">{view.title}</h2><span className="ob-status" data-tone={status.tone}>{status.label}</span></div>
            <button type="button" className="ob-detail-close" aria-label="关闭任务详情" onClick={onClose}>×</button>
        </header>
        {showStale && <p className="ob-detail-stale" role="status">观测数据已过期，以下为上次快照。</p>}
        {view.delivery && <p className="ob-mini-target"><strong>交付目标：</strong>{view.delivery}</p>}
        <p className="ob-mini-brief"><strong>结论：</strong>{view.summary}{view.summaryAt && <time dateTime={view.summaryAt}> · {formatTime(view.summaryAt)}</time>}</p>
        {artifacts.length > 0 && <div className="ob-task-actions" aria-label="已备妥成果">{artifacts.map(item =>
            <button key={item.index} type="button" className="ob-primary" onClick={() => onLoadArtifact(task, item.index)}>{item.name}</button>
        )}</div>}
        <ArtifactResult task={task} state={artifact} />
        {view.nextStep && <p className="ob-next-step"><strong>下一步：</strong>{view.nextStep}</p>}
        <p className="ob-compact-metrics">耗时 未采集 <span aria-hidden="true"> / </span> Token 未采集</p>
        <details className="ob-record" data-testid="ob-record">
            <summary>技术记录</summary>
            <div className="ob-record-body">
                {threadId && <p><a href={conversationHref(threadId)} title={text(primary?.role) || undefined}>{primary?.isMain ? '主工作对话' : '当前责任对话'}</a></p>}
                {taskId && <p className="ob-record-meta">任务 ID：{taskId}</p>}
                <p data-field="native-status">执行 · {statusLabel(EXECUTION_LABELS, task.execution)}；验收 · {statusLabel(REVIEW_LABELS, task.review)}；归档 · {statusLabel(ARCHIVE_LABELS, task.archive)}</p>
                {text(task.goal) && text(task.goal) !== view.delivery && <p><strong>原始目标：</strong>{task.goal}</p>}
                {text(task.authorization) && <p><strong>授权：</strong>{task.authorization}</p>}
                {text(task.checkpoint) && <p><strong>检查点：</strong>{task.checkpoint}</p>}
                {deliverables.length > 0 && <p><strong>计划交付：</strong>{deliverables.join('；')}</p>}
                {acceptance.length > 0 && <p><strong>验收：</strong>{acceptance.join('；')}</p>}
                {brief && brief !== view.summary && brief !== progress && <p><strong>完整简报：</strong>{brief}</p>}
                {progress && progress !== view.summary && <p><strong>完整进展：</strong>{progress}</p>}
                {latestAction && latestAction !== progress && latestAction !== view.summary && <p><strong>最新动作：</strong>{latestAction}</p>}
                {task.telemetry && <TelemetryDetails telemetry={task.telemetry} stale={stale} taskId={taskId} testId="ob-detail-telemetry" />}
                {evidence.length > 0 && <p><strong>证据：</strong>{evidence.join('；')}</p>}
                {phaseNotes.length > 0 && <p><strong>阶段依据：</strong>{phaseNotes.join('；')}</p>}
                {formatTime(task.presentation?.phaseAt) && <p className="ob-record-meta">阶段观测：{formatTime(task.presentation?.phaseAt)}</p>}
                {formatTime(task.briefAsOf) && <p className="ob-record-meta">简报截至：{formatTime(task.briefAsOf)}</p>}
                {task.sessions && task.sessions.length > 0 && <div className="ob-session-record"><strong>工作对话与分工</strong><ul>{task.sessions.map(session => <li key={session.sessionId}>
                    {session.threadId ? <a href={conversationHref(session.threadId)}>{session.isMain ? '主关联' : session.role || '工作对话'}</a> : <span>{session.role || session.sessionId}</span>}
                    {' · '}{statusLabel(EXECUTION_LABELS, session.execution)}{session.responsibilityStatus === 'ended' ? ' · 职责已结束' : ''}
                    {session.telemetry && <TelemetryLine telemetry={session.telemetry} stale={stale} />}
                </li>)}</ul></div>}
                {formatTime(task.expectedAt) && <p className="ob-record-meta">预计交付：{formatTime(task.expectedAt)}</p>}
                {formatTime(task.observedAt) && <p className="ob-record-meta">观测：{formatTime(task.observedAt)}</p>}
                {(text(task.host) || formatTime(task.sourceAt)) && <p className="ob-record-meta">来源：{[text(task.host), formatTime(task.sourceAt)].filter(Boolean).join(' · ')}</p>}
                {ownership.length > 0 && <p className="ob-record-meta">所有权：{ownership.join('；')}</p>}
            </div>
        </details>
    </section>
}

export function OrchestraBoard() {
    const { token, baseUrl } = useAppContext()
    const [snapshot, setSnapshot] = useState<OrchestraSnapshot | null>(null)
    const [connection, setConnection] = useState<'loading' | 'online' | 'offline'>('loading')
    const [receivedAt, setReceivedAt] = useState<number | null>(null)
    const [refreshing, setRefreshing] = useState(false)
    const [filter, setFilter] = useState<FilterKey>('all')
    const [search, setSearch] = useState('')
    const [selection, setSelection] = useState<Selection | null>(null)
    const [artifact, setArtifact] = useState<ArtifactState>({ status: 'idle' })
    const artifactSeqRef = useRef(0)
    const mountedRef = useRef(false)
    const inFlightRef = useRef(false)
    const abortRef = useRef<AbortController | null>(null)
    const generationRef = useRef(0)
    const detailRef = useRef<HTMLElement | null>(null)
    const searchRef = useRef<HTMLInputElement | null>(null)
    const lastTriggerRef = useRef<HTMLElement | null>(null)

    const load = useCallback(async () => {
        if (!mountedRef.current || inFlightRef.current) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        inFlightRef.current = true
        setRefreshing(true)
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
            if (generation === generationRef.current) { inFlightRef.current = false; if (mountedRef.current) setRefreshing(false) }
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
        window.addEventListener('focus', tick)
        window.addEventListener('orchestra:changed', tick)
        return () => {
            mountedRef.current = false
            generationRef.current += 1
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('focus', tick)
            window.removeEventListener('orchestra:changed', tick)
            abortRef.current?.abort()
            abortRef.current = null
            inFlightRef.current = false
        }
    }, [load])

    const generatedAtMs = timestampMs(snapshot?.generatedAt)
    const allTasks = useMemo(() => (snapshot?.tasks ?? []).filter((task): task is OrchestraTask => !!task && typeof task === 'object' && !Array.isArray(task)), [snapshot])
    const managedTasks = useMemo(() => {
        const seen = new Set<string>()
        return allTasks
            .filter(task => task.external !== true)
            .filter(task => {
                const id = text(task.id) || text(task.title)
                if (seen.has(id)) return false
                seen.add(id)
                return true
            })
            .sort((a, b) => Number(taskIsRunning(b, generatedAtMs)) - Number(taskIsRunning(a, generatedAtMs)) || byAttentionThenAge(a, b))
    }, [allTasks, generatedAtMs])
    const runningIds = useMemo(() => new Set(managedTasks.filter(task => taskIsRunning(task, generatedAtMs)).map(task => text(task.id)).filter(Boolean)), [managedTasks, generatedAtMs])
    const currentTasks = useMemo(() => managedTasks.filter(task => !isHistorical(task, generatedAtMs)), [managedTasks, generatedAtMs])
    const counts = useMemo(() => ({
        attention: currentTasks.filter(isAttention).length,
        queued: currentTasks.filter(task => !runningIds.has(task.id) && task.execution === 'queued' && task.presentation?.phaseState !== 'blocked').length,
        running: runningIds.size,
        awaiting: currentTasks.filter(task => task.review === 'awaiting').length
    }), [currentTasks, runningIds])
    const entries = useMemo(() => buildProjectEntries(allTasks, snapshot?.projectCatalog, generatedAtMs), [allTasks, snapshot?.projectCatalog, generatedAtMs])
    const query = search.trim().toLocaleLowerCase()
    const visibleEntries = useMemo(() => entries.filter(entry =>
        (!query || entry.searchText.includes(query)) &&
        (filter === 'all' || (entry.task && !entry.task.external && !entry.historical && matchesFilter(entry.task, filter, runningIds.has(text(entry.task.id)))))
    ), [entries, query, filter, runningIds])
    const projects = useMemo(() => catalogProjects(snapshot?.projectCatalog), [snapshot?.projectCatalog])
    const entryPriority = (entry: ProjectEntry) => entry.historical ? 5 : !entry.task ? 4 : runningIds.has(text(entry.task.id)) ? 0 : entry.task.presentation?.phaseState === 'blocked' ? 2 : entry.task.execution === 'queued' ? 1 : entry.task.execution === 'blocked' ? 2 : 3
    const branchPriority = (items: ProjectEntry[]) => Math.min(6, ...items.map(entryPriority))
    const orderedEntries = visibleEntries.slice().sort((a, b) => entryPriority(a) - entryPriority(b) || (a.task && b.task ? byAttentionThenAge(a.task, b.task) : 0))
    const orderedProjects = projects.slice().sort((a, b) => branchPriority(orderedEntries.filter(entry => entry.projectId === a.id)) - branchPriority(orderedEntries.filter(entry => entry.projectId === b.id)))
    const entryCount = (items: ProjectEntry[]) => {
        const tasks = items.filter(item => item.task).length
        const chats = items.filter(item => item.thread).length
        return [tasks ? `${tasks} 任务` : '', chats ? `${chats} 对话` : ''].filter(Boolean).join(' · ')
    }
    const runningThreads = new Set(managedTasks.flatMap(task => (task.sessions ?? []).filter(session => !sourceOnlySession(session) && freshRunningSession(session, task, generatedAtMs, true)).map(session => text(session.threadId)))).size
    const miscHistory = orderedEntries.filter(entry => entry.projectId === 'misc' && entry.historical)
    const notices = useMemo(() => (snapshot?.notices ?? []).map(noticeText).filter(Boolean).slice(0, 5), [snapshot])
    const selectedId = selection?.id ?? ''
    const selectedTask = useMemo(() => (selectedId ? allTasks.find(task => text(task.id) === selectedId) ?? null : null), [allTasks, selectedId])

    const collector = snapshot?.collector
    const generatedLate = generatedAtMs !== null && receivedAt !== null && receivedAt - generatedAtMs > STALE_AFTER_MS
    const staleReason = collector?.connected === false ? '采集器未连接'
        : collector?.stale === true ? '采集器报告数据已过期'
            : generatedLate ? '当前快照生成时间较早，可能已过期'
                : ''
    const stale = connection === 'offline' || staleReason.length > 0
    const live = connection === 'online' && !stale
    const lastSuccess = receivedAt === null ? '' : formatTime(new Date(receivedAt).toISOString())
    const connectionLabel = connection === 'loading' ? '正在连接采集器'
        : connection === 'offline' ? '采集器已断开'
            : stale ? '快照可能已过期' : '采集器已连接'
    const filters: { key: FilterKey; label: string; count: number }[] = [
        { key: 'all', label: '全部', count: entries.length },
        { key: 'attention', label: '待决定', count: counts.attention },
        { key: 'queued', label: '排队', count: counts.queued },
        { key: 'running', label: '运行中', count: counts.running },
        { key: 'awaiting', label: '待验收', count: counts.awaiting }
    ]

    const selectTask = useCallback((task: OrchestraTask, trigger: HTMLElement) => {
        const id = text(task.id)
        if (!id) return
        if (!matchesFilter(task, filter, runningIds.has(id))) setFilter('all')
        lastTriggerRef.current = trigger
        setSelection(previous => ({ id, nonce: (previous?.nonce ?? 0) + 1 }))
    }, [filter, runningIds])

    const loadArtifact = useCallback(async (task: OrchestraTask, index: number) => {
        const taskId = text(task.id)
        if (!taskId || !readyArtifacts(task).some(item => item.index === index)) return
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
            if (!mountedRef.current || generation !== artifactSeqRef.current) return
            setArtifact({ status: 'ready', taskId, index, name, content })
        } catch {
            if (!mountedRef.current || generation !== artifactSeqRef.current) return
            setArtifact({ status: 'error', taskId, index })
        } finally {
            window.clearTimeout(timer)
        }
    }, [baseUrl, token])

    const closeDetail = useCallback(() => {
        setSelection(null)
        artifactSeqRef.current += 1
        setArtifact({ status: 'idle' })
        const trigger = lastTriggerRef.current
        lastTriggerRef.current = null
        if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true })
        else searchRef.current?.focus({ preventScroll: true })
    }, [])

    useEffect(() => {
        if (!selection) return
        const node = detailRef.current
        if (!node) return
        node.focus({ preventScroll: true })
        if (typeof node.scrollIntoView !== 'function') return
        const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        node.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' })
    }, [selection])

    function renderEntry(entry: ProjectEntry) {
        return <EntryRow key={entry.key} entry={entry} referenceMs={generatedAtMs} live={live} stale={stale}
            running={!!entry.task && runningIds.has(text(entry.task.id))} selected={!!entry.task && selectedId === text(entry.task.id)}
            onSelect={selectTask} onArtifact={(task, index, trigger) => { selectTask(task, trigger); void loadArtifact(task, index) }} />
    }

    return <div className="ob-root">
        <div className="ob-shell">
            <header className="ob-head">
                <a className="ob-back" href={text(snapshot?.controllerThreadId) ? conversationHref(snapshot!.controllerThreadId) : BACK_HREF}>← 返回对话</a>
                <div className="ob-title-row">
                    <div className="ob-title-copy">
                        <h1>任务总控</h1>
                    </div>
                    <div className="ob-head-actions"><button type="button" className="ob-refresh" aria-busy={refreshing} disabled={refreshing} onClick={() => { void load() }}>{refreshing ? '刷新中…' : '刷新'}</button>
                        <button
                            type="button"
                            className="ob-running-chip"
                            data-live={live ? 'true' : 'false'}
                            data-testid="ob-running-chip"
                            aria-pressed={filter === 'running'}
                            onClick={() => {
                                setFilter(previous => previous === 'running' ? 'all' : 'running')
                            }}
                        >
                            <span className="ob-live-dot" aria-hidden="true" />
                            <span>运行中 <strong>{counts.running}</strong> 项</span>
                            {!live && <span className="ob-chip-subdue">状态待更新</span>}
                        </button>
                        <span className="ob-connection" data-state={connection} role="status" aria-live="polite">
                            <span className="ob-dot" aria-hidden="true" />{connectionLabel}
                        </span>
                    </div>
                </div>
                {lastSuccess && <p className="ob-last-success">上次成功读取：{lastSuccess}</p>}
            </header>

            {snapshot && stale && <div className="ob-banner" data-tone={connection === 'offline' ? 'offline' : 'stale'} role="status">
                <strong>{connection === 'offline' ? '采集器已断开' : '数据可能已过期'}</strong>
                <span>{connection === 'offline' ? '显示上次成功快照，实时状态暂停更新。' : staleReason}</span>
                {lastSuccess && <span>上次成功：{lastSuccess}</span>}
            </div>}

            {notices.length > 0 && <section className="ob-notices" aria-label="采集器提示">
                <details><summary>采集记录 · {notices.length}</summary><ul>{notices.map((notice, index) => <li key={`${index}-${notice.slice(0, 24)}`}>{notice}</li>)}</ul></details>
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
                {snapshot.projectCatalogError && <p className="ob-banner" role="alert">项目目录读取失败，未分类任务仍可查看。</p>}
                {snapshot.projectCatalog?.coverage?.truncated && snapshot.projectCatalog.coverage.emitted < snapshot.projectCatalog.coverage.indexed && <p className="ob-banner" role="status">目录覆盖 {snapshot.projectCatalog.coverage.emitted}/{snapshot.projectCatalog.coverage.indexed} 对话</p>}
                <section className="ob-project-tree" aria-label="项目树" data-testid="ob-tree">
                    <p className="ob-tree-counts">{projects.filter(project => entries.some(entry => entry.projectId === project.id)).length} 项目 · {new Set(entries.filter(entry => entry.directionId).map(entry => `${entry.projectId}:${entry.directionId}`)).size} 方向 · {managedTasks.length} 任务 · {live ? `${runningThreads} 运行对话` : '运行对话状态暂不可用'}</p>
                    <label className="ob-search">搜索所有条目
                        <input ref={searchRef} type="search" value={search} onChange={event => { setSearch(event.currentTarget.value); setFilter('all') }} placeholder="项目、方向、任务或历史对话" />
                    </label>
                    <nav className="ob-filters" aria-label="任务筛选">
                        {filters.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
                            {item.label}<span>{item.count}</span>
                        </button>)}
                    </nav>
                    {orderedProjects.map(project => {
                        const grouped = orderedEntries.filter(entry => entry.projectId === project.id && !(project.id === 'misc' && entry.historical))
                        if (grouped.length === 0) return null
                        return <LazyBranch key={project.id} label={project.name} count={entryCount(grouped)} defaultOpen={grouped.some(entry => !!entry.task && !entry.historical)} searchKey={query} className="ob-project">
                            {(() => {
                                const descendants = (id: string | null, seen = new Set<string>()): Set<string | null> => {
                                    const ids = new Set<string | null>([id])
                                    for (const direction of project.directions.filter(item => item.parentId === id)) {
                                        if (seen.has(direction.id)) continue
                                        seen.add(direction.id)
                                        for (const child of descendants(direction.id, seen)) ids.add(child)
                                    }
                                    return ids
                                }
                                const renderDirection = (direction: { id: string | null; name: string; parentId?: string | null }): ReactNode => {
                                    const ids = descendants(direction.id)
                                    const subtree = grouped.filter(entry => ids.has(entry.directionId))
                                    if (!subtree.length) return null
                                    const children = grouped.filter(entry => entry.directionId === direction.id)
                                    const current = children.filter(entry => !!entry.task && !entry.historical)
                                    const related = children.filter(entry => !!entry.thread && !entry.historical)
                                    const history = children.filter(entry => entry.historical)
                                    const nested = project.directions.filter(item => item.parentId === direction.id)
                                        .sort((a, b) => branchPriority(grouped.filter(entry => descendants(a.id).has(entry.directionId))) - branchPriority(grouped.filter(entry => descendants(b.id).has(entry.directionId))))
                                    return <LazyBranch key={direction.id ?? 'unassigned'} label={direction.name} count={entryCount(subtree)} defaultOpen={subtree.some(entry => !!entry.task && !entry.historical)} searchKey={query} className="ob-direction">
                                        {current.length > 0 && <><TaskColumns />{current.map(renderEntry)}</>}
                                        {nested.map(renderDirection)}
                                        {related.length > 0 && <LazyBranch label="相关对话" count={related.length} searchKey={query} className="ob-related">{related.map(renderEntry)}</LazyBranch>}
                                        {history.length > 0 && <LazyBranch label="已结束与归档" count={entryCount(history)} searchKey={query} className="ob-project-history">
                                            {history.some(entry => entry.task) && <TaskColumns />}{history.map(renderEntry)}
                                        </LazyBranch>}
                                    </LazyBranch>
                                }
                                return [...project.directions.filter(direction => !direction.parentId), { id: null, name: '未分方向' }]
                                    .sort((a, b) => branchPriority(grouped.filter(entry => descendants(a.id).has(entry.directionId))) - branchPriority(grouped.filter(entry => descendants(b.id).has(entry.directionId))))
                                    .map(renderDirection)
                            })()}
                        </LazyBranch>
                    })}
                    {miscHistory.length > 0 && <LazyBranch label="历史" count={miscHistory.length} searchKey={query} className="ob-history">
                        {miscHistory.some(entry => entry.task) && <TaskColumns />}{miscHistory.map(renderEntry)}
                    </LazyBranch>}
                    {visibleEntries.length === 0 && <p className="ob-empty">没有匹配条目。</p>}
                </section>

                {selectedTask && <TaskDetail
                    task={selectedTask}
                    status={selectedTask.external ? { label: '历史快照 · 未接管', tone: 'muted' } : mergedStatus(selectedTask, runningIds.has(text(selectedTask.id)), live, entries.find(entry => entry.task === selectedTask)?.historical)}
                    stale={stale || selectedTask.stale === true}
                    referenceMs={generatedAtMs}
                    artifact={artifact}
                    onLoadArtifact={(task, index) => { void loadArtifact(task, index) }}
                    onClose={closeDetail}
                    detailRef={detailRef}
                />}

            </>}
        </div>
    </div>
}

export default OrchestraBoard
