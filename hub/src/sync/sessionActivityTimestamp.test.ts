import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { SessionCache } from './sessionCache'
import { shouldRecordSessionActivity } from './sessionActivity'
import type { EventPublisher } from './eventPublisher'

function setup() {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const cache = new SessionCache(store, { emit: (event: SyncEvent) => events.push(event) } as unknown as EventPublisher)
    const session = cache.getOrCreateSession('clock', { path: '/project', host: 'localhost' }, null, 'default')
    return { store, cache, session, events }
}

function copy(store: Store, sessionId: string, content: unknown, at: number) {
    store.messages.copyMessageToSession(sessionId, {
        content, createdAt: at, invokedAt: at, localId: null, scheduledAt: null
    })
}

describe('human-turn conversation clock', () => {
    it('restores historical prompt times through background storage writes and hub restart', () => {
        const { store, cache, session } = setup()
        try {
            const askedAt = Date.now() - 86_400_000
            copy(store, session.id, { role: 'user', content: { type: 'text', text: 'old question' } }, askedAt)
            for (let i = 0; i < 205; i++) {
                copy(store, session.id, { role: 'agent', content: { type: 'text', text: 'output'.repeat(2000) } }, askedAt + i + 1)
            }
            store.sessions.updateSessionMetadata(session.id, { path: '/project', host: 'localhost', name: 'Renamed' }, session.metadataVersion, 'default')
            store.sessions.updateSessionAgentState(session.id, { controlledByUser: true }, session.agentStateVersion, 'default')
            expect(store.sessions.getSession(session.id)!.updatedAt).toBeGreaterThan(askedAt)
            expect(cache.refreshSession(session.id)!.updatedAt).toBe(askedAt)
            const restarted = new SessionCache(store, { emit: () => {} } as unknown as EventPublisher)
            expect(restarted.refreshSession(session.id)!.updatedAt).toBe(askedAt)
            const newerAt = askedAt + 10000
            copy(store, session.id, { role: 'user', content: { type: 'text', text: 'new question' } }, newerAt)
            expect(cache.refreshSession(session.id)!.updatedAt).toBe(newerAt)
            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            expect(cache.getSession(session.id)!.updatedAt).toBe(newerAt)
        } finally { store.close() }
    })

    it('advances on a new question without inheriting a polluted storage timestamp', () => {
        const { store, cache, session, events } = setup()
        try {
            const askedAt = Date.now() - 10_000
            copy(store, session.id, { role: 'user', content: { type: 'text', text: 'question' } }, askedAt)
            cache.refreshSession(session.id)
            store.sessions.touchSessionUpdatedAt(session.id, Date.now() + 60_000, 'default')
            cache.recordSessionActivity(session.id, askedAt + 1000)
            expect(cache.getSession(session.id)!.updatedAt).toBe(askedAt + 1000)
            const last = events.at(-1)
            expect(last?.type).toBe('session-updated')
            if (last?.type === 'session-updated') expect(last.data).toEqual({ updatedAt: askedAt + 1000 })
        } finally { store.close() }
    })

    it('uses creation time for a conversation with no human turns', () => {
        const { store, cache, session } = setup()
        try {
            store.sessions.touchSessionUpdatedAt(session.id, session.createdAt + 60_000, 'default')
            copy(store, session.id, { role: 'agent', content: { type: 'text', text: 'background event' } }, session.createdAt + 1000)
            expect(cache.refreshSession(session.id)!.updatedAt).toBe(session.createdAt)
        } finally { store.close() }
    })
})


it('refreshes the transcript clock after queue invocation and removal', () => {
    const { store, session } = setup()
    try {
        const askedAt = Date.now() - 10000
        copy(store, session.id, { role: 'user', content: { type: 'text', text: 'old' } }, askedAt)
        expect(store.messages.getLatestMatchingMessageAt(session.id, shouldRecordSessionActivity)).toBe(askedAt)
        const queued = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'queued' } }, 'new')
        expect(store.messages.getLatestMatchingMessageAt(session.id, shouldRecordSessionActivity)).toBe(queued.createdAt)
        store.messages.cancelQueuedMessage(session.id, queued.id)
        expect(store.messages.getLatestMatchingMessageAt(session.id, shouldRecordSessionActivity)).toBe(askedAt)
    } finally { store.close() }
})


it('keeps attachment-only human prompts in the historical clock', () => {
    const { store, cache, session } = setup()
    try {
        const askedAt = Date.now() - 60000
        copy(store, session.id, { role: 'user', content: { type: 'text', text: '', attachments: [{ id: 'image' }] } }, askedAt)
        expect(cache.refreshSession(session.id)!.updatedAt).toBe(askedAt)
    } finally { store.close() }
})

it('decodes only appended output after the human clock has been seeded', () => {
    const { store, session } = setup()
    try {
        copy(store, session.id, { role: 'user', content: { type: 'text', text: 'question' } }, 1000)
        for (let i = 0; i < 500; i++) {
            copy(store, session.id, { role: 'agent', content: { type: 'text', text: 'output'.repeat(300) } }, 2000 + i)
        }
        let checked = 0
        const matches = (content: unknown) => { checked++; return shouldRecordSessionActivity(content) }
        expect(store.messages.getLatestMatchingMessageAt(session.id, matches)).toBe(1000)
        expect(checked).toBe(501)
        checked = 0
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'new output' } }, undefined, undefined, 3000)
        expect(store.messages.getLatestMatchingMessageAt(session.id, matches)).toBe(1000)
        expect(checked).toBe(1)
        expect(store.messages.getLatestMatchingMessageAt(session.id, matches)).toBe(1000)
        expect(checked).toBe(1)
        // Imported human turns can be older than the cached display clock.
        copy(store, session.id, { role: 'user', content: { type: 'text', text: 'old imported question' } }, 500)
        expect(store.messages.getLatestMatchingMessageAt(session.id, matches)).toBe(1000)
        copy(store, session.id, { role: 'user', content: { type: 'text', text: 'new question' } }, 4000)
        expect(store.messages.getLatestMatchingMessageAt(session.id, matches)).toBe(4000)
    } finally { store.close() }
})

it('invalidates cached content and human clocks on history rewind', () => {
    const { store, session } = setup()
    try {
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'question' } }, 'rewind-target')
        expect(store.messages.hasConversationContent(session.id)).toBe(true)
        expect(store.messages.getLatestMatchingMessageAt(session.id, shouldRecordSessionActivity)).not.toBeNull()
        store.messages.truncateMessagesFromLocalId(session.id, 'rewind-target')
        expect(store.messages.hasConversationContent(session.id)).toBe(false)
        expect(store.messages.getLatestMatchingMessageAt(session.id, shouldRecordSessionActivity)).toBeNull()
    } finally { store.close() }
})

it('refreshes invocation time even when the consumed user message is behind newer agent output', () => {
    const { store, session } = setup()
    try {
        const queued = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'queued' } }, 'invoke-target')
        copy(store, session.id, { role: 'agent', content: { type: 'text', text: 'later output' } }, queued.createdAt + 5000)
        expect(store.messages.getLatestMatchingMessageAt(session.id, shouldRecordSessionActivity)).toBe(queued.createdAt)
        store.messages.markUninvokedImmediateMessages(session.id, queued.createdAt + 1000)
        expect(store.messages.getLatestMatchingMessageAt(session.id, shouldRecordSessionActivity)).toBe(queued.createdAt + 1000)
    } finally { store.close() }
})


it('does not reuse a positive content check after deleting and recreating the same session ID', () => {
    const { store, session } = setup()
    try {
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'question' } })
        expect(store.messages.hasConversationContent(session.id)).toBe(true)
        store.sessions.deleteSession(session.id, 'default')
        store.sessions.getOrCreateSession('recreated', { path: '/project', host: 'localhost' }, null, 'default', undefined, undefined, undefined, session.id)
        expect(store.messages.hasConversationContent(session.id)).toBe(false)
    } finally { store.close() }
})


it('forgets human clocks when a deleted session ID is reused for a longer transcript', async () => {
    const { store, cache, session } = setup()
    try {
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'question' } })
        cache.refreshSession(session.id)
        await cache.deleteSession(session.id)
        const recreated = cache.getOrCreateSession('recreated-cache', { path: '/project', host: 'localhost' }, null, 'default', undefined, undefined, undefined, session.id)
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'background 1' } })
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'background 2' } })
        expect(store.messages.getLatestMatchingMessageAt(session.id, shouldRecordSessionActivity)).toBeNull()
        expect(cache.refreshSession(session.id)!.updatedAt).toBe(recreated.createdAt)
    } finally { store.close() }
})
