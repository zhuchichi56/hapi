import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'
import './ModelPicker.css'

export type ModelSettings = { model: string | null; reasoningEffort: string | null; needsActivation?: boolean }
type Model = { id: string; reasoningEfforts?: string[] }
type Call = <T,>(command: Record<string, unknown>) => Promise<T>
type Catalog = { models: Model[]; supportsSelection?: boolean }
const catalogs = new WeakMap<Call, { at: number; promise: Promise<Catalog> }>()
function readCatalog(call: Call, retry: boolean) {
    const cached = catalogs.get(call)
    if (!retry && cached && Date.now() - cached.at < 300000) return cached.promise
    const entry = { at: Date.now(), promise: null as unknown as Promise<Catalog> }
    entry.promise = call<Catalog>({ op: 'models' }).then(catalog => {
        if (!catalog.models?.length || catalog.supportsSelection === false) throw Error('模型列表暂不可用')
        return catalog
    }).catch(error => { if (catalogs.get(call) === entry) catalogs.delete(call); throw error })
    catalogs.set(call, entry)
    return entry.promise
}
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const effortLabels: Record<string, string> = { none: '无', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最大', ultra: '超高' }

export function modelLabel(id: string) {
    const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(sol|astra|luna|terra))?$/.exec(id)
    if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)}` : ''}`
    const claude = /^claude-(sonnet|opus)-(\d+)-(\d+)$/.exec(id)
    if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`
    const gemini = /^gemini-(\d+)-(\w+)$/.exec(id)
    if (gemini) return `Gemini ${gemini[1]} ${gemini[2][0].toUpperCase()}${gemini[2].slice(1)}`
    return id === 'deepseek-flash' ? 'DeepSeek Flash' : id === 'glm-5.3-m17' ? 'GLM-5.3 M17' : id
}

export function modelEffort(model: Model, current: string | null) {
    const supported = model.reasoningEfforts ?? []
    if (!supported.length || current === null || supported.includes(current)) return current
    return [...supported].reverse().find(value => efforts.indexOf(value) <= efforts.indexOf(current)) ?? supported[0]
}

function radioKeys(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]:not(:disabled)'))
    if (!buttons.length) return
    event.preventDefault()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length
    // Navigation moves focus only. Enter/Space commits one explicit native change.
    buttons[next].focus()
}
function Check() {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export function ModelPicker({ id, creating, settings, historyOnly = false, value, onChange, call, disabled, onUpdating, onUpdated }: {
    id?: string; creating: boolean; settings?: ModelSettings; historyOnly?: boolean; value: string; onChange: (model: string) => void
    call: Call; disabled: boolean; onUpdating: (updating: boolean) => void; onUpdated: () => void
}) {
    const [models, setModels] = useState<Model[]>([])
    const [current, setCurrent] = useState<ModelSettings | null>(settings?.model ? settings : null)
    const [loading, setLoading] = useState(true)
    const [pending, setPending] = useState<string | null>(null)
    const [error, setError] = useState('')
    const [retry, setRetry] = useState(0)
    const [open, setOpen] = useState(false)
    const mounted = useRef(true)
    const writing = useRef(false)
    const menu = useRef<HTMLDivElement>(null)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    useEffect(() => { if (settings?.model && !writing.current) setCurrent(settings) }, [settings?.model, settings?.reasoningEffort])
    useEffect(() => {
        let cancelled = false
        setLoading(true)
        void Promise.all([
            readCatalog(call, retry > 0),
            creating || retry === 0 && (historyOnly || settings?.model) ? Promise.resolve(null) : call<ModelSettings>({ op: 'model-settings', id }),
        ]).then(([catalog, native]) => {
            if (cancelled || writing.current) return
            setModels(catalog.models)
            if (native) setCurrent(native.model ? native : null)
            setError('')
        }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    // Live snapshots supply settings without an extra request. Explicit recovery always reads native settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [call, id, creating, retry, historyOnly])
    const update = async (model: string, effort?: string) => {
        if (disabled || loading || error || writing.current) return
        if (creating) { onChange(model); setOpen(false); return }
        if (!id || model === current?.model && (effort === undefined || effort === current.reasoningEffort)) { setOpen(false); return }
        const target = models.find(item => item.id === model)
        if (!target || effort !== undefined && !target.reasoningEfforts?.includes(effort)) return
        writing.current = true; setPending(model); onUpdating(true)
        try {
            // Model changes preserve the App's actual effort, even if a browser snapshot was stale.
            const result = await call<ModelSettings & { id: string; native: boolean }>({
                op: 'set-model', id, model, ...(effort !== undefined ? { reasoningEffort: effort } : {}), actionId: crypto.randomUUID(),
            })
            if (!result.native || result.id !== id || result.model !== model || (effort !== undefined
                ? result.reasoningEffort !== effort
                : result.reasoningEffort != null && !target.reasoningEfforts?.includes(result.reasoningEffort))) throw Error('设置尚未确认，请重新读取')
            if (mounted.current) { setCurrent(result); setOpen(false); onUpdated() }
        } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)) }
        finally { writing.current = false; if (mounted.current) setPending(null); onUpdating(false) }
    }
    const selected = creating ? value : current?.model ?? ''
    const label = selected ? modelLabel(selected) : creating ? '桌面默认' : '选择模型'
    const availableEfforts = creating ? [] : models.find(model => model.id === selected)?.reasoningEfforts ?? []
    const effortLabel = current?.reasoningEffort ? effortLabels[current.reasoningEffort] ?? current.reasoningEffort : ''
    const locked = disabled || loading || !!pending || !!error
    const failure = <span className="nd-model-error" role="alert"><span>{error}</span><button type="button" disabled={disabled || !!pending || loading} onClick={() => setRetry(value => value + 1)}>重新读取</button></span>
    return <span className="nd-model-picker" aria-busy={!!pending}>
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild><button type="button" className="nd-model-trigger" aria-label={creating ? '新会话模型' : '会话模型'}
                disabled={disabled && !pending} title={selected ? `${selected}${effortLabel ? ` · 思考强度：${effortLabel}` : ''}` : creating ? '使用桌面 App 默认模型' : '选择模型，同步到桌面原会话'}>
                <span className="nd-model-name">{error ? '设置待确认' : label}</span>
                {!error && effortLabel && !creating && <span className="nd-model-trigger-effort">{effortLabel}</span>}
                {pending || loading ? <i className="nd-model-spinner" aria-label={pending ? '正在同步模型' : '读取模型'} /> : <svg className="nd-model-chevron" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 8 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </button></Popover.Trigger>
            <Popover.Portal><Popover.Content ref={menu} className="nd-model-menu" aria-label="模型与思考强度" side="top" align="start" sideOffset={10} collisionPadding={12}
                onOpenAutoFocus={event => { event.preventDefault(); (menu.current?.querySelector<HTMLButtonElement>('[role=radio][aria-checked=true]') ?? menu.current?.querySelector<HTMLButtonElement>('[role=radio]:not(:disabled)'))?.focus() }}>
                <header className="nd-model-menu-head"><span>模型</span><small>{creating ? '用于新会话' : pending ? '正在同步…' : '下一轮生效'}</small></header>
                <div className="nd-model-options" role="radiogroup" aria-label="模型" onKeyDown={radioKeys}>
                    {creating && <button type="button" role="radio" aria-checked={!selected} disabled={locked} onClick={() => void update('')}><span>桌面默认</span>{!selected && <Check />}</button>}
                    {!creating && selected && !models.some(model => model.id === selected) && <div className="nd-model-unlisted">当前 · {modelLabel(selected)}</div>}
                    {models.map(model => {
                        const compatible = modelEffort(model, current?.reasoningEffort ?? null)
                        return <button type="button" role="radio" aria-checked={selected === model.id} key={model.id} title={model.id} disabled={locked} onClick={() => void update(model.id)}>
                            <span>{modelLabel(model.id)}</span>
                            {!creating && compatible && compatible !== current?.reasoningEffort && <small>强度 · {effortLabels[compatible] ?? compatible}</small>}
                            {pending === model.id ? <i className="nd-model-spinner" /> : selected === model.id && <Check />}
                        </button>
                    })}
                    {loading && !models.length && <span className="nd-model-empty">读取模型…</span>}
                </div>
                {availableEfforts.length > 0 && <section className="nd-model-reasoning"><span>思考强度</span><div role="radiogroup" aria-label="思考强度" onKeyDown={radioKeys} style={{ gridTemplateColumns: `repeat(${Math.min(4, availableEfforts.length)}, minmax(0,1fr))` }}>
                    {availableEfforts.map(effort => <button type="button" role="radio" aria-checked={current?.reasoningEffort === effort} key={effort} disabled={locked} onClick={() => void update(selected, effort)}>{effortLabels[effort] ?? effort}</button>)}
                </div></section>}
                {error && failure}
                <span className="nd-sr-only" role="status">{pending ? '正在同步模型设置' : ''}</span>
            </Popover.Content></Popover.Portal>
        </Popover.Root>
        {error && !open && failure}
    </span>
}
