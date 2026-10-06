import type { Database } from 'bun:sqlite'

import { hasConversationMessageContent } from '@hapi/protocol/messages'
import { decodeMessageContent } from './contentCodec'
import { prepareCached } from './statementCache'

import type { StoredMessage } from './types'
import {
    addMessage,
    syncNativeQueuedMessage,
    addImportedMessage,
    cancelQueuedMessage,
    deleteLiveReasoningSnapshots,
    deleteQueuedMessageById,
    claimIndeterminateMessage,
    lookupQueuedMessage,
    getMessages,
    getFirstMessages,
    getDeliverableMessagesAfter,
    getMessagesByPosition,
    getLatestMatchingMessageAt,
    getMessagesAfterPosition,
    getNewestMessagePosition,
    getMessageEpoch,
    bumpMessageEpoch,
    getLocalMessageStates,
    getUninvokedLocalMessages,
    getMatureScheduledMessages,
    getImmediateQueuedLocalMessages,
    countFutureScheduledBySessionIds,
    countFutureScheduledLocalMessages,
    minFutureScheduledAtBySessionIds,
    countMessages,
    markMessagesInvoked,
    markMessagesIndeterminate,
    setMessagesDeliveryState,
    markUninvokedImmediateMessages,
    mergeSessionMessages,
    moveUninvokedScheduledMessages,
    moveUninvokedMessages,
    copyMessageToSession as copyStoredMessageToSession,
    copyMessagesToSession as copyStoredMessagesToSession,
    getAllMessages,
    getMessagesAfterSeq,
    getMessageSeqById,
    truncateMessagesFromLocalId,
    type CancelQueuedMessageResult,
    type LookupQueuedMessageResult,
    type LocalMessageState,
    type MessagePosition,
} from './messages'

export class MessageStore {
    private readonly db: Database
    private readonly activityClocks = new Map<string, { fingerprint: string; seq: number; epoch: number; matches: (content: unknown) => boolean; at: number | null }>()

    private readonly conversationContent = new Map<string, string>()

    private invalidateTranscript(sessionId: string): void {
        this.activityClocks.delete(sessionId)
        this.conversationContent.delete(sessionId)
    }

    constructor(db: Database) {
        this.db = db
    }

    addMessage(sessionId: string, content: unknown, localId?: string, scheduledAt?: number | null, createdAt?: number): StoredMessage {
        return addMessage(this.db, sessionId, content, localId, scheduledAt, createdAt)
    }

    syncNativeQueuedMessage(sessionId: string, localId: string, text: string): StoredMessage {
        this.activityClocks.delete(sessionId)
        const result = syncNativeQueuedMessage(this.db, sessionId, localId, text)
        this.invalidateTranscript(sessionId)
        return result
    }

    deleteLiveReasoningSnapshots(sessionId: string, streamId: string, keepMessageId?: string): number {
        const result = deleteLiveReasoningSnapshots(this.db, sessionId, streamId, keepMessageId)
        if (result) this.invalidateTranscript(sessionId)
        return result
    }

    addImportedMessage(sessionId: string, content: unknown, localId: string, createdAt: number): { message: StoredMessage; inserted: boolean } {
        return addImportedMessage(this.db, sessionId, content, localId, createdAt)
    }

    copyMessageToSession(
        sessionId: string,
        message: Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>
    ): StoredMessage {
        // 中文注释：重复会话合并时需要保留源消息的时间戳和排队信息，因此走专门的复制入口而不是普通 addMessage。
        return copyStoredMessageToSession(this.db, sessionId, message)
    }

    copyMessagesToSession(
        sessionId: string,
        messages: Array<Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>>
    ): number {
        return copyStoredMessagesToSession(this.db, sessionId, messages)
    }

    getAllMessages(sessionId: string): StoredMessage[] {
        return getAllMessages(this.db, sessionId)
    }

    getMessagesAfterSeq(sessionId: string, afterSeq: number): StoredMessage[] {
        return getMessagesAfterSeq(this.db, sessionId, afterSeq)
    }

    getSeqById(sessionId: string, messageId: string): number | null {
        return getMessageSeqById(this.db, sessionId, messageId)
    }

    getMessages(sessionId: string, limit: number = 200): StoredMessage[] {
        return getMessages(this.db, sessionId, limit)
    }

    getFirstMessages(sessionId: string, limit: number = 50): StoredMessage[] {
        return getFirstMessages(this.db, sessionId, limit)
    }

    getDeliverableMessagesAfter(sessionId: string, afterSeq: number, now: number, limit: number = 200): StoredMessage[] {
        return getDeliverableMessagesAfter(this.db, sessionId, afterSeq, now, limit)
    }

    getLatestMatchingMessageAt(sessionId: string, matches: (content: unknown) => boolean): number | null {
        // Metadata updates repeatedly refresh sessions. Reuse the transcript
        // scan until append, history rewrite, queue edit, or invocation changes it.
        const latestSeq = prepareCached(this.db, 'SELECT MAX(seq) AS seq FROM messages WHERE session_id = ?')
            .get(sessionId) as { seq: number | null }
        const head = this.getNewestMessagePosition(sessionId)
        const seq = latestSeq.seq ?? 0
        const epoch = this.getMessageEpoch(sessionId)
        const fingerprint = `${seq}:${epoch}:${head?.at}:${head?.seq}`
        const cached = this.activityClocks.get(sessionId)
        if (cached?.fingerprint === fingerprint && cached.matches === matches) return cached.at
        // Appended agent output cannot change the human clock. Decode only the
        // new suffix; destructive edits explicitly invalidate this cache.
        let at = cached && cached.matches === matches && cached.epoch === epoch && seq > cached.seq
            ? cached.at
            : getLatestMatchingMessageAt(this.db, sessionId, matches)
        if (cached && cached.matches === matches && cached.epoch === epoch && seq > cached.seq) {
            for (const message of this.getMessagesAfterSeq(sessionId, cached.seq)) {
                if (matches(message.content)) at = Math.max(at ?? -Infinity, message.invokedAt ?? message.createdAt)
            }
        }
        this.activityClocks.set(sessionId, { fingerprint, seq, epoch, matches, at })
        return at
    }

    getMessagesByPosition(sessionId: string, limit: number, before?: { at: number; seq: number }): StoredMessage[] {
        return getMessagesByPosition(this.db, sessionId, limit, before)
    }

    getMessagesAfterPosition(
        sessionId: string,
        limit: number,
        after: MessagePosition,
        until?: MessagePosition
    ): StoredMessage[] {
        return getMessagesAfterPosition(this.db, sessionId, limit, after, until)
    }

    getNewestMessagePosition(sessionId: string): MessagePosition | null {
        return getNewestMessagePosition(this.db, sessionId)
    }

    getMessageEpoch(sessionId: string): number {
        return getMessageEpoch(this.db, sessionId)
    }

    bumpMessageEpoch(sessionId: string): number {
        const result = bumpMessageEpoch(this.db, sessionId)
        this.invalidateTranscript(sessionId)
        return result
    }

    getLocalMessageStates(sessionId: string, localIds: string[]): LocalMessageState[] {
        return getLocalMessageStates(this.db, sessionId, localIds)
    }

    getUninvokedLocalMessages(sessionId: string, options?: { deliverableOnly?: boolean }): StoredMessage[] {
        return getUninvokedLocalMessages(this.db, sessionId, options)
    }

    getMatureScheduledMessages(beforeTime: number): StoredMessage[] {
        return getMatureScheduledMessages(this.db, beforeTime)
    }

    getImmediateQueuedLocalMessages(sessionId: string): StoredMessage[] {
        return getImmediateQueuedLocalMessages(this.db, sessionId)
    }

    countFutureScheduledLocalMessages(sessionId: string, now: number = Date.now()): number {
        return countFutureScheduledLocalMessages(this.db, sessionId, now)
    }

    countFutureScheduledBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return countFutureScheduledBySessionIds(this.db, sessionIds, now)
    }

    minFutureScheduledAtBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return minFutureScheduledAtBySessionIds(this.db, sessionIds, now)
    }

    // ponytail: scans through leading bookkeeping; index content if that prefix becomes costly.
    hasConversationContent(sessionId: string): boolean {
        const witnessId = this.conversationContent.get(sessionId)
        if (witnessId) {
            const witness = prepareCached(this.db, 'SELECT session_id FROM messages WHERE id = ?')
                .get(witnessId) as { session_id: string } | undefined
            if (witness?.session_id === sessionId) return true
            this.conversationContent.delete(sessionId)
        }
        const query = this.db.prepare<{ id: string; content: string | Uint8Array }, [string]>(
            'SELECT id, content FROM messages WHERE session_id = ? ORDER BY seq ASC'
        )
        try {
            for (const row of query.iterate(sessionId)) {
                if (hasConversationMessageContent(decodeMessageContent(row.content))) {
                    this.conversationContent.set(sessionId, row.id)
                    return true
                }
            }
            return false
        } finally {
            query.finalize()
        }
    }

    countMessages(sessionId: string): number {
        return countMessages(this.db, sessionId)
    }

    cancelQueuedMessage(sessionId: string, messageId: string): CancelQueuedMessageResult {
        const result = cancelQueuedMessage(this.db, sessionId, messageId)
        this.invalidateTranscript(sessionId)
        return result
    }

    lookupQueuedMessage(sessionId: string, messageId: string): LookupQueuedMessageResult {
        return lookupQueuedMessage(this.db, sessionId, messageId)
    }

    deleteQueuedMessageById(sessionId: string, messageId: string): boolean {
        const result = deleteQueuedMessageById(this.db, sessionId, messageId)
        if (result) this.invalidateTranscript(sessionId)
        return result
    }

    claimIndeterminateMessage(sessionId: string, messageId: string): StoredMessage | null {
        return claimIndeterminateMessage(this.db, sessionId, messageId)
    }

    markMessagesInvoked(sessionId: string, localIds: string[], invokedAt: number): number {
        const changed = markMessagesInvoked(this.db, sessionId, localIds, invokedAt)
        if (changed) this.activityClocks.delete(sessionId)
        return changed
    }

    markMessagesIndeterminate(sessionId: string, localIds: string[]): number {
        return markMessagesIndeterminate(this.db, sessionId, localIds)
    }

    setMessagesDeliveryState(sessionId: string, localIds: string[], state: 'queued' | 'dispatching' | 'indeterminate'): number {
        return setMessagesDeliveryState(this.db, sessionId, localIds, state)
    }

    markUninvokedImmediateMessages(sessionId: string, invokedAt: number): string[] {
        const result = markUninvokedImmediateMessages(this.db, sessionId, invokedAt)
        if (result.length) this.activityClocks.delete(sessionId)
        return result
    }

    moveUninvokedScheduledMessages(fromSessionId: string, toSessionId: string): number {
        const result = moveUninvokedScheduledMessages(this.db, fromSessionId, toSessionId)
        this.invalidateTranscript(fromSessionId)
        this.invalidateTranscript(toSessionId)
        return result
    }

    moveUninvokedMessages(fromSessionId: string, toSessionId: string): number {
        const result = moveUninvokedMessages(this.db, fromSessionId, toSessionId)
        this.invalidateTranscript(fromSessionId)
        this.invalidateTranscript(toSessionId)
        return result
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        const result = mergeSessionMessages(this.db, fromSessionId, toSessionId)
        this.invalidateTranscript(fromSessionId)
        this.invalidateTranscript(toSessionId)
        return result
    }

    truncateMessagesFromLocalId(
        sessionId: string,
        localId: string,
        replacement: Array<{
            content: unknown
            localId?: string | null
            createdAt?: number
            invokedAt?: number | null
        }> = []
    ): { deleted: number; inserted: number; epoch: number } {
        const result = truncateMessagesFromLocalId(this.db, sessionId, localId, replacement)
        this.invalidateTranscript(sessionId)
        return result
    }
}
