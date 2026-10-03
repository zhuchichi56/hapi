import { describe, expect, it } from 'vitest'
import { getCodexComposerReasoningEffortOptions } from './codexReasoningEffortOptions'

describe('getCodexComposerReasoningEffortOptions', () => {
    it('includes the default option and preset values for Codex', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'codex')).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' }
        ])
    })

    it('preserves non-preset current values for Codex', () => {
        expect(getCodexComposerReasoningEffortOptions('minimal', 'codex')).toEqual([
            { value: null, label: 'Default' },
            { value: 'minimal', label: 'Minimal' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' }
        ])
    })

    it('does not call a stored Ultra effort unavailable before capabilities are known', () => {
        expect(getCodexComposerReasoningEffortOptions('ultra', 'codex'))
            .toContainEqual({ value: 'ultra', label: 'Ultra' })
    })

    it('uses arbitrary model-reported efforts for Codex', () => {
        expect(getCodexComposerReasoningEffortOptions('extreme', 'codex', [
            { value: 'low' },
            { value: 'medium' },
            { value: 'high' },
            { value: 'xhigh' },
            { value: 'max' },
            { value: 'ultra' },
            { value: 'extreme' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
            { value: 'ultra', label: 'Ultra' },
            { value: 'extreme', label: 'Extreme' }
        ])
    })

    it('keeps an unsupported current Codex effort visible but unavailable', () => {
        expect(getCodexComposerReasoningEffortOptions('ultra', 'codex', [
            { value: 'low' },
            { value: 'max' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'ultra', label: 'Ultra', disabled: true },
            { value: 'low', label: 'Low' },
            { value: 'max', label: 'Max' }
        ])
    })

    it('returns no options for OpenCode until dynamic options are available', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'opencode')).toEqual([])
        expect(getCodexComposerReasoningEffortOptions(null, 'opencode', [])).toEqual([])
    })

    it('builds OpenCode options from ACP-reported values', () => {
        expect(getCodexComposerReasoningEffortOptions('low', 'opencode', [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }
        ])
    })

    it('preserves unsupported current OpenCode values in the dropdown', () => {
        expect(getCodexComposerReasoningEffortOptions('high', 'opencode', [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'high', label: 'High', disabled: true },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }
        ])
    })
})
