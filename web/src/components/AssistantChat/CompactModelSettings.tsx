import { useTranslation } from '@/lib/use-translation'
import { useEffect, useRef, useState } from 'react'

export function CompactModelSettings(props: {
    modelLabel: string
    effortLabel?: string
    effortOptions: Array<{ value: string | null; label: string; disabled?: boolean }>
    effortValue: string | null
    disabled: boolean
    onModel?: () => void
    onEffort: () => void
    onChange: (value: string | null) => void
}) {
    const { t } = useTranslation()
    const effortOptions = props.effortOptions.filter(option => !option.disabled)
    const unavailableOption = props.effortOptions.find(option => option.disabled && option.value === props.effortValue)
    const matchedIndex = effortOptions.findIndex(option => option.value === props.effortValue)
    const selectedIndex = matchedIndex >= 0 ? matchedIndex : Math.max(0, effortOptions.findIndex(option => option.label === props.effortLabel))
    const [draftIndex, setDraftIndex] = useState(selectedIndex)
    const draftIndexRef = useRef(selectedIndex)
    const draggingRef = useRef(false)
    useEffect(() => {
        if (draggingRef.current) return
        draftIndexRef.current = selectedIndex
        setDraftIndex(selectedIndex)
    }, [selectedIndex])
    const selected = effortOptions[draftIndex] ?? effortOptions[selectedIndex]
    const commit = () => {
        const option = effortOptions[draftIndexRef.current]
        if (option) props.onChange(option.value)
    }

    return (
        <div className="relative rounded-[24px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-lg">
            {selected ? (
                <button type="button" aria-label={t('misc.reasoningEffort')} disabled={props.disabled} onClick={props.onEffort} className="mx-auto flex items-center gap-2 text-base font-medium text-[var(--app-link)] disabled:opacity-50">
                    {unavailableOption ? `${unavailableOption.label} · ${t('composer.effortUnavailable')}` : selected.label}<span aria-hidden="true">›</span>
                </button>
            ) : null}
            <button type="button" aria-label={t('misc.model')} disabled={props.disabled || !props.onModel} onClick={props.onModel} className="mx-auto mt-1 block max-w-full truncate px-3 text-sm text-[var(--app-hint)] disabled:opacity-50">
                {props.modelLabel}
            </button>
            {selected ? (
                <>
                    <button type="button" aria-label={t('composer.resetEffort')} title={t('composer.resetEffort')} disabled={props.disabled} onClick={() => props.onChange(null)} className="absolute right-3 top-4 flex h-7 w-7 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M3 10a9 9 0 1 1 3 9M3 4v6h6" /></svg>
                    </button>
                    <div className="relative mt-4 flex h-9 items-center rounded-full bg-[var(--app-secondary-bg)] px-2">
                        <div aria-hidden="true" className="pointer-events-none absolute inset-x-4 flex justify-between">
                            {effortOptions.map(option => <span key={option.value ?? 'default'} className="h-1 w-1 rounded-full bg-[var(--app-hint)]/40" />)}
                        </div>
                        <input type="range" min={0} max={Math.max(0, effortOptions.length - 1)} step={1} value={draftIndex} disabled={props.disabled || effortOptions.length < 2} aria-label={t('misc.reasoningEffort')} aria-valuetext={selected.label}
                            onPointerDown={event => {
                                draggingRef.current = true
                                event.currentTarget.setPointerCapture?.(event.pointerId)
                            }}
                            onPointerUp={() => { draggingRef.current = false; commit() }}
                            onPointerCancel={() => {
                                draggingRef.current = false
                                draftIndexRef.current = selectedIndex
                                setDraftIndex(selectedIndex)
                            }}
                            onChange={event => {
                                draftIndexRef.current = Number(event.target.value)
                                setDraftIndex(draftIndexRef.current)
                                if (!draggingRef.current) commit()
                            }} className="work-effort-slider relative w-full cursor-pointer disabled:cursor-default" />
                    </div>
                </>
            ) : null}
        </div>
    )
}
