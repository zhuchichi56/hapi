import { useEffect, useRef, useState } from 'react'

export type ModelSettings = { model: string | null; reasoningEffort: string | null }
type Model = { id: string; reasoningEfforts?: string[] }
type Call = <T,>(command: Record<string, unknown>) => Promise<T>
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export function modelEffort(model: Model, current: string | null) {
    const supported = model.reasoningEfforts ?? []
    if (!supported.length || current === null || supported.includes(current)) return current
    return [...supported].reverse().find(value => efforts.indexOf(value) <= efforts.indexOf(current)) ?? supported[0]
}

export function ModelPicker({ id, creating, settings, value, onChange, call, disabled, onUpdating, onUpdated }: {
    id?: string; creating: boolean; settings?: ModelSettings; value: string; onChange: (model: string) => void
    call: Call; disabled: boolean; onUpdating: (updating: boolean) => void; onUpdated: () => void
}) {
    const [models, setModels] = useState<Model[]>([])
    const [current, setCurrent] = useState<ModelSettings | null>(settings?.model ? settings : null)
    const [loading, setLoading] = useState(true)
    const [updating, setUpdating] = useState(false)
    const [error, setError] = useState('')
    const [retry, setRetry] = useState(0)
    const mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    useEffect(() => { if (settings?.model) setCurrent(settings) }, [settings?.model, settings?.reasoningEffort])
    useEffect(() => {
        let cancelled = false
        setLoading(true); setError('')
        void Promise.all([
            call<{ models: Model[]; supportsSelection?: boolean }>({ op: 'models' }),
            creating || retry === 0 && settings?.model ? Promise.resolve(null) : call<ModelSettings>({ op: 'model-settings', id }),
        ]).then(([catalog, native]) => {
            if (cancelled) return
            if (!catalog.models?.length) throw Error('模型列表暂不可用')
            setModels(catalog.models)
            if (native?.model) setCurrent(native)
        }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    // A live snapshot supplies settings without an extra request; subsequent snapshots update them above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [call, id, creating, retry])
    const change = async (model: string) => {
        if (disabled || updating) return
        if (creating) { onChange(model); return }
        if (!id || !current?.model || model === current.model) return
        const target = models.find(item => item.id === model)
        if (!target) return
        const effort = modelEffort(target, current.reasoningEffort)
        setUpdating(true); setError(''); onUpdating(true)
        try {
            const result = await call<ModelSettings & { id: string; native: boolean }>({
                op: 'set-model', id, model, ...(effort !== null ? { reasoningEffort: effort } : {}), actionId: crypto.randomUUID(),
            })
            if (!result.native || result.id !== id || result.model !== model || result.reasoningEffort !== effort) throw Error('模型切换尚未确认，请重试读取设置')
            if (mounted.current) { setCurrent(result); onUpdated() }
        } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)) }
        finally { if (mounted.current) setUpdating(false); onUpdating(false) }
    }
    const selected = creating ? value : current?.model ?? ''
    return <span className="nd-model-picker">
        <select aria-label={creating ? '新会话模型' : '会话模型'} value={selected} disabled={disabled || loading || updating || !creating && !current?.model}
            title={creating ? '使用桌面 App 支持的模型' : `同步到桌面 App，下一轮生效${current?.reasoningEffort ? ` · ${current.reasoningEffort}` : ''}；若模型不支持当前强度，选项会注明新强度`}
            onChange={event => void change(event.target.value)}>
            {creating ? <option value="">桌面默认模型</option> : !selected && <option value="">{loading ? '读取模型…' : 'Codex'}</option>}
            {!creating && selected && !models.some(model => model.id === selected) && <option value={selected}>{selected}</option>}
            {models.map(model => { const effort = modelEffort(model, current?.reasoningEffort ?? null); return <option key={model.id} value={model.id}>{model.id}{!creating && effort !== current?.reasoningEffort ? ` · ${effort}` : ''}</option> })}
        </select>
        {updating && <span className="nd-model-progress" aria-label="正在同步模型">···</span>}
        {error && <span className="nd-model-error" role="alert">{error} <button type="button" className="nd-text-btn" disabled={disabled || updating || loading} onClick={() => setRetry(value => value + 1)}>重试</button></span>}
    </span>
}
