import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import styles from './segmented-control.module.css'

// Adapted from Arc Library's MIT segmented control for the two native Apps.
export interface Segment {
    value: string
    label: string
    accessory?: ReactNode
    notify?: boolean
    onAnimationEnd?: () => void
}

export interface SegmentedControlProps {
    options: Segment[]
    value: string
    onValueChange: (value: string) => void
    label?: string
    onOptionIntent?: (value: string) => void
    className?: string
    disabled?: boolean
}

export default function SegmentedControl({ options, value, onValueChange, label, onOptionIntent, className, disabled = false }: SegmentedControlProps) {
    const id = useId()
    const track = useRef<HTMLDivElement>(null)
    const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (disabled) return
        const last = options.length - 1
        const target = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (selectedIndex === last ? 0 : selectedIndex + 1)
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (selectedIndex === 0 ? last : selectedIndex - 1)
                : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1
        if (target < 0 || !options[target]) return
        event.preventDefault()
        onValueChange(options[target].value)
        track.current?.querySelectorAll<HTMLButtonElement>('button')[target]?.focus({ preventScroll: true })
    }

    return <div className={`${styles.root} ${className ?? ''}`} role="group" aria-label={label}>
        <div ref={track} className={styles.track} style={{ '--selected-index': selectedIndex, '--segment-count': options.length } as CSSProperties}>
            <span className={styles.selection} aria-hidden="true" />
            {options.map((option, index) => <button key={option.value} id={`${id}-${option.value}`} className={styles.button} type="button"
                data-value={option.value} data-notify={!!option.notify} aria-pressed={value === option.value}
                tabIndex={index === selectedIndex ? 0 : -1} disabled={disabled} onClick={() => onValueChange(option.value)}
                onKeyDown={onKeyDown} onAnimationEnd={option.onAnimationEnd}
                onPointerEnter={onOptionIntent ? () => onOptionIntent(option.value) : undefined}
                onFocus={onOptionIntent ? () => onOptionIntent(option.value) : undefined}>
                <span className={styles.label}>{option.label}{option.accessory}</span>
            </button>)}
        </div>
    </div>
}
