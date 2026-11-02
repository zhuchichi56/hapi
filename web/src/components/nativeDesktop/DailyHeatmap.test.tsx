import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DailyHeatmap } from './DailyHeatmap'
import type { ActivitySnapshot } from './DailyHeatmap'

afterEach(cleanup)

function fixture(): ActivitySnapshot {
    return {
        asOf: '2026-11-02T00:10:00+08:00', today: '2026-11-02', from: '2026-08-11', to: '2026-11-02',
        coverage: { dispatchFrom: '2026-11-01', completion: 'explicit-attestations-only' },
        days: Array.from({ length: 84 }, (_, index) => {
            const date = new Date(Date.UTC(2026, 7, 11 + index)).toISOString().slice(0, 10)
            return { date, recorded: date >= '2026-11-01', completions: [], dispatches: date === '2026-11-02'
                ? [{ taskId: 'task-a', title: 'Synthetic alpha', threadId: 'thread a&b', eventId: 'dispatch:synthetic' }] : [] }
        }),
    }
}

describe('DailyHeatmap', () => {
    it('shows 84 days, toggles metrics, and distinguishes unknown completion zero', () => {
        render(<DailyHeatmap activity={fixture()} />)
        const calendar = screen.getByRole('group', { name: '每日活动日历' })
        expect(within(calendar).getAllByRole('button')).toHaveLength(84)
        expect(screen.getByText('1 已确认', { selector: 'strong' })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: '完成' }))
        expect(screen.getByText('无记录', { selector: 'strong' })).toBeTruthy()
        expect(screen.getByRole('button', { name: '完成' }).getAttribute('aria-pressed')).toBe('true')
        expect(screen.getByRole('button', { name: /2026-11-02 北京时间 · 完成 0 已确认 · 覆盖未知/ }).title).toContain('覆盖未知')
    })

    it('opens compact day details and links to the original Desktop thread', () => {
        const { container } = render(<DailyHeatmap activity={fixture()} />)
        const details = container.querySelector('details')!
        expect(details.open).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: /2026-11-02 北京时间 · 派遣 1 已确认/ }))
        expect(details.open).toBe(true)
        expect(within(details).getByText('task-a')).toBeTruthy()
        expect(within(details).getByRole('link', { name: /Synthetic alpha/ }).getAttribute('href'))
            .toBe('/desktop?app=codex&thread=thread%20a%26b')
    })

    it('supports keyboard day selection and unknown history tooltips', () => {
        render(<DailyHeatmap activity={fixture()} />)
        const today = screen.getByRole('button', { name: /2026-11-02 北京时间 · 派遣/ })
        today.focus()
        fireEvent.keyDown(today, { key: 'ArrowLeft' })
        const previous = screen.getByRole('button', { name: /2026-10-26 北京时间 · 派遣 无记录/ })
        expect(document.activeElement).toBe(previous)
        expect(previous.getAttribute('aria-pressed')).toBe('true')
        expect(previous.title).toContain('无记录')
    })

    it('uses only refreshed props and preserves a selected day', () => {
        const activity = fixture()
        const { rerender } = render(<DailyHeatmap activity={activity} />)
        fireEvent.click(screen.getByRole('button', { name: /2026-11-01 北京时间 · 派遣/ }))
        const refreshed = structuredClone(activity)
        refreshed.days[83].dispatches = []
        rerender(<DailyHeatmap activity={refreshed} />)
        expect(screen.getByRole('button', { name: /2026-11-01 北京时间 · 派遣/ }).getAttribute('aria-pressed')).toBe('true')
        expect(screen.getByText('0 已确认', { selector: 'strong' })).toBeTruthy()
    })

    it('shows explicit availability failure without rendering fabricated zeros', () => {
        render(<DailyHeatmap activity={{ available: false, error: 'activity_unavailable' }} />)
        expect(screen.getByRole('status').textContent).toBe('活动记录暂不可用')
        expect(screen.queryByRole('group', { name: '每日活动日历' })).toBeNull()
    })
})
