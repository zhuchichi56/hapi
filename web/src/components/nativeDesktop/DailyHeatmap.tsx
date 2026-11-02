import { useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import './DailyHeatmap.css'

export type ActivityEvent = {
    taskId: string
    title: string
    threadId: string | null
    eventId: string
}
export type ActivityDay = {
    date: string
    recorded: boolean
    dispatches: ActivityEvent[]
    completions: ActivityEvent[]
}
export type ActivitySnapshot = {
    asOf: string
    today: string
    from: string
    to: string
    coverage: { dispatchFrom: string | null; completion: 'explicit-attestations-only' }
    days: ActivityDay[]
}
export type ActivityUnavailable = { available: false; error: string }
export type DailyHeatmapProps = { activity?: ActivitySnapshot | ActivityUnavailable | null }
type Metric = 'dispatches' | 'completions'

function countLabel(day: ActivityDay, metric: Metric): string {
    const count = day[metric].length
    if (metric === 'completions') return `${count} 已确认 · 覆盖未知`
    return day.recorded ? `${count} 已确认` : '无记录'
}

function EventList({ events, empty }: { events: ActivityEvent[]; empty: string }) {
    if (!events.length) return <p className="dh-empty">{empty}</p>
    return <ul className="dh-events">{events.map(event => <li key={event.eventId}>
        <span className="dh-task-id">{event.taskId}</span>
        {event.threadId
            ? <a href={`/desktop?app=codex&thread=${encodeURIComponent(event.threadId)}`}>
                {event.title || '未命名任务'}<span className="dh-sr"> · 原 Desktop 对话</span>
            </a>
            : <span>{event.title || '未命名任务'}</span>}
    </li>)}</ul>
}

/** Parent supplies its existing snapshot refresh; no network calls or timers. */
export function DailyHeatmap({ activity }: DailyHeatmapProps) {
    const [metric, setMetric] = useState<Metric>('dispatches')
    const [selectedDate, setSelectedDate] = useState<string | null>(null)
    const details = useRef<HTMLDetailsElement>(null)
    const buttons = useRef<(HTMLButtonElement | null)[]>([])
    const headingId = useId()
    if (!activity || 'error' in activity) {
        return <section className="daily-heatmap" aria-label="每日活动">
            <h2>每日活动</h2><p role="status">{activity ? '活动记录暂不可用' : '无记录'}</p>
        </section>
    }
    const days = activity.days.slice(-84)
    const selected = days.find(day => day.date === selectedDate)
        ?? days.find(day => day.date === activity.today) ?? days[days.length - 1]
    const today = days.find(day => day.date === activity.today)
    const todayCount = today?.[metric].length ?? 0
    const todayKnown = metric === 'dispatches' && today?.recorded
    const headline = todayCount > 0 || todayKnown ? `${todayCount} 已确认` : '无记录'
    const weekdays = ['日', '一', '二', '三', '四', '五', '六']
    const startWeekday = days[0] ? new Date(`${days[0].date}T00:00:00Z`).getUTCDay() : 0
    function select(day: ActivityDay) {
        setSelectedDate(day.date)
        if (details.current) details.current.open = true
    }
    function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        const offsets: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }
        let next = index
        const offset = offsets[event.key]
        if (offset !== undefined) next = Math.max(0, Math.min(days.length - 1, index + offset))
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = days.length - 1
        else return
        event.preventDefault()
        buttons.current[next]?.focus()
        if (days[next]) select(days[next])
    }
    return <section className="daily-heatmap" aria-labelledby={headingId}>
        <div className="dh-header">
            <div><h2 id={headingId}>每日活动</h2><p>近 12 周 · 北京时间</p></div>
            <div className="dh-toggle" role="group" aria-label="活动指标">
                <button type="button" aria-pressed={metric === 'dispatches'} onClick={() => setMetric('dispatches')}>派遣</button>
                <button type="button" aria-pressed={metric === 'completions'} onClick={() => setMetric('completions')}>完成</button>
            </div>
        </div>
        <p className="dh-today" aria-live="polite">今日 <strong>{headline}</strong>
            {metric === 'completions' && <span className="dh-muted">覆盖未知</span>}</p>
        <div className="dh-calendar">
            <div className="dh-weekdays" aria-hidden="true">{Array.from({ length: 7 }, (_, index) =>
                <span key={index}>{weekdays[(startWeekday + index) % 7]}</span>)}</div>
            <div className="dh-grid" role="group" aria-label="每日活动日历">
                {days.map((day, index) => {
                    const count = day[metric].length
                    const unknown = metric === 'dispatches' ? !day.recorded : count === 0
                    const label = `${day.date} 北京时间 · ${metric === 'dispatches' ? '派遣' : '完成'} ${countLabel(day, metric)}`
                    const titles = day[metric].slice(0, 3).map(event => event.title).join('、')
                    return <button type="button" key={day.date} ref={element => { buttons.current[index] = element }}
                        className="dh-day" data-level={unknown ? 'unknown' : Math.min(count, 4)}
                        aria-label={label} title={`${label}${titles ? `\n${titles}` : ''}`}
                        aria-pressed={selected?.date === day.date}
                        onKeyDown={event => navigate(event, index)} onClick={() => select(day)} />
                })}
            </div>
        </div>
        <div className="dh-footer"><span>{activity.from} — {activity.to}</span>
            <span className="dh-legend" aria-hidden="true">少 <i data-level="0" /><i data-level="2" /><i data-level="4" /> 多</span></div>
        {selected && <details className="dh-details" ref={details}>
            <summary>{selected.date} · 北京时间<span>当日明细</span></summary>
            <div className="dh-detail-body">
                <h3>派遣 · {countLabel(selected, 'dispatches')}</h3>
                <EventList events={selected.dispatches} empty={selected.recorded ? '当日无确认派遣' : '无记录'} />
                <h3>完成 · {countLabel(selected, 'completions')}</h3>
                <EventList events={selected.completions} empty="无记录" />
            </div>
        </details>}
    </section>
}

export default DailyHeatmap
