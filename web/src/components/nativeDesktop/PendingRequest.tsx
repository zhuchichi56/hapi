import { useEffect, useState } from 'react'

type QuestionOption = { label: string; description?: string }
type Question = { id: string; question: string; header?: string; isOther?: boolean; isSecret?: boolean; multiSelect?: boolean; options?: QuestionOption[] }
type Request = Record<string, unknown> & { id?: string; requestId?: string; method?: string; request?: { method?: string; params?: { questions?: Question[] } }; params?: { questions?: Question[] }; questions?: Question[] }
const QUESTION_METHODS = ['item/tool/requestUserInput', 'native/claude/requestUserInput']

function validQuestions(method: string, raw: unknown): Question[] | null {
    if (!QUESTION_METHODS.includes(method) || !Array.isArray(raw) || raw.length === 0) return null
    return raw.every(question => question && typeof question === 'object' && typeof question.id === 'string' && typeof question.question === 'string' && (!question.options || Array.isArray(question.options) && question.options.every((option: QuestionOption) => option && typeof option.label === 'string'))) ? raw as Question[] : null
}

export function PendingRequest({ request, disabled, respond }: { request: Request; disabled: boolean; respond: (value: Record<string, unknown>) => void }) {
    const [answers, setAnswers] = useState<Record<string, string[]>>({})
    const [custom, setCustom] = useState<Record<string, string>>({})
    const [collapsed, setCollapsed] = useState(false)
    const method = String(request.method ?? request.request?.method ?? '')
    const requestId = request.id ?? request.requestId
    const raw = request.questions ?? request.params?.questions ?? request.request?.params?.questions
    const questions = validQuestions(method, raw)
    const identity = `${method}:${String(requestId ?? '')}:${Array.isArray(raw) ? raw.map(question => String(question?.id ?? '')).join('|') : ''}`
    const base = { requestId }
    // A new native request must never inherit answers or collapse state from the previous one.
    useEffect(() => { setAnswers({}); setCustom({}); setCollapsed(false) }, [identity])
    const allowCustom = (question: Question) => method === 'item/tool/requestUserInput' && (!!question.isOther || !question.options?.length)
    const selected = (question: Question) => (answers[question.id] ?? []).filter(value => value !== '__custom')
    const answer = (question: Question): string[] => {
        const options = selected(question)
        // Choosing an option wins over any custom draft still visible in the card.
        if (options.length) return options
        if (!allowCustom(question)) return []
        const text = (custom[question.id] ?? '').trim()
        return text ? [text] : []
    }
    const complete = !!questions && questions.every(question => answer(question).length > 0)
    const choose = (question: Question, label: string) => {
        setAnswers(value => {
            const current = (value[question.id] ?? []).filter(item => item !== '__custom')
            const next = question.multiSelect ? current.includes(label) ? current.filter(item => item !== label) : [...current, label] : [label]
            return { ...value, [question.id]: next }
        })
        // Selecting an option removes the custom draft from what will be submitted.
        setCustom(value => ({ ...value, [question.id]: '' }))
    }
    const typeCustom = (question: Question, text: string) => {
        setCustom(value => ({ ...value, [question.id]: text }))
        setAnswers(value => ({ ...value, [question.id]: text.trim() ? ['__custom'] : [] }))
    }
    const submit = () => {
        if (!questions || disabled || !complete) return
        respond({ ...base, response: { answers: Object.fromEntries(questions.map(question => [question.id, { answers: answer(question) }])) } })
    }
    const skip = () => {
        if (!disabled) respond({ ...base, response: { answers: {} } })
    }
    if (questions) {
        if (collapsed) return <button type="button" className="nd-question-reopen" aria-label="展开问题" onClick={() => setCollapsed(false)}>
            <span className="nd-question-icon" aria-hidden="true">?</span><span>问题</span><small>等待你的回答</small><span className="nd-question-chevron" aria-hidden="true">›</span>
        </button>
        return <section className="nd-question-card" aria-label="问题">
            <header className="nd-question-head">
                <span className="nd-question-icon" aria-hidden="true">?</span>
                <span className="nd-question-title">问题</span>
                <button type="button" className="nd-question-close" aria-label="收起问题" title="收起问题" onClick={() => setCollapsed(true)}>×</button>
            </header>
            <form className="nd-question-form" onSubmit={event => { event.preventDefault(); submit() }}>
                {questions.map((question, index) => <fieldset className="nd-question" disabled={disabled} key={question.id}>
                    <legend className="nd-question-text">{question.question}{questions.length > 1 && <small className="nd-question-count">{index + 1}/{questions.length}</small>}</legend>
                    {!!question.options?.length && <div className="nd-question-options">
                        {question.options.map((option, optionIndex) => <label className="nd-question-option" key={option.label}>
                            <input className="nd-sr-only nd-question-input" type={question.multiSelect ? 'checkbox' : 'radio'} name={`${String(requestId)}:${question.id}`} aria-label={option.label} checked={selected(question).includes(option.label)} disabled={disabled} onChange={() => choose(question, option.label)} />
                            <span className="nd-question-index" aria-hidden="true">{optionIndex + 1}</span>
                            <span className="nd-question-option-text">{option.label}{option.description && <small>{option.description}</small>}</span>
                            <span className="nd-question-arrow" aria-hidden="true">›</span>
                        </label>)}
                    </div>}
                    {questions.length > 1 && allowCustom(question) && <div className="nd-question-custom">
                        <label className="nd-question-custom-label" htmlFor={`${String(requestId)}:${question.id}:custom`}>或自行撰写回复</label>
                        <input id={`${String(requestId)}:${question.id}:custom`} className="nd-question-custom-input" aria-label={question.question} type={question.isSecret ? 'password' : 'text'} autoComplete="off" value={custom[question.id] ?? ''} disabled={disabled} onChange={event => typeCustom(question, event.target.value)} placeholder="输入回答…" />
                    </div>}
                </fieldset>)}
                <footer className="nd-question-footer">
                    {questions.length === 1 && allowCustom(questions[0]) && <label className="nd-question-inline-custom"><span aria-hidden="true">✎</span><input className="nd-question-custom-input" aria-label={questions[0].question} type={questions[0].isSecret ? 'password' : 'text'} autoComplete="off" value={custom[questions[0].id] ?? ''} disabled={disabled} onChange={event => typeCustom(questions[0], event.target.value)} placeholder="或自行撰写回复" /></label>}
                    {method === 'item/tool/requestUserInput' && <button type="button" className="nd-question-skip" disabled={disabled} onClick={skip}>跳过</button>}
                    <button type="submit" className="nd-question-send" disabled={disabled || !complete}>发送</button>
                </footer>
            </form>
        </section>
    }
    const buttons = Array.isArray(request.buttons) ? request.buttons as string[] : method.includes('requestApproval') ? ['accept', 'decline'] : null
    return <div className="nd-request"><strong>需要你的确认</strong>
        {Array.isArray(request.buttons) && <div className="nd-request-actions">{(request.buttons as string[]).map(button => <button type="button" disabled={disabled} key={button} onClick={() => respond({ ...base, button })}>{button}</button>)}</div>}
        {!Array.isArray(request.buttons) && method.includes('requestApproval') && <div className="nd-request-actions">{['accept', 'decline'].map(decision => <button type="button" disabled={disabled} key={decision} onClick={() => respond({ ...base, decision })}>{decision === 'accept' ? '允许本次' : '拒绝'}</button>)}</div>}
        {!buttons && <p>请在桌面处理此请求。</p>}
        <details><summary>请求详情</summary><pre>{JSON.stringify(request, null, 2)}</pre></details>
    </div>
}
