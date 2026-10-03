import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import type { ComposerToolbarLayout } from '@/hooks/useComposerToolbarLayout'
import { HappyComposer } from './HappyComposer'

/**
 * Focused harness for the generic model/effort value buttons and the
 * settings-sheet section order. Reuses the assistant-ui mock strategy from
 * HappyComposer.sendError.test.tsx but keeps ComposerButtons unmocked so the
 * new value buttons are exercised for real.
 */
type FakeAttachment = { id: string; status: { type: 'complete' } }
type MockComposerInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
    asChild?: boolean
    maxRows?: number
    submitOnEnter?: boolean
    cancelOnEscape?: boolean
}
type FakeRuntimeState = {
    composer: { text: string; attachments: FakeAttachment[] }
    thread: { isRunning: boolean; isDisabled: boolean }
}

const runtime = vi.hoisted(() => ({
    snapshot: {
        composer: { text: '', attachments: [] as FakeAttachment[] },
        thread: { isRunning: false, isDisabled: false },
    } as FakeRuntimeState,
    setSnapshot: null as null | ((updater: (current: FakeRuntimeState) => FakeRuntimeState) => void),
    pendingSendIntentRef: { current: 'default' },
    sentIntents: [] as ComposerSendIntent[],
    narrowViewport: false,
    toolbarLayout: null as ComposerToolbarLayout | null,
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        useAui: () => ({
            composer: () => ({
                setText: (text: string) => {
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { ...current.composer, text },
                    }))
                },
                send: () => {
                    const intent = runtime.pendingSendIntentRef?.current ?? 'default'
                    runtime.sentIntents.push(intent as ComposerSendIntent)
                    if (runtime.pendingSendIntentRef) runtime.pendingSendIntentRef.current = 'default'
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { text: '', attachments: [] },
                    }))
                },
                addAttachment: async () => {},
            }),
            thread: () => ({ cancelRun: () => {} }),
        }),
        useAuiState: (selector: (state: typeof runtime.snapshot) => unknown) => selector(runtime.snapshot),
        ComposerPrimitive: {
            Root: ({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) => (
                <form onSubmit={onSubmit}>{children}</form>
            ),
            AddAttachment: ({ children }: { children: ReactNode }) => <>{children}</>,
            Input: React.forwardRef<HTMLTextAreaElement, MockComposerInputProps>(
                ({
                    asChild: _asChild,
                    onChange,
                    maxRows: _maxRows,
                    submitOnEnter: _submitOnEnter,
                    cancelOnEscape: _cancelOnEscape,
                    ...props
                }, ref) => (
                    <textarea
                        {...props}
                        ref={ref}
                        value={runtime.snapshot.composer.text}
                        onChange={(event) => {
                            runtime.setSnapshot!((current) => ({
                                ...current,
                                composer: { ...current.composer, text: event.target.value },
                            }))
                        }}
                    />
                ),
            ),
        },
    }
})
vi.mock('@/hooks/useComposerToolbarLayout', async () => {
    const actual = await import('@/hooks/useComposerToolbarLayout')
    return {
        ...actual,
        useComposerToolbarLayout: () => ({ layout: runtime.toolbarLayout ?? actual.DEFAULT_COMPOSER_TOOLBAR_LAYOUT }),
    }
})
vi.mock('@/hooks/useNarrowViewport', () => ({
    useNarrowViewport: () => runtime.narrowViewport,
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: () => ({ sessionId: undefined, complete: true, restoredAny: false, hasStoredAttachments: false }),
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({ useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: () => {}, notification: () => {} }, isTouch: false }) }))
vi.mock('@/hooks/usePWAInstall', () => ({ usePWAInstall: () => ({ isStandalone: false, isIOS: false }) }))
vi.mock('@/hooks/useActiveWord', () => ({ useActiveWord: () => null }))
vi.mock('@/hooks/useActiveSuggestions', () => ({ useActiveSuggestions: () => [[], -1, () => {}, () => {}, () => {}] }))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({ FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/ChatInput/Autocomplete', () => ({ Autocomplete: () => null }))
vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))

function renderComposer(agentFlavor: string, overrides: Partial<Parameters<typeof HappyComposer>[0]> = {}) {
    render(
        <I18nProvider>
            <HappyComposer
                sessionId="composer-test"
                disabled={false}
                agentFlavor={agentFlavor}
                model="claude-sonnet-4"
                effort="high"
                permissionMode="default"
                onModelChange={vi.fn()}
                onEffortChange={vi.fn()}
                onPermissionModeChange={vi.fn()}
                availableModelOptions={[{ value: 'claude-sonnet-4', label: 'Sonnet 4' }]}
                pendingSendIntentRef={runtime.pendingSendIntentRef as { current: ComposerSendIntent }}
                {...overrides}
            />
        </I18nProvider>
    )
}

describe('HappyComposer generic model/effort value buttons', () => {
    afterEach(() => {
        cleanup()
        runtime.setSnapshot = null
        runtime.narrowViewport = false
        runtime.toolbarLayout = null
        runtime.snapshot.thread.isDisabled = false
        runtime.sentIntents = []
    })

    it('keeps only the four primary controls in the default toolbar', () => {
        renderComposer('claude')
        const toolbar = screen.getByTestId('composer-compact-toolbar')
        expect(within(toolbar).getAllByRole('button')).toHaveLength(4)
        expect(screen.getByRole('button', { name: 'Sonnet 4 · High' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Expand message editor' })).toBeNull()
    })

    it('keeps the combined selector reachable on narrow viewports', () => {
        runtime.narrowViewport = true
        renderComposer('claude')
        fireEvent.click(screen.getByRole('button', { name: 'Sonnet 4 · High' }))
        expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy()
        expect(screen.getByRole('slider', { name: 'Reasoning Effort' })).toBeTruthy()
    })

    it('shows only the model value for flavors without an effort callback', () => {
        renderComposer('codex')
        expect(screen.getByRole('button', { name: 'Sonnet 4' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
    })

    it('opens a compact model summary and effort slider without the permission section', () => {
        renderComposer('claude')
        fireEvent.click(screen.getByRole('button', { name: 'Sonnet 4 · High' }))
        expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy()
        expect(screen.getByRole('slider', { name: 'Reasoning Effort' })).toBeTruthy()
        expect(screen.queryByText('Permission Mode')).toBeNull()
    })

    it('opens only permission settings from the permission chip', () => {
        renderComposer('claude')
        fireEvent.click(screen.getByRole('button', { name: 'Default' }))
        expect(screen.getByText('Permission Mode')).toBeTruthy()
        expect(screen.queryByText('Model')).toBeNull()
        expect(screen.queryByText('Effort')).toBeNull()
    })

    it('keeps full settings reachable from the plus menu', () => {
        renderComposer('claude')
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
        const model = screen.getByText('Model')
        const permission = screen.getByText('Permission Mode')
        expect(model.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(screen.getByText('Effort')).toBeTruthy()
    })

    it('switches between the combined selector and permission without closing the sheet', () => {
        renderComposer('claude')
        fireEvent.click(screen.getByRole('button', { name: 'Sonnet 4 · High' }))
        expect(screen.getByRole('slider', { name: 'Reasoning Effort' })).toBeTruthy()
        fireEvent.click(within(screen.getByTestId('composer-compact-toolbar')).getByRole('button', { name: 'Default' }))
        expect(screen.getByText('Permission Mode')).toBeTruthy()
        expect(screen.queryByText('Model')).toBeNull()
        expect(screen.queryByText('Effort')).toBeNull()
    })

    it('changes reasoning effort through the compact slider', () => {
        const onChange = vi.fn()
        renderComposer('codex', { modelReasoningEffort: 'medium', onModelReasoningEffortChange: onChange })
        fireEvent.click(screen.getByRole('button', { name: 'Sonnet 4 · Medium' }))
        const slider = screen.getByRole('slider', { name: 'Reasoning Effort' })
        fireEvent.change(slider, { target: { value: Number(slider.getAttribute('max')) } })
        expect(onChange).toHaveBeenCalledWith('xhigh')
    })

    it('commits only the final slider position and keeps the panel open', () => {
        const onChange = vi.fn()
        renderComposer('codex', { modelReasoningEffort: 'medium', onModelReasoningEffortChange: onChange })
        fireEvent.click(screen.getByRole('button', { name: 'Sonnet 4 · Medium' }))
        const slider = screen.getByRole('slider')
        fireEvent.pointerDown(slider, { pointerId: 1 })
        fireEvent.change(slider, { target: { value: 1 } })
        fireEvent.change(slider, { target: { value: Number(slider.getAttribute('max')) } })
        expect(onChange).not.toHaveBeenCalled()
        fireEvent.pointerUp(slider, { pointerId: 1 })
        expect(onChange).toHaveBeenCalledOnce()
        expect(onChange).toHaveBeenCalledWith('xhigh')
        expect(screen.getByRole('slider')).toBe(slider)
    })

    it('shows generic value buttons for Pi with the provider-qualified model label', () => {
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
                { provider: 'vertex', modelId: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
        })
        // Pi uses the same value buttons as every other flavor.
        expect(screen.getByRole('button', { name: 'Gemini 2.5 Pro · High' })).toBeTruthy()
    })

    it('opens the settings sheet with provider-grouped model rows for Pi', () => {
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
                { provider: 'vertex', modelId: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Gemini 2.5 Pro · High' }))
        fireEvent.click(screen.getByRole('button', { name: 'Model' }))
        expect(screen.getByText('Model')).toBeTruthy()
        // The value button label and the matching sheet row share the model name.
        expect(screen.getByText('Gemini 2.5 Pro')).toBeTruthy()
        expect(screen.getByText('Vertex Gemini 2.5 Pro')).toBeTruthy()
        // Provider selection keeps the effort list in its separate detail view.
        expect(screen.queryByText('Effort')).toBeNull()
    })

    it('keeps the combined selector reachable even when the saved layout hides settings', () => {
        runtime.narrowViewport = true
        runtime.toolbarLayout = {
            mode: 'left',
            left: ['attachment', 'expand', 'terminal'],
            right: [],
            hidden: ['settings', 'abort'],
        }
        renderComposer('claude')
        // The primary selector stays reachable independently of menu preferences.
        expect(screen.getByRole('button', { name: 'Sonnet 4 · High' })).toBeTruthy()
    })

    it('keeps the Pi selector live mid-turn on narrow viewports', () => {
        runtime.narrowViewport = true
        runtime.snapshot.thread.isDisabled = true
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
        })
        // Configuration stays clickable while a Pi turn is running (#1442).
        const gear = screen.getByRole('button', { name: 'Gemini 2.5 Pro · High' })
        expect(gear).not.toBeDisabled()
        fireEvent.click(gear)
        fireEvent.click(screen.getByRole('button', { name: 'Model' }))
        expect(screen.getByText('Model')).toBeTruthy()
        expect(screen.getByText('Gemini 2.5 Pro')).toBeTruthy()
    })

    it('highlights only the matching provider row when model IDs collide across providers', () => {
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
                { provider: 'vertex', modelId: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'vertex', modelId: 'gemini-2.5-pro' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Vertex Gemini 2.5 Pro · High' }))
        fireEvent.click(screen.getByRole('button', { name: 'Model' }))
        const sheetRow = (name: string) => screen.getAllByText(name)
            .map((el) => el.closest('button'))
            .find((btn) => btn?.className.includes('w-full'))!
        const geminiRow = sheetRow('Gemini 2.5 Pro')
        const vertexRow = sheetRow('Vertex Gemini 2.5 Pro')
        const selectedClass = 'text-[var(--app-link)]'
        expect(geminiRow.querySelector('span')!.className).not.toContain(selectedClass)
        expect(vertexRow.querySelector('span')!.className).toContain(selectedClass)
    })

    it('does not show provider-less model rows when the Pi catalog is empty', () => {
        renderComposer('pi', {
            model: 'gemini-2.5-pro',
            piModels: [],
            piSelectedModel: null,
        })
        // Without a resolved catalog there are no model or effort settings at
        // all: the gear is hidden and no provider-less fallback rows can be
        // reached (selecting one would post a bare model id the Pi runner
        // cannot resolve to a provider).
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
        expect(screen.queryByText('Model')).toBeNull()
        expect(screen.queryByText('Default')).toBeNull()
    })

    it('clears Cursor variant drill-down when the sheet is closed through the value button', () => {
        renderComposer('cursor', {
            model: 'composer-2.5-fast',
            selectedModelBase: 'composer-2.5',
            availableModelOptions: [
                { value: 'composer-2.5', label: 'Composer 2.5' },
                { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
                { value: 'composer-2.5-mini', label: 'Composer 2.5 Mini' },
            ],
            resolveModelVariantsForBase: (base) => base === 'composer-2.5'
                ? [
                    { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
                    { value: 'composer-2.5-mini', label: 'Composer 2.5 Mini' },
                ]
                : [],
        })
        // Open from the value button (label resolves to the selected base).
        const valueButton = screen.getByRole('button', { name: 'Composer 2.5' })
        fireEvent.click(valueButton)
        fireEvent.click(screen.getByRole('button', { name: 'Model' }))
        // Drill into the multi-variant base row: the Model section is replaced
        // by the variant sub-list with a back control.
        const baseRow = screen.getAllByRole('button', { name: 'Composer 2.5' })
            .find((btn) => btn.className.includes('w-full'))!
        fireEvent.click(baseRow)
        expect(screen.queryByText('Model')).toBeNull()
        expect(screen.getByText('← Models')).toBeTruthy()
        // Close and reopen through the value button: drill-down must reset to
        // the base model list (same behavior as the gear toggle).
        fireEvent.click(valueButton)
        fireEvent.click(valueButton)
        fireEvent.click(screen.getByRole('button', { name: 'Model' }))
        expect(screen.queryByText('← Models')).toBeNull()
        expect(screen.getByText('Model')).toBeTruthy()
    })

    it('exposes no effort action while the Pi catalog is unresolved mid-turn', () => {
        runtime.snapshot.thread.isDisabled = true
        renderComposer('pi', {
            model: 'gemini-2.5-pro',
            piModels: [],
            piSelectedModel: null,
        })
        // With no resolved catalog entry there is no capability map, so no
        // effort value button and no gear that could open an effort sheet
        // (the old dedicated control was disabled in this state too). The
        // model value button must not render either: a bare session id has no
        // provider and the sheet has no Model section to open.
        expect(screen.queryByRole('button', { name: 'gemini-2.5-pro' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
    })

    it('clears the Pi thinking level when the selected effort row is clicked again', () => {
        const effortChanges: Array<string | null> = []
        renderComposer('pi', {
            effort: 'high',
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
            onEffortChange: (level) => effortChanges.push(level),
        })
        // Open effort details, then re-click the selected effort row.
        fireEvent.click(screen.getByRole('button', { name: 'Gemini 2.5 Pro · High' }))
        fireEvent.click(screen.getByRole('button', { name: 'Reasoning Effort' }))
        const effortRows = screen.getAllByRole('button', { name: 'High' })
        expect(effortRows).toHaveLength(1)
        // The sheet renders before the toolbar in the DOM, so the first match is the row.
        fireEvent.click(effortRows[0])
        expect(effortChanges).toEqual([null])
    })

    it('re-evaluates the Pi sheet row disabled state when configuration controls change', () => {
        const common = {
            sessionId: 'composer-test',
            disabled: false,
            agentFlavor: 'pi' as const,
            model: 'gemini-2.5-pro',
            effort: 'high' as const,
            permissionMode: 'default' as const,
            onModelChange: vi.fn(),
            onEffortChange: vi.fn(),
            onPermissionModeChange: vi.fn(),
            piModels: [{ provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true }],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
            pendingSendIntentRef: runtime.pendingSendIntentRef as { current: ComposerSendIntent },
        }
        const { rerender } = render(
            <I18nProvider>
                <HappyComposer {...common} active={true} />
            </I18nProvider>
        )
        // Open the sheet while controls are live.
        fireEvent.click(screen.getByRole('button', { name: 'Gemini 2.5 Pro · High' }))
        fireEvent.click(screen.getByRole('button', { name: 'Model' }))
        const sheetRow = () => screen.getAllByRole('button', { name: 'Gemini 2.5 Pro' })
            .find((btn) => btn.className.includes('w-full'))!
        expect(sheetRow()).not.toBeDisabled()
        // Inactive session disables configuration controls; the sheet rows must follow.
        rerender(
            <I18nProvider>
                <HappyComposer {...common} active={false} />
            </I18nProvider>
        )
        expect(sheetRow()).toBeDisabled()
    })

    it('maps the default selection (model=null) onto the localized default option label', () => {
        renderComposer('claude', { model: null })
        expect(screen.getByRole('button', { name: 'Default · High' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Sonnet 4' })).toBeNull()
    })

    it('maps auto/default wire values onto the localized default option label', () => {
        renderComposer('claude', { model: 'auto' })
        expect(screen.getByRole('button', { name: 'Default · High' })).toBeTruthy()
    })

    it('toggles the settings sheet closed when the model value button is clicked again', () => {
        renderComposer('claude')
        const modelButton = screen.getByRole('button', { name: 'Sonnet 4 · High' })
        fireEvent.click(modelButton)
        expect(screen.getByRole('slider')).toBeTruthy()
        fireEvent.click(modelButton)
        expect(screen.queryByRole('slider')).toBeNull()
    })

    it('toggles the settings sheet closed when the effort value button is clicked again', () => {
        renderComposer('claude')
        const effortButton = screen.getByRole('button', { name: 'Sonnet 4 · High' })
        fireEvent.click(effortButton)
        expect(screen.getByRole('slider')).toBeTruthy()
        fireEvent.click(effortButton)
        expect(screen.queryByRole('slider')).toBeNull()
    })
})
