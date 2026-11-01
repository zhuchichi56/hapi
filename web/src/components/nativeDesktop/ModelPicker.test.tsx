import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'
const models = [{ id: 'gpt-6.1-sol', reasoningEfforts: ['medium', 'high'] }, { id: 'gpt-6-sol', reasoningEfforts: ['medium', 'high'] }, { id: 'claude-sonnet-5-5', reasoningEfforts: ['medium'] }]
const settings = { model: 'gpt-6.1-sol', reasoningEffort: 'high' }
function fixture() {
    const call = vi.fn(async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
        if (command.op === 'models') return { models }
        if (command.op === 'model-settings') return { id: command.id, ...settings }
        return { id: command.id, model: command.model, reasoningEffort: command.reasoningEffort ?? (command.model === 'claude-sonnet-5-5' ? 'medium' : 'high'), native: true }
    })
    const props = { id: 'original', creating: false, settings, value: '', onChange: vi.fn(), call: call as never, disabled: false, onUpdating: vi.fn(), onUpdated: vi.fn() }
    return { call, props }
}
const trigger = () => screen.getByRole('button', { name: '会话模型' })
async function open(creating = false) {
    fireEvent.click(screen.getByRole('button', { name: creating ? '新会话模型' : '会话模型' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'GPT-6 Sol' })).not.toBeDisabled())
}
afterEach(cleanup)
describe('native model picker', () => {
    it('combines confirmed model and effort into a quiet trigger and one accessible panel', async () => {
        const { call, props } = fixture(); render(<ModelPicker {...props} />)
        expect(trigger()).toHaveTextContent('GPT-6.1 Sol'); expect(trigger()).toHaveTextContent('高')
        expect(screen.queryByRole('dialog')).toBeNull()
        await open()
        expect(screen.getByRole('dialog', { name: '模型与思考强度' })).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'GPT-6.1 Sol' })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByRole('radio', { name: '高' })).toHaveAttribute('aria-checked', 'true')
        expect(call.mock.calls.map(([command]) => command.op)).toEqual(['models'])
    })
    it('lets an unloaded conversation choose without a passive settings request or invented current model', async () => {
        const { call, props } = fixture(); render(<ModelPicker {...props} settings={undefined} historyOnly />)
        expect(trigger()).toHaveTextContent('选择模型')
        await open()
        expect(screen.getAllByRole('radio').every(option => option.getAttribute('aria-checked') === 'false')).toBe(true)
        expect(call.mock.calls.map(([command]) => command.op)).toEqual(['models'])
        fireEvent.click(screen.getByRole('radio', { name: 'Claude Sonnet 5.5' }))
        await waitFor(() => expect(trigger()).toHaveTextContent('Claude Sonnet 5.5'))
        expect(call.mock.calls.at(-1)?.[0]).toMatchObject({ op: 'set-model', id: 'original', model: 'claude-sonnet-5-5' })
        expect(call.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoningEffort')
        expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull()
    })
    it('does not block selection when a passive read reports no live owner', async () => {
        const { call, props } = fixture(); const original = call.getMockImplementation()!
        call.mockImplementation(command => command.op === 'model-settings' ? Promise.resolve({ model: null, reasoningEffort: null, needsActivation: true }) : original(command))
        render(<ModelPicker {...props} settings={undefined} />)
        await open(); expect(trigger()).toHaveTextContent('选择模型'); expect(screen.queryByRole('alert')).toBeNull()
    })
    it('reuses the catalog across chat switches without sharing a different API identity', async () => {
        const { call, props } = fixture()
        const first = render(<ModelPicker {...props} />); await open(); first.unmount()
        const second = render(<ModelPicker {...props} id="another-chat" />); await open(); second.unmount()
        expect(call.mock.calls.filter(([command]) => command.op === 'models')).toHaveLength(1)
        const other = fixture(); render(<ModelPicker {...other.props} />); await open()
        expect(other.call.mock.calls.filter(([command]) => command.op === 'models')).toHaveLength(1)
    })
    it('keeps the confirmed selection during a write, prevents duplicate clicks, and accepts actual native effort', async () => {
        const { call, props } = fixture(); let complete: ((value: unknown) => void) | undefined
        const original = call.getMockImplementation()!
        call.mockImplementation(command => command.op === 'set-model' ? new Promise(resolve => { complete = resolve }) as never : original(command))
        const page = render(<ModelPicker {...props} />); await open()
        const target = screen.getByRole('radio', { name: 'GPT-6 Sol' })
        fireEvent.click(target); fireEvent.click(target)
        expect(trigger()).toHaveTextContent('GPT-6.1 Sol'); expect(screen.getByRole('radio', { name: 'GPT-6.1 Sol' })).toHaveAttribute('aria-checked', 'true')
        expect(call.mock.calls.filter(([command]) => command.op === 'set-model')).toHaveLength(1)
        expect(call.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoningEffort')
        // A snapshot arriving during the write must not become the confirmed selection.
        page.rerender(<ModelPicker {...props} settings={{ model: 'claude-sonnet-5-5', reasoningEffort: 'medium' }} />)
        expect(trigger()).toHaveTextContent('GPT-6.1 Sol')
        complete!({ id: 'original', model: 'gpt-6-sol', reasoningEffort: 'medium', native: true })
        await waitFor(() => expect(trigger()).toHaveTextContent('GPT-6 Sol'))
        expect(trigger()).toHaveTextContent('中'); expect(props.onUpdating.mock.calls.map(([busy]) => busy)).toEqual([true, false])
    })
    it('shows compatible-effort hints while the App chooses from its actual settings', async () => {
        const { call, props } = fixture(); render(<ModelPicker {...props} />); await open()
        const target = screen.getByRole('radio', { name: 'Claude Sonnet 5.5 强度 · 中' })
        expect(target).toHaveAttribute('title', 'claude-sonnet-5-5'); fireEvent.click(target)
        await waitFor(() => expect(trigger()).toHaveTextContent('Claude Sonnet 5.5'))
        expect(trigger()).toHaveTextContent('中'); expect(call.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoningEffort')
    })
    it('writes an explicit supported effort to the same original native conversation', async () => {
        const { call, props } = fixture(); render(<ModelPicker {...props} />); await open()
        fireEvent.click(screen.getByRole('radio', { name: '中' }))
        await waitFor(() => expect(trigger()).toHaveTextContent('中'))
        expect(call.mock.calls.at(-1)?.[0]).toMatchObject({ op: 'set-model', id: 'original', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
        expect(props.onUpdated).toHaveBeenCalledOnce()
    })
    it.each([
        { id: 'wrong', model: 'gpt-6-sol', reasoningEffort: 'high', native: true },
        { id: 'original', model: 'gpt-6.1-sol', reasoningEffort: 'high', native: true },
        { id: 'original', model: 'gpt-6-sol', reasoningEffort: 'ultra', native: true },
        { id: 'original', model: 'gpt-6-sol', reasoningEffort: 'high', native: false },
    ])('refuses an unconfirmed native result: %j', async result => {
        const { call, props } = fixture(); const original = call.getMockImplementation()!
        call.mockImplementation(command => command.op === 'set-model' ? Promise.resolve(result) : original(command))
        render(<ModelPicker {...props} />); await open(); fireEvent.click(screen.getByRole('radio', { name: 'GPT-6 Sol' }))
        await screen.findByRole('alert'); expect(trigger()).toHaveTextContent('设置待确认'); expect(props.onUpdated).not.toHaveBeenCalled()
    })
    it('recovery always reads history-only native settings and never replays an uncertain write', async () => {
        const { call, props } = fixture(); const original = call.getMockImplementation()!
        call.mockImplementation(command => command.op === 'set-model' ? Promise.reject(Error('Result unknown')) : original(command))
        render(<ModelPicker {...props} historyOnly settings={undefined} />); await open()
        fireEvent.click(screen.getByRole('radio', { name: 'GPT-6 Sol' })); await screen.findByRole('alert')
        fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
        expect(trigger()).toHaveTextContent('GPT-6.1 Sol')
        expect(call.mock.calls.some(([command]) => command.op === 'model-settings' && command.id === 'original')).toBe(true)
        expect(call.mock.calls.filter(([command]) => command.op === 'set-model')).toHaveLength(1)
    })
    it('new chats retain the desktop default and select a draft model without native writes', async () => {
        const { call, props } = fixture(); render(<ModelPicker {...props} creating settings={undefined} />); await open(true)
        expect(screen.getByRole('button', { name: '新会话模型' })).toHaveTextContent('桌面默认')
        fireEvent.click(screen.getByRole('radio', { name: 'GPT-6 Sol' }))
        expect(props.onChange).toHaveBeenCalledWith('gpt-6-sol'); expect(call.mock.calls.every(([command]) => command.op === 'models')).toBe(true)
    })
    it('arrow navigation and Escape never change settings; selected options do not write again', async () => {
        const { call, props } = fixture(); render(<ModelPicker {...props} />); await open()
        const group = screen.getByRole('radiogroup', { name: '模型' })
        const first = screen.getByRole('radio', { name: 'GPT-6.1 Sol' }); first.focus()
        fireEvent.keyDown(group, { key: 'ArrowDown' }); expect(screen.getByRole('radio', { name: 'GPT-6 Sol' })).toHaveFocus()
        fireEvent.keyDown(group, { key: 'Home' }); expect(first).toHaveFocus()
        fireEvent.click(first); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        await open(); fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(call.mock.calls.every(([command]) => command.op === 'models')).toBe(true)
    })
    it('updates from native snapshots and ignores a late write from an unmounted chat', async () => {
        const { call, props } = fixture(); let complete: ((value: unknown) => void) | undefined
        const page = render(<ModelPicker {...props} />)
        page.rerender(<ModelPicker {...props} settings={{ model: 'gpt-6-sol', reasoningEffort: 'medium' }} />)
        expect(trigger()).toHaveTextContent('GPT-6 Sol'); await open()
        const original = call.getMockImplementation()!
        call.mockImplementation(command => command.op === 'set-model' ? new Promise(resolve => { complete = resolve }) as never : original(command))
        fireEvent.click(screen.getByRole('radio', { name: 'GPT-6.1 Sol' })); page.unmount()
        render(<ModelPicker {...props} id="another-chat" />)
        await act(async () => { complete!({ id: 'original', model: 'gpt-6.1-sol', reasoningEffort: 'medium', native: true }) })
        expect(trigger()).toHaveTextContent('高'); expect(props.onUpdated).not.toHaveBeenCalled()
    })
})
