import { useState } from 'react'
type Question = { id: string; question: string; header?: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description?: string }[] }
type Request = Record<string, unknown> & { request?: { method?: string; params?: { questions?: Question[] } }; params?: { questions?: Question[] }; questions?: Question[] }
export function PendingRequest({ request, disabled, respond }: { request: Request; disabled: boolean; respond: (value: Record<string, unknown>) => void }) {
    const [answers, setAnswers] = useState<Record<string, string>>({})
    const [custom, setCustom] = useState<Record<string, string>>({})
    const method = String(request.method ?? request.request?.method ?? '')
    const raw = request.questions ?? request.params?.questions ?? request.request?.params?.questions
    const questions = method === 'item/tool/requestUserInput' && Array.isArray(raw) && raw.length > 0 && raw.every(question => typeof question.id === 'string' && typeof question.question === 'string' && (!question.options || Array.isArray(question.options) && question.options.every(option => typeof option.label === 'string'))) ? raw : null
    const answer = (question: Question) => answers[question.id] === '__custom' || !question.options?.length ? custom[question.id]?.trim() : answers[question.id]
    const base = { requestId: request.id ?? request.requestId }
    return <div className="nd-request"><strong>{questions ? '需要你的回答' : '需要你的确认'}</strong>
        {questions ? <form onSubmit={event => { event.preventDefault(); if (questions.every(question => answer(question))) respond({ ...base, response: { answers: Object.fromEntries(questions.map(question => [question.id, { answers: [answer(question)] }])) } }) }}>
            {questions.map(question => <fieldset disabled={disabled} key={question.id} className="nd-question"><legend>{question.question}</legend>
                {question.options?.map(option => <label key={option.label}><input type="radio" name={String(base.requestId) + ':' + question.id} checked={answers[question.id] === option.label} onChange={() => setAnswers(value => ({ ...value, [question.id]: option.label }))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
                {!!question.options?.length && question.isOther && <label><input type="radio" name={String(base.requestId) + ':' + question.id} checked={answers[question.id] === '__custom'} onChange={() => setAnswers(value => ({ ...value, [question.id]: '__custom' }))} /><span>自定义回答</span></label>}
                {(!question.options?.length || answers[question.id] === '__custom') && <input aria-label={question.question} type={question.isSecret ? 'password' : 'text'} autoComplete="off" value={custom[question.id] ?? ''} onChange={event => setCustom(value => ({ ...value, [question.id]: event.target.value }))} placeholder="输入回答…" />}
            </fieldset>)}
            <div className="nd-request-actions"><button type="submit" disabled={disabled || questions.some(question => !answer(question))}>提交回答</button></div>
        </form> : Array.isArray(request.buttons) ? <div className="nd-request-actions">{(request.buttons as string[]).map(button => <button disabled={disabled} key={button} onClick={() => respond({ ...base, button })}>{button}</button>)}</div> : method.includes('requestApproval') ? <div className="nd-request-actions">{['accept', 'decline'].map(decision => <button disabled={disabled} key={decision} onClick={() => respond({ ...base, decision })}>{decision === 'accept' ? '允许本次' : '拒绝'}</button>)}</div> : <p>请在桌面处理此请求。</p>}
        <details><summary>请求详情</summary><pre>{JSON.stringify(request, null, 2)}</pre></details>
    </div>
}
