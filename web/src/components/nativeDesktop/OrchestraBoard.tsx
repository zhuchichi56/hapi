import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppContext } from '@/lib/app-context'
import type { DailyHeatmapProps } from './DailyHeatmap'
import { useOrchestraSnapshot } from './useOrchestraSnapshot'
import './OrchestraBoard.css'

const BACK_HREF = '/desktop?app=codex'
const ARTIFACT_PATH = '/api/orchestra/artifact'
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
    /** Optional explicit dependency supplied by the private presentation contract. */
    waitingOn?: string
}
export type OrchestraArtifact = { index: number; name: string; preparedAt: string }
export type OrchestraPhaseMetrics = {
    duration?: {
        phaseElapsedSeconds?: number | null
        observedTurnWallSeconds?: number | null
        activeExecutionSeconds?: number | null
    } | null
    usage?: {
        input?: number | null
        output?: number | null
        total?: number | null
    } | null
    coverage?: boolean | 'complete' | 'partial' | { complete?: boolean } | null
    sourceAt?: string | null
}
export type OrchestraInvestment = { phaseMetrics?: OrchestraPhaseMetrics | null }

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
    investment?: OrchestraInvestment | null
    /** UI-only proof derived from explicit activity completions; never trusted raw from the task. */
    wholeGoalVerified?: boolean
    external: boolean
}

export type OrchestraSnapshot = {
    version: 1
    generatedAt: string
    controllerThreadId: string
    collector: OrchestraCollector
    tasks: OrchestraTask[]
    projectCatalog?: ProjectCatalog
    activity?: DailyHeatmapProps['activity']
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
        // Native archive of an old main conversation is not whole-task closure.
        // Only explicit archive/ended external state (or proven whole-goal completion) is historical.
        entries.push(searchable({ key: `task:${identity}`, task, ...location(assignment, projectId), historical: isHistorical(task, referenceMs) }))
    }
    for (const thread of catalog?.threads ?? []) {
        if (represented.has(thread.id) || seenThreads.has(thread.id)) continue
        seenThreads.add(thread.id)
        entries.push(searchable({ key: `thread:${thread.id}`, thread, ...location(assigned(catalog?.assignments, thread.id), thread.projectId), historical: thread.archived === true }))
    }
    return entries
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

function telemetryInputWait(telemetry: OrchestraTelemetry | null | undefined): string | null {
    const reason = text(telemetry?.waitReason).toLowerCase()
    const phase = text(telemetry?.phase).toLowerCase()
    if (/approval|permission/.test(reason) || phase === 'waiting_approval') return '等待审批'
    if (reason === 'user_input' || phase === 'waiting_user') return '等待用户输入'
    return null
}

function sessionInputWait(session: NonNullable<OrchestraTask['sessions']>[number]): string | null {
    return telemetryInputWait(session.telemetry)
}

function freshRunningSession(session: NonNullable<OrchestraTask['sessions']>[number], task: OrchestraTask, referenceMs: number | null, includeMain: boolean): boolean {
    if (task.external || task.archive === 'archived' || isQaTask(task)) return false
    if (session.isMain && !includeMain) return false
    if (!text(session.threadId) || session.execution !== 'running') return false
    if (session.nativeArchived || sessionInputWait(session) || session.responsibilityStatus === 'ended' || isReviewOnlySession(session)) return false
    const observedAt = timestampMs(session.observedAt)
    if (observedAt === null || referenceMs === null) return false
    const age = referenceMs - observedAt
    return age >= -5000 && age <= STALE_AFTER_MS
}

function hasFreshLinkedRunning(task: OrchestraTask, referenceMs: number | null, includeMain: boolean): boolean {
    return (task.sessions ?? []).some(session => text(session.threadId) && !sourceOnlySession(session) && freshRunningSession(session, task, referenceMs, includeMain))
}

function actualResultSummary(task: OrchestraTask): string {
    // The presentation summary is the explicit result surface; brief/progress
    // fallbacks are navigation prose, not proof that an actual result exists.
    return text(task.presentation?.summary)
}

/** Green requires explicit whole-goal proof, accepted review, a prepared artifact and a real result summary. */
function wholeGoalDone(task: OrchestraTask): boolean {
    return task.wholeGoalVerified === true && task.review === 'accepted'
        && readyArtifacts(task).length > 0 && text(actualResultSummary(task)).length > 0
}

function isHistorical(task: OrchestraTask, referenceMs: number | null = null): boolean {
    if (task.external || task.archive === 'archived') return true
    if (taskIsRunning(task, referenceMs)) return false
    if (task.presentation?.phaseState === 'blocked') return false
    if (task.presentation?.phaseState === 'ended') return true
    // Reported/interrupted/failed/reviewed is not whole-task closure. Only a
    // proven whole goal with a result and artifact may collapse on its own.
    return wholeGoalDone(task)
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

function failureReason(task: OrchestraTask): string {
    const reason = publicSummary(task.latestAction) || publicSummary(task.progress) || text(task.presentation?.summary)
    return reason.length > 80 ? `${reason.slice(0, 80)}…` : reason
}

function waitingLabel(task: OrchestraTask): string {
    const explicit = text(task.presentation?.waitingOn)
    if (explicit) return `等待：${explicit}`
    const session = primarySession(task, null)
    return (session && sessionInputWait(session)) || telemetryInputWait(task.telemetry) || ''
}

function mergedStatus(task: OrchestraTask, running: boolean, live: boolean, historical = isHistorical(task)): { label: string; tone: string } {
    if (running) return live ? { label: '进行中', tone: 'running' } : { label: '状态暂不可用', tone: 'muted' }
    const wait = waitingLabel(task)
    const userCancelled = task.presentation?.phaseState === 'ended' && phaseEvidence(task).some(value => /(?:用户|主人|负责人)(?:已|明确|决定|要求|主动|手动|确认|选择|指示)[^。\n]{0,20}(?:关闭|取消|终止|结束)|user[ -](?:closed|cancelled|canceled)/i.test(value))
    if (historical) {
        if (task.execution === 'interrupted') return { label: userCancelled ? '已取消' : '已中断', tone: 'muted' }
        if (task.execution === 'failed') {
            const reason = failureReason(task)
            return { label: reason ? `失败：${reason}` : '失败', tone: 'failed' }
        }
        if (wholeGoalDone(task)) return { label: '✓ 已完成', tone: 'done' }
        if (task.review === 'rejected') return { label: '结果需补齐', tone: 'muted' }
        if (userCancelled) return { label: '已取消', tone: 'muted' }
        if (task.review === 'accepted') return { label: '阶段核验通过', tone: 'muted' }
        if (task.execution === 'reported' || task.review === 'awaiting') return { label: '结果已交，正在核对', tone: 'muted' }
        if (task.archive === 'archived') return { label: '已归档', tone: 'muted' }
        return { label: '已结束', tone: 'muted' }
    }
    if (task.execution === 'failed') {
        const reason = failureReason(task)
        return { label: reason ? `失败：${reason}` : '失败', tone: 'failed' }
    }
    if (wait) return { label: wait, tone: 'waiting' }
    if (task.execution === 'interrupted') {
        const owner = primarySession(task, null)
        if (owner && !owner.isMain && owner.execution === 'reported') return { label: '结果已交，正在核对', tone: 'muted' }
        return { label: '已中断', tone: 'muted' }
    }
    if (task.execution === 'queued' && task.presentation?.phaseState !== 'blocked') return { label: '排队中', tone: 'queued' }
    // A blocked flag without a known dependency must not invent a cause or a yellow claim.
    if (task.presentation?.phaseState === 'blocked' || task.execution === 'blocked') return { label: '依赖信息待核实', tone: 'muted' }
    if (wholeGoalDone(task)) return { label: '✓ 已完成', tone: 'done' }
    if (task.review === 'rejected') return { label: '结果需补齐', tone: 'muted' }
    if (task.review === 'accepted') return { label: '阶段核验通过', tone: 'muted' }
    if (task.execution === 'reported' || task.review === 'awaiting') return { label: '结果已交，正在核对', tone: 'muted' }
    return { label: '状态暂不可用', tone: 'muted' }
}

function coverageComplete(value: unknown): boolean {
    if (value === true || value === 'complete') return true
    return !!value && typeof value === 'object' && !Array.isArray(value) && (value as { complete?: unknown }).complete === true
}

function investmentView(task: OrchestraTask): { compact: string; detail: string } {
    const metrics = task.investment?.phaseMetrics
    const complete = coverageComplete(metrics?.coverage)
    const elapsed = complete ? nonNegativeNumber(metrics?.duration?.phaseElapsedSeconds) : null
    let tokens = complete ? nonNegativeNumber(metrics?.usage?.total) : null
    if (complete && tokens === null) {
        const input = nonNegativeNumber(metrics?.usage?.input)
        const output = nonNegativeNumber(metrics?.usage?.output)
        if (input !== null && output !== null) tokens = input + output
    }
    const source = formatTime(metrics?.sourceAt)
    const elapsedLabel = elapsed === null ? '耗时 未知' : `历时 ${formatRuntime(elapsed)}`
    const tokenLabel = tokens === null ? 'Token 未知' : `Token ${formatMetric(tokens)}`
    const coverage = elapsed !== null && tokens !== null ? '覆盖完整' : '覆盖未知'
    const elapsedDetail = elapsed === null
        ? '耗时 未知（覆盖未知，历时口径为阶段实际经过时间）'
        : `历时 ${formatRuntime(elapsed)}（阶段经过时间，${source ? `源 ${source}` : '源时间未知'}）`
    const tokenDetail = tokens === null ? 'Token 未知（覆盖未知）' : `Token ${formatMetric(tokens)}（覆盖完整）`
    return { compact: `${elapsedLabel} · ${tokenLabel} · ${coverage}`, detail: `${elapsedDetail} · ${tokenDetail}` }
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
        <p className="ob-compact-metrics">{investmentView(task).detail}</p>
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

function CurrentTaskNode({ task, status, selected, onSelect }: {
    task: OrchestraTask; status: { label: string; tone: string }; selected: boolean
    onSelect: (task: OrchestraTask, trigger: HTMLElement) => void
}) {
    const title = taskPresentation(task).title
    return <button type="button" className="ob-node" data-testid="ob-tree-node" data-task-id={task.id}
        data-selected={selected ? 'true' : undefined} aria-pressed={selected}
        onClick={event => onSelect(task, event.currentTarget)}>
        <span className="ob-node-top"><span className="ob-node-dot" data-tone={status.tone} aria-hidden="true" />
            <span className="ob-node-title">{title}</span>
            <span className="ob-status" data-tone={status.tone}>{status.tone === 'done' ? '✓ ' : ''}{status.label}</span>
        </span>
    </button>
}

export function OrchestraBoard() {
    const { token, baseUrl } = useAppContext()
    const { snapshot, connection, receivedAt, refreshing, load, setConnection, mountedRef } = useOrchestraSnapshot()
    const [filter, setFilter] = useState<FilterKey>('all')
    const [view, setView] = useState<'current' | 'history'>('current')
    const [selection, setSelection] = useState<Selection | null>(null)
    const [artifact, setArtifact] = useState<ArtifactState>({ status: 'idle' })
    const artifactSeqRef = useRef(0)
    const detailRef = useRef<HTMLElement | null>(null)
    const lastTriggerRef = useRef<HTMLElement | null>(null)
    const generatedAtMs = timestampMs(snapshot?.generatedAt)
    const completionIds = useMemo(() => { const activity = snapshot?.activity; return new Set(activity && 'days' in activity ? activity.days.flatMap(day => day.completions ?? []).map(event => text(event.taskId)) : []) }, [snapshot?.activity])
    const managedTasks = useMemo(() => {
        const seen = new Set<string>()
        return (snapshot?.tasks ?? []).filter(task => task && typeof task === 'object' && task.external !== true)
            .filter(task => { if (!text(task.id) || seen.has(task.id)) return false; seen.add(task.id); return true })
            .map(task => ({ ...task, wholeGoalVerified: completionIds.has(task.id) }))
            .sort((a, b) => Number(taskIsRunning(b, generatedAtMs)) - Number(taskIsRunning(a, generatedAtMs)) || byAttentionThenAge(a, b))
    }, [snapshot, completionIds, generatedAtMs])
    const currentTasks = managedTasks.filter(task => !isHistorical(task, generatedAtMs))
    const historyTasks = managedTasks.filter(task => isHistorical(task, generatedAtMs))
    const runningIds = new Set(currentTasks.filter(task => taskIsRunning(task, generatedAtMs)).map(task => task.id))
    const counts = { attention: currentTasks.filter(isAttention).length, queued: currentTasks.filter(task => matchesFilter(task, 'queued', runningIds.has(task.id))).length,
        running: runningIds.size, awaiting: currentTasks.filter(task => task.review === 'awaiting').length }
    const visibleTasks = view === 'history' ? historyTasks : currentTasks.filter(task => matchesFilter(task, filter, runningIds.has(task.id)))
    const selectedTask = managedTasks.find(task => task.id === selection?.id) ?? null
    const collector = snapshot?.collector
    const generatedLate = generatedAtMs !== null && receivedAt !== null && receivedAt - generatedAtMs > STALE_AFTER_MS
    const stale = connection === 'offline' || collector?.connected === false || collector?.stale === true || generatedLate
    const live = connection === 'online' && !stale
    const lastSuccess = receivedAt === null ? '' : formatTime(new Date(receivedAt).toISOString())
    const filters: { key: FilterKey; label: string; count: number }[] = [
        { key: 'all', label: '全部', count: currentTasks.length }, { key: 'attention', label: '待决定', count: counts.attention },
        { key: 'queued', label: '排队', count: counts.queued }, { key: 'running', label: '运行中', count: counts.running },
        { key: 'awaiting', label: '核对中', count: counts.awaiting }
    ]
    const selectTask = useCallback((task: OrchestraTask, trigger: HTMLElement) => {
        lastTriggerRef.current = trigger
        setSelection(previous => ({ id: task.id, nonce: (previous?.nonce ?? 0) + 1 }))
        artifactSeqRef.current += 1
        setArtifact({ status: 'idle' })
    }, [])
    const loadArtifact = useCallback(async (task: OrchestraTask, index: number) => {
        if (!readyArtifacts(task).some(item => item.index === index)) return
        const generation = ++artifactSeqRef.current
        setArtifact({ status: 'loading', taskId: task.id, index })
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const response = await fetch(artifactUrl(baseUrl, task.id, index), { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal })
            if (!response.ok) throw Error('Artifact unavailable')
            const value = await response.json() as { name?: unknown; content?: unknown }
            const content = text(value.content)
            if (!content) throw Error('Invalid artifact')
            if (!mountedRef.current || generation !== artifactSeqRef.current) return
            setArtifact({ status: 'ready', taskId: task.id, index, name: text(value.name), content })
        } catch { if (mountedRef.current && generation === artifactSeqRef.current) setArtifact({ status: 'error', taskId: task.id, index }) }
        finally { window.clearTimeout(timer) }
    }, [baseUrl, token])
    const closeDetail = useCallback(() => {
        setSelection(null); artifactSeqRef.current += 1; setArtifact({ status: 'idle' })
        lastTriggerRef.current?.focus({ preventScroll: true })
    }, [])
    useEffect(() => {
        if (!selection) return
        detailRef.current?.focus({ preventScroll: true })
        detailRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
    }, [selection])
    return <div className="ob-root"><div className="ob-shell">
        <header className="ob-head">
            <a className="ob-back" href={snapshot?.controllerThreadId ? conversationHref(snapshot.controllerThreadId) : BACK_HREF}>← 返回总控对话</a>
            <div className="ob-title-row"><div className="ob-title-copy"><h1>任务总控</h1></div>
                <div className="ob-head-actions">
                    <button type="button" className="ob-refresh" aria-busy={refreshing} disabled={refreshing} onClick={() => { void load() }}>{refreshing ? '刷新中…' : '刷新'}</button>
                    <button type="button" className="ob-running-chip" data-live={live ? 'true' : 'false'} data-testid="ob-running-chip" aria-pressed={view === 'current' && filter === 'running'}
                        onClick={() => { setView('current'); setFilter(previous => previous === 'running' ? 'all' : 'running') }}>
                        <span className="ob-live-dot" aria-hidden="true" /><span>运行中 <strong>{live ? counts.running : '—'}</strong> 项</span>
                    </button>
                    <span className="ob-connection" data-state={connection} role="status"><span className="ob-dot" aria-hidden="true" />{live ? '采集器已连接' : connection === 'loading' ? '正在连接' : '状态待更新'}</span>
                </div>
            </div>
            {lastSuccess && <p className="ob-last-success">上次成功读取：{lastSuccess}</p>}
        </header>
        {snapshot && stale && <div className="ob-banner" role="status"><strong>数据可能已过期</strong><span>显示上次成功快照。</span></div>}
        {!snapshot && connection === 'loading' && <p className="ob-loading" role="status">正在读取任务…</p>}
        {!snapshot && connection === 'offline' && <div className="ob-error" role="alert">任务暂不可用。<button type="button" onClick={() => { setConnection('loading'); void load() }}>重试</button></div>}
        {snapshot && <>
            <details className="ob-tree ob-tree-collapse" data-testid="ob-tree">
                <summary className="ob-tree-summary"><span>任务树</span><span className="ob-tree-count">{currentTasks.length} 个当前任务</span></summary>
                <div className="ob-tree-track"><div className="ob-tree-root" data-testid="ob-tree-root"><span className="ob-root-icon" aria-hidden="true">◎</span><strong>当前任务</strong></div>
                    <div className="ob-tree-branches">{Array.from({ length: Math.ceil(currentTasks.length / 2) }, (_, index) =>
                        <div className="ob-tree-row" key={index}>{currentTasks.slice(index * 2, index * 2 + 2).map(task => <CurrentTaskNode key={task.id} task={task}
                            status={mergedStatus(task, runningIds.has(task.id), live)} selected={selection?.id === task.id} onSelect={selectTask} />)}</div>
                    )}{currentTasks.length === 0 && <p className="ob-empty">当前没有未完成任务。</p>}</div>
                </div>
            </details>
            {selectedTask && <TaskDetail task={selectedTask} status={mergedStatus(selectedTask, runningIds.has(selectedTask.id), live)} stale={stale || selectedTask.stale === true}
                referenceMs={generatedAtMs} artifact={artifact} onLoadArtifact={(task, index) => { void loadArtifact(task, index) }} onClose={closeDetail} detailRef={detailRef} />}
            <section className="ob-table-section" aria-labelledby="ob-table-heading">
                <header className="ob-table-head"><h2 id="ob-table-heading">任务</h2><nav className="ob-view-tabs" aria-label="任务视图">
                    <button type="button" aria-pressed={view === 'current'} onClick={() => { setView('current'); setFilter('all') }}>当前<span>{currentTasks.length}</span></button>
                    <button type="button" aria-pressed={view === 'history'} onClick={() => { setView('history'); setFilter('all') }}>历史<span>{historyTasks.length}</span></button>
                </nav></header>
                {view === 'current' && <nav className="ob-filters" aria-label="任务筛选">{filters.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}<span>{item.count}</span></button>)}</nav>}
                {visibleTasks.length > 0 ? <div className="ob-table-wrap"><table className="ob-table"><thead><tr><th>任务</th><th>状态</th><th>正在做什么</th><th>成果</th></tr></thead><tbody>
                    {visibleTasks.map(task => { const status = mergedStatus(task, runningIds.has(task.id), live); const info = taskPresentation(task); const artifacts = readyArtifacts(task)
                        return <tr key={task.id} className="ob-table-row" data-testid="ob-table-row" data-task-id={task.id} data-selected={selection?.id === task.id ? 'true' : undefined}>
                            <td data-label="任务" className="ob-cell-task"><button type="button" className="ob-row-title" aria-pressed={selection?.id === task.id} onClick={event => selectTask(task, event.currentTarget)}>{info.title}</button><span className="ob-row-id">{task.id}</span></td>
                            <td data-label="状态"><span className="ob-status" data-tone={status.tone}>{status.tone === 'done' ? '✓ ' : ''}{status.label}</span></td>
                            <td data-label="正在做什么" className="ob-cell-brief"><span className="ob-brief-text">{info.summary}</span></td>
                            <td data-label="成果">{artifacts.length ? <button type="button" className="ob-artifact-button" onClick={event => { selectTask(task, event.currentTarget); void loadArtifact(task, artifacts[0].index) }}>查看成果</button> : <span className="ob-muted">{status.tone === 'done' ? '已完成' : '—'}</span>}</td>
                        </tr>
                    })}
                </tbody></table></div> : <p className="ob-empty">{view === 'history' ? '历史中没有任务。' : '当前筛选下没有任务。'}</p>}
            </section>
        </>}
    </div></div>
}

export default OrchestraBoard
