import { useEffect, useState } from 'react'
import { questionReplyText, type AsyncQuestion } from './questionReply'

type SendOutcome = 'sent' | 'failed' | 'uncertain'

type Props = {
    itemId: string
    questionKey: string
    questions: AsyncQuestion[]
    answered: boolean
    answeredAnswers?: string[]
    disabled: boolean
    disabledReason?: string
    send: (text: string) => Promise<SendOutcome>
}

// Codex request_user_input_async is an assistant message, not a blocking
// item/tool/requestUserInput request. The card is the only place its question
// text and options are rendered; Message skips the original assistant body.
export function AsyncQuestionCard({ itemId, questionKey, questions, answered, answeredAnswers, disabled, disabledReason, send }: Props) {
    const [selected, setSelected] = useState<Record<number, string>>({})
    const [custom, setCustom] = useState<Record<number, string>>({})
    const [sending, setSending] = useState(false)
    const [sent, setSent] = useState(false)
    const [skipped, setSkipped] = useState(false)
    const [uncertain, setUncertain] = useState(false)
    const [error, setError] = useState('')
    const identity = `${itemId}:${questionKey}:${JSON.stringify(questions)}`

    useEffect(() => {
        setSelected({}); setCustom({}); setSending(false); setSent(false); setSkipped(false); setUncertain(false); setError('')
    }, [identity])

    const answer = (index: number) => {
        const text = custom[index]?.trim()
        return text || selected[index] || ''
    }
    const complete = questions.every((_question, index) => answer(index).length > 0)
    const blocked = disabled || sending

    const choose = (index: number, option: string) => {
        setSelected(value => ({ ...value, [index]: option }))
        setCustom(value => ({ ...value, [index]: '' }))
        setError('')
    }
    const typeCustom = (index: number, text: string) => {
        setCustom(value => ({ ...value, [index]: text }))
        setSelected(value => {
            const next = { ...value }
            delete next[index]
            return next
        })
        setError('')
    }
    const submit = async () => {
        if (blocked || !complete) return
        setSending(true); setError('')
        try {
            const outcome = await send(questionReplyText(itemId, questions, questions.map((_question, index) => answer(index))))
            if (outcome === 'sent') setSent(true)
            else if (outcome === 'uncertain') setUncertain(true)
            else setError('发送失败，请稍后重试')
        } catch {
            setError('发送失败，请稍后重试')
        } finally {
            setSending(false)
        }
    }

    if (answered) return <details className="nd-question-card nd-question-card-answered" data-state="answered">
        <summary aria-label="问题（已回答）">
            <span className="nd-question-icon" aria-hidden="true">✓</span>
            <span className="nd-question-title">问题</span>
            <span className="nd-question-state" data-tone="answered">已回答</span>
            <span className="nd-question-answered-toggle">查看问题</span>
            <span className="nd-question-chevron" aria-hidden="true">›</span>
        </summary>
        <div className="nd-question-answered-body">
            <ol>{questions.map((question, index) => <li key={`${index}:${question.title}`}>
                <span>{question.title}</span>
                {answeredAnswers?.[index] !== undefined && <small>回答：{answeredAnswers[index]}</small>}
            </li>)}</ol>
        </div>
    </details>

    if (skipped) return <section className="nd-question-card nd-question-card-skipped" aria-label="问题（已跳过）" data-state="skipped">
        <div className="nd-question-head">
            <span className="nd-question-icon" aria-hidden="true">?</span>
            <span className="nd-question-title">问题</span>
            <span className="nd-question-state" data-tone="skipped">已跳过 · 未发送</span>
            <button type="button" className="nd-question-reopen-inline" onClick={() => setSkipped(false)}>重新打开</button>
        </div>
    </section>

    if (uncertain) return <section className="nd-question-card nd-question-card-uncertain" aria-label="问题（结果未确认）" data-state="uncertain">
        <div className="nd-question-head">
            <span className="nd-question-icon" aria-hidden="true">!</span>
            <span className="nd-question-title">问题</span>
            <span className="nd-question-state" data-tone="uncertain">结果未确认</span>
        </div>
        <p className="nd-question-hint" role="status">提交结果暂未确认，请先查看原会话，避免重复发送。</p>
    </section>

    if (sent) return <section className="nd-question-card nd-question-card-sent" aria-label="问题（已发送）" data-state="sent">
        <div className="nd-question-head">
            <span className="nd-question-icon" aria-hidden="true">↑</span>
            <span className="nd-question-title">问题</span>
            <span className="nd-question-state" data-tone="sent">已发送，等待原会话更新</span>
        </div>
    </section>

    return <section className="nd-question-card" aria-label="问题" aria-busy={sending}>
        <header className="nd-question-head">
            <span className="nd-question-icon" aria-hidden="true">?</span>
            <span className="nd-question-title">问题</span>
        </header>
        <form className="nd-question-form" onSubmit={event => { event.preventDefault(); void submit() }}>
            {questions.map((question, index) => <fieldset className="nd-question" disabled={blocked} key={`${index}:${question.title}`}>
                <legend className="nd-question-text">{question.title}{questions.length > 1 && <small className="nd-question-count">{index + 1}/{questions.length}</small>}</legend>
                {!!question.options?.length && <div className="nd-question-options">
                    {question.options.map((option, optionIndex) => <label className="nd-question-option" key={`${optionIndex}:${option}`}>
                        <input
                            className="nd-sr-only nd-question-input"
                            type="radio"
                            name={`${questionKey}:${index}`}
                            value={option}
                            aria-label={option}
                            checked={selected[index] === option}
                            disabled={blocked}
                            onChange={() => choose(index, option)}
                        />
                        <span className="nd-question-index" aria-hidden="true">{optionIndex + 1}</span>
                        <span className="nd-question-option-text">{option}</span>
                        <span className="nd-question-arrow" aria-hidden="true">›</span>
                    </label>)}
                </div>}
                <div className="nd-question-custom">
                    {!!question.options?.length && <label className="nd-question-custom-label" htmlFor={`${questionKey}:${index}:custom`}>或自行输入回答</label>}
                    <input
                        id={`${questionKey}:${index}:custom`}
                        className="nd-question-custom-input"
                        aria-label={`${question.title} 自定义回答`}
                        type="text"
                        autoComplete="off"
                        value={custom[index] ?? ''}
                        disabled={blocked}
                        onChange={event => typeCustom(index, event.target.value)}
                        placeholder="输入回答…"
                    />
                </div>
            </fieldset>)}
            {disabled && disabledReason && <p className="nd-question-hint" role="status">{disabledReason}</p>}
            {error && <p className="nd-question-error" role="alert">{error}</p>}
            <footer className="nd-question-footer">
                <button type="button" className="nd-question-skip" disabled={sending} onClick={() => setSkipped(true)}>跳过</button>
                <button type="submit" className="nd-question-send" disabled={blocked || !complete}>{sending ? '发送中…' : '发送'}</button>
            </footer>
        </form>
    </section>
}
