import { useMemo, useState } from 'react'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

type TextPart = { type: 'text'; text: string }
type HeartbeatPart = { type: 'heartbeat'; raw: string; automationId: string; time: string; decision: string; message: string; hasInstructions: boolean }
type Part = TextPart | HeartbeatPart

// Code examples and escaped markup are conversation text, not event envelopes.
function codeRanges(text: string) {
    const ranges: [number, number][] = []
    let offset = 0, fence: { marker: string; start: number } | null = null
    for (const line of text.split('\n')) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
        if (fence) {
            if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
                ranges.push([fence.start, offset + line.length])
                fence = null
            }
        } else if (marker) fence = { marker: marker[1], start: offset }
        else if (/^(?: {4}|\t| {0,3}>)/.test(line)) ranges.push([offset, offset + line.length])
        offset += line.length + 1
    }
    if (fence) ranges.push([fence.start, text.length])
    for (const match of text.matchAll(/(`+)[\s\S]*?\1/g)) ranges.push([match.index, match.index + match[0].length])
    return ranges
}

export function splitMessageContent(text: string): Part[] {
    if (!text.includes('<heartbeat')) return [{ type: 'text', text }]
    const ranges = codeRanges(text)
    const parts: Part[] = []
    let offset = 0
    for (const match of text.matchAll(/<heartbeat\s*>([\s\S]*?)<\/heartbeat\s*>/g)) {
        const index = match.index
        if (ranges.some(([start, end]) => index >= start && index < end)) continue
        const prefix = text.slice(0, index)
        if ((/\\+$/.exec(prefix)?.[0].length ?? 0) % 2) continue
        const field = (name: string) => new RegExp(`<${name}\\s*>([\\s\\S]*?)<\\/${name}\\s*>`).exec(match[1])?.[1].trim() ?? ''
        const automationId = field('automation_id'), time = field('current_time_iso')
        const decision = field('decision'), message = field('message'), hasInstructions = !!field('instructions')
        if (!automationId && !time && !decision && !message && !hasInstructions) continue
        if (index > offset && text.slice(offset, index).trim()) parts.push({ type: 'text', text: text.slice(offset, index) })
        parts.push({ type: 'heartbeat', raw: match[0], automationId, time, decision, message, hasInstructions })
        offset = index + match[0].length
    }
    if (!parts.length) return [{ type: 'text', text }]
    if (text.slice(offset).trim()) parts.push({ type: 'text', text: text.slice(offset) })
    return parts
}

function Heartbeat({ part }: { part: HeartbeatPart }) {
    const [expanded, setExpanded] = useState(false)
    const parsedTime = new Date(part.time)
    const time = part.time && Number.isFinite(parsedTime.getTime()) ? parsedTime.toLocaleString('zh-CN', { hour12: false }) : ''
    const decision = part.decision === 'DONT_NOTIFY' ? '无需提醒' : part.decision === 'NOTIFY' ? '有更新' : part.decision
    return <aside className="nd-heartbeat" aria-label="自动检查记录">
        <header><span className="nd-heartbeat-icon" aria-hidden="true">↻</span><strong>{part.hasInstructions && !part.message ? '后台任务唤醒' : '自动检查'}</strong>{decision && <span className="nd-heartbeat-badge">{decision}</span>}</header>
        {(part.automationId || time) && <div className="nd-heartbeat-meta">{part.automationId && <span>{part.automationId}</span>}{time && <time dateTime={part.time}>{time}</time>}</div>}
        {part.message ? <p className="nd-heartbeat-message">{part.message}</p> : <p className="nd-heartbeat-hint">{part.hasInstructions ? '内部任务指令已折叠' : '自动检查记录'}</p>}
        <details onToggle={event => setExpanded(event.currentTarget.open)}><summary>查看原始记录</summary>{expanded && <pre>{part.raw}</pre>}</details>
    </aside>
}

export function NativeMessageContent({ text, user = false }: { text: string; user?: boolean }) {
    const parts = useMemo(() => splitMessageContent(text), [text])
    return <div className={`nd-message-parts${user ? ' nd-message-parts-user' : ''}`}>{parts.map((part, index) => part.type === 'heartbeat'
        ? <Heartbeat key={index} part={part} />
        : user ? <div key={index} className="nd-user-text">{part.text}</div>
        : <MarkdownRenderer key={index} content={part.text} standalone className="nd-render" />)}</div>
}
