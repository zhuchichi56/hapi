import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'
const models = [{ id: 'gpt-6.1-sol', reasoningEfforts: ['medium', 'high'] }, { id: 'gpt-6-sol', reasoningEfforts: ['medium', 'high'] }, { id: 'claude-sonnet-5-5', reasoningEfforts: ['medium'] }]
const settings = { model: 'gpt-6.1-sol', reasoningEffort: 'high' }
function fixture() {
    const call = vi.fn(async (command: Record<string, unknown>) => {
        if (command.op === 'models') return { models }
        if (command.op === 'model-settings') return { id: 'original', ...settings }
        return { id: command.id, model: command.model, reasoningEffort: command.reasoningEffort, native: true }
    })
    const props = { id: 'original', creating: false, settings, value: '', onChange: vi.fn(), call: call as never, disabled: false, onUpdating: vi.fn(), onUpdated: vi.fn() }
    return { call, props }
}
afterEach(cleanup)
describe('native model picker', () => {
    it('reuses the catalog across chat switches without reusing a different API identity', async () => {
        const { call, props } = fixture()
        const first = render(<ModelPicker {...props} />)
        await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled())
        first.unmount()
        const second = render(<ModelPicker {...props} id="another-chat" />)
        await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled())
        expect(call.mock.calls.filter(([command]) => command.op === 'models')).toHaveLength(1)
        second.unmount()
        const other = fixture()
        render(<ModelPicker {...other.props} />)
        await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled())
        expect(other.call.mock.calls.filter(([command]) => command.op === 'models')).toHaveLength(1)
    })
    it('shows native settings, confirms switches and preserves compatible effort', async () => {
        const { call, props } = fixture()
        let complete: ((value: unknown) => void) | undefined
        const original = call.getMockImplementation()!
        call.mockImplementation(command => command.op === 'set-model' ? new Promise(resolve => { complete = resolve }) as never : original(command))
        render(<ModelPicker {...props} />)
        const select = screen.getByRole('combobox', { name: '会话模型' })
        expect(select).toHaveValue('gpt-6.1-sol')
        await waitFor(() => expect(select).not.toBeDisabled())
        fireEvent.change(select, { target: { value: 'gpt-6-sol' } })
        expect(select).toBeDisabled(); expect(select).toHaveValue('gpt-6.1-sol')
        expect(call.mock.calls.at(-1)?.[0]).toMatchObject({ op: 'set-model', id: 'original', model: 'gpt-6-sol', reasoningEffort: 'high' })
        complete!({ id: 'original', model: 'gpt-6-sol', reasoningEffort: 'high', native: true })
        await waitFor(() => expect(select).toHaveValue('gpt-6-sol'))
        expect(props.onUpdating.mock.calls.map(([busy]) => busy)).toEqual([true, false])
        expect(call.mock.calls.some(([command]) => command.op === 'model-settings')).toBe(false)
    })
    it('labels an incompatible model with its new effort before the user chooses it', async () => {
        const { call, props } = fixture(); render(<ModelPicker {...props} />)
        await screen.findByRole('option', { name: 'claude-sonnet-5-5 · medium' })
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'claude-sonnet-5-5' } })
        await waitFor(() => expect(call.mock.calls.at(-1)?.[0]).toMatchObject({ op: 'set-model', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' }))
        await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('claude-sonnet-5-5'))
    })
    it('retains the native model on failure; retry reads settings and never replays the write', async () => {
        const { call, props } = fixture(); const original = call.getMockImplementation()!
        call.mockImplementation(command => command.op === 'set-model' ? Promise.reject(Error('Native settings changed')) : original(command))
        render(<ModelPicker {...props} />)
        await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled())
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gpt-6-sol' } })
        await screen.findByRole('alert')
        expect(screen.getByRole('combobox')).toHaveValue('gpt-6.1-sol')
        fireEvent.click(screen.getByRole('button', { name: '重试' }))
        await waitFor(() => expect(call.mock.calls.filter(([command]) => command.op === 'models')).toHaveLength(2))
        expect(call.mock.calls.some(([command]) => command.op === 'model-settings' && command.id === 'original')).toBe(true)
        expect(call.mock.calls.filter(([command]) => command.op === 'set-model')).toHaveLength(1)
    })
    it('new chats retain the desktop default and do not mutate any existing chat', async () => {
        const { call, props } = fixture(); render(<ModelPicker {...props} creating settings={undefined} />)
        await screen.findByRole('option', { name: 'gpt-6-sol' })
        expect(screen.getByRole('combobox')).toHaveValue('')
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gpt-6-sol' } })
        expect(props.onChange).toHaveBeenCalledWith('gpt-6-sol')
        expect(call.mock.calls.every(([command]) => command.op === 'models')).toBe(true)
    })
    it('updates from native snapshots and ignores a late read from an unmounted chat', async () => {
        const { call, props } = fixture()
        const page = render(<ModelPicker {...props} />)
        page.rerender(<ModelPicker {...props} settings={{ model: 'gpt-6-sol', reasoningEffort: 'medium' }} />)
        expect(screen.getByRole('combobox')).toHaveValue('gpt-6-sol')
        page.unmount()
        let finish: ((value: unknown) => void) | undefined
        const oldCall = vi.fn(command => command.op === 'models' ? Promise.resolve({ models }) : new Promise(resolve => { finish = resolve }))
        const previous = render(<ModelPicker {...props} settings={undefined} call={oldCall as never} />)
        previous.unmount()
        render(<ModelPicker {...props} id="another-chat" />)
        finish!({ model: 'claude-sonnet-5-5', reasoningEffort: 'medium' })
        await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('gpt-6.1-sol'))
        expect(call.mock.calls.some(([command]) => command.op === 'set-model')).toBe(false)
    })
})
