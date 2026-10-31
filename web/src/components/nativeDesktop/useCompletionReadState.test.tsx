import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { useCompletionReadState } from './useCompletionReadState'
import { AgentActivity } from './AgentActivity'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })
const entry = { id: 'chat', updatedAt: 100 }
it('dismisses a viewed completion, persists on reload and separates apps, accounts and services', () => {
    const first = renderHook(() => useCompletionReadState('account@service'))
    expect(first.result.current.unread('codex', entry)).toBe(true)
    act(() => first.result.current.markRead('codex', entry))
    expect(first.result.current.unread('codex', entry)).toBe(false)
    expect(first.result.current.unread('claude', entry)).toBe(true)
    first.unmount()
    const next = renderHook(({ scope }) => useCompletionReadState(scope), { initialProps: { scope: 'account@service' } })
    expect(next.result.current.unread('codex', entry)).toBe(false)
    next.rerender({ scope: 'other@service' }); expect(next.result.current.unread('codex', entry)).toBe(true)
    next.rerender({ scope: 'account@other-service' }); expect(next.result.current.unread('codex', entry)).toBe(true)
    next.rerender({ scope: 'account@service' }); expect(next.result.current.unread('codex', entry)).toBe(false)
})
it('notifies for the next observed run even when the native timestamp does not change', () => {
    const { result } = renderHook(() => useCompletionReadState('runs'))
    act(() => result.current.markRead('codex', entry))
    expect(result.current.unread('codex', { ...entry, updatedAt: 101 })).toBe(true)
    act(() => result.current.observeRunning('claude', [entry.id]))
    expect(result.current.unread('codex', entry)).toBe(false)
    act(() => result.current.observeRunning('codex', [entry.id]))
    expect(result.current.unread('codex', entry)).toBe(true)
    act(() => result.current.markRead('codex', entry))
    expect(result.current.unread('codex', entry)).toBe(false)
})
it('keeps dismissing in memory when browser storage is unavailable or malformed', () => {
    localStorage.setItem('hapi-native-completion-read-v1:broken', 'invalid-json')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('unavailable') })
    const { result } = renderHook(() => useCompletionReadState('broken'))
    act(() => result.current.markRead('codex', entry))
    expect(result.current.unread('codex', entry)).toBe(false)
})
it('renders exactly one tiny square per running agent, removes finished agents and hides an empty group', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: String(i), title: `Task ${i}`, number: i + 1, state: 'running' }))
    const { rerender } = render(<AgentActivity delegations={{ running: 5, tasks: [...tasks, { id: 'old', title: 'Finished', state: 'completed' }] }} />)
    expect(screen.getByRole('img', { name: '5 个子 Agent 正在运行' }).children).toHaveLength(5)
    rerender(<AgentActivity delegations={{ running: 1, tasks: tasks.map((task, i) => ({ ...task, state: i ? 'completed' : 'running' })) }} />)
    expect(screen.getByRole('img', { name: '1 个子 Agent 正在运行' }).children).toHaveLength(1)
    rerender(<AgentActivity delegations={{ running: 0, tasks: [] }} />)
    expect(screen.queryByRole('img')).toBeNull()
})
