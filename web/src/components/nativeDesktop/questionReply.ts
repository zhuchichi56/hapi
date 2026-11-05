export type AsyncQuestion = { title: string; options?: string[] }

export type AsyncQuestionReply = {
    questionItemId: string
    question: string
    answer: string
}

export const QUESTION_REPLY_START = '<send_user_message_question_reply>'
export const QUESTION_REPLY_END = '</send_user_message_question_reply>'

// The original App identifies an async question by the agent message item id
// and the question index. This exact JSON string is part of its reply protocol.
export function questionReplyId(itemId: string, questionIndex: number): string {
    return JSON.stringify(['request_user_input_async', itemId, questionIndex])
}

export function questionReplyText(itemId: string, questions: AsyncQuestion[], answers: string[]): string {
    const replies: AsyncQuestionReply[] = questions.map((question, index) => ({
        questionItemId: questionReplyId(itemId, index),
        question: question.title,
        answer: answers[index] ?? '',
    }))
    return `${QUESTION_REPLY_START}\n${JSON.stringify(replies)}\n${QUESTION_REPLY_END}`
}

// Only a complete wrapper is a protocol reply. An ordinary user message that
// merely mentions the tag is not consumed or hidden.
export function parseQuestionReply(text: string): AsyncQuestionReply[] | null {
    const trimmed = text.trim()
    if (!trimmed.startsWith(QUESTION_REPLY_START) || !trimmed.endsWith(QUESTION_REPLY_END)) return null
    const body = trimmed.slice(QUESTION_REPLY_START.length, -QUESTION_REPLY_END.length).trim()
    let raw: unknown
    try { raw = JSON.parse(body) } catch { return null }
    if (!Array.isArray(raw) || raw.length === 0) return null
    const replies: AsyncQuestionReply[] = []
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') return null
        const value = entry as Partial<AsyncQuestionReply>
        if (typeof value.questionItemId !== 'string' || typeof value.question !== 'string' || typeof value.answer !== 'string') return null
        replies.push({ questionItemId: value.questionItemId, question: value.question, answer: value.answer })
    }
    return replies
}
