import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div> }))
import { NativeMessageContent, splitMessageContent, needsRichMarkdown, isPureHeartbeatText, isEmptyInertText, parseOrchestraMarker } from './MessageContent'

const result = '<heartbeat> <automation_id>example-check</automation_id> <decision>DONT_NOTIFY</decision> <message>结果无变化，无需用户操作。</message> </heartbeat>'
const wake = '<heartbeat>\n<automation_id>example-check</automation_id>\n<current_time_iso>2026-10-10T13:28:19.329Z</current_time_iso>\n<instructions>继续按原任务核对，仅用于渲染测试。</instructions>\n</heartbeat>'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('native message event rendering', () => {
    it('splits adjacent result and wake records while retaining surrounding prose', () => {
        const parts = splitMessageContent(`前文：${result}\n${wake}\n后文`)
        expect(parts.map(part => part.type)).toEqual(['text', 'heartbeat', 'heartbeat', 'text'])
        expect(parts[1]).toMatchObject({ automationId: 'example-check', decision: 'DONT_NOTIFY', message: '结果无变化，无需用户操作。' })
        expect(parts[2]).toMatchObject({ time: '2026-10-10T13:28:19.329Z', hasInstructions: true })
        expect(parts[3]).toEqual({ type: 'text', text: '\n后文' })
    })
    it.each([
        `\`\`\`xml\n${result}\n\`\`\``,
        `~~~~xml\n${result}\n~~~~`,
        `\`\`\`xml\n${result}`,
        `展示 \`${result}\` 示例`,
        `    ${result}`,
        `> ${result}`,
        `\\${result}`,
    ])('preserves code, quoted and escaped examples as ordinary text', text => {
        expect(splitMessageContent(text)).toEqual([{ type: 'text', text }])
    })
    it('preserves unrecognized and incomplete markup and finds real records after code examples', () => {
        const text = '<heartbeat>literal XML</heartbeat>\n<heartbeat><instructions>still streaming'
        expect(splitMessageContent(text)).toEqual([{ type: 'text', text }])
        const mixed = splitMessageContent(`\`\`\`xml\n${result}\n\`\`\`\n${wake}`)
        expect(mixed.map(part => part.type)).toEqual(['text', 'heartbeat'])
    })
    it.each([false, true])('shows concise records for user=%s and only mounts raw instructions when expanded', user => {
        render(<NativeMessageContent user={user} text={`${result}\n${wake}`} />)
        expect(screen.getAllByLabelText('自动检查记录')).toHaveLength(2)
        expect(screen.getByText('无需提醒')).toBeInTheDocument()
        expect(screen.getByText('结果无变化，无需用户操作。')).toBeInTheDocument()
        expect(screen.getByText('后台任务唤醒')).toBeInTheDocument()
        expect(screen.getByText('内部任务指令已折叠')).toBeInTheDocument()
        expect(document.querySelector('pre')).toBeNull()
        const details = screen.getAllByText('查看原始记录')[1].closest('details')!
        details.open = true
        fireEvent(details, new Event('toggle'))
        expect(details.querySelector('pre')?.textContent).toBe(wake)
        details.open = false
        fireEvent(details, new Event('toggle'))
        expect(details.querySelector('pre')).toBeNull()
    })
    it.each([
        ['angle wrapper', '![图片 1](</Users/test/my image.png>)'],
        ['HTML-escaped wrapper', '![图片 1](&lt;/Users/test/my image.png&gt;)'],
        ['backslash-escaped wrapper', '![图片 1](\\</Users/test/my image.png\\>)'],
    ])('loads a local attachment through the native loader (%s)', async (_label, image) => {
        vi.stubGlobal('IntersectionObserver', undefined)
        const load = vi.fn().mockResolvedValue('data:image/jpeg;base64,thumb')
        const { container } = render(<NativeMessageContent user text={`前文\n${image}\n\n后文`} loadImage={load} />)
        await waitFor(() => expect(load).toHaveBeenCalledWith('/Users/test/my image.png'))
        expect(container.querySelector('.nd-user-text')).toHaveTextContent('前文')
        expect(container.querySelector('.nd-user-text')).not.toHaveTextContent('![')
        expect(container.querySelector('.nd-message-images img')).toHaveAttribute('src', 'data:image/jpeg;base64,thumb')
        expect(container.querySelector('img[src*="Users"]')).toBeNull()
    })
    it.each([
        '![图片](</Users/test/preview.png>)',
        '![图片](&lt;/Users/test/preview.png&gt;)',
    ])('loads a local Markdown image in assistant text through the native loader: %s', async text => {
        vi.stubGlobal('IntersectionObserver', undefined)
        const load = vi.fn().mockResolvedValue('data:image/jpeg;base64,thumb')
        const { container } = render(<NativeMessageContent text={text} loadImage={load} />)
        await waitFor(() => expect(load).toHaveBeenCalledWith('/Users/test/preview.png'))
        expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,thumb')
    })
    it('keeps ordinary GFM readable without replacing its DOM with a rich renderer', async () => {
        const { container } = render(<NativeMessageContent text={'**normal Markdown**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n\n[Link](https://example.com)'} />)
        const paragraph = container.querySelector('p')
        expect(container.querySelector('strong')).toHaveTextContent('normal Markdown')
        expect(container.querySelector('table')).toHaveTextContent('AB12')
        expect(container.querySelector('input[type="checkbox"]')).toBeChecked()
        await Promise.resolve()
        expect(screen.queryByTestId('markdown')).toBeNull()
        expect(container.querySelector('p')).toBe(paragraph)
    })
    it.each(['```ts\nconst x = 1\n```', '~~~mermaid\ngraph LR\n A-->B\n~~~', '$$x^2$$', 'An equation $x+y$ here', '\\(x+y\\)', '[Open](codex:thread)'])('retains the rich renderer for advanced content: %s', async text => {
        expect(needsRichMarkdown(text)).toBe(true)
        render(<NativeMessageContent text={text} />)
        expect(await screen.findByTestId('markdown')).toHaveTextContent(text.replace(/\s+/g, ' '))
    })
    it('renders readable Markdown immediately and keeps event fields inert', async () => {
        const raw = '<heartbeat><automation_id>test</automation_id><message><img src="bad" onerror="alert(1)"></message><instructions><script>alert(1)</script></instructions></heartbeat>'
        const { container } = render(<NativeMessageContent text={`**normal Markdown**\n${raw}`} />)
        expect(container.querySelector('strong')).toHaveTextContent('normal Markdown')
        expect(screen.queryByTestId('markdown')).toBeNull()
        expect(screen.getByText('<img src="bad" onerror="alert(1)">')).toBeInTheDocument()
        expect(container.querySelector('img, script')).toBeNull()
    })
})

const pureA = '<heartbeat><automation_id>check-a</automation_id><decision>DONT_NOTIFY</decision></heartbeat>'
const pureB = '<heartbeat><automation_id>check-b</automation_id><current_time_iso>2026-10-10T13:28:19.329Z</current_time_iso><instructions>继续按原任务核对。</instructions></heartbeat>'
const notify = '<heartbeat><automation_id>notify-check</automation_id><decision>NOTIFY</decision><message>任务已完成，请查看结果。</message></heartbeat>'
const exception = '<heartbeat><automation_id>error-check</automation_id><decision>EXCEPTION</decision><message>检查异常。</message></heartbeat>'

describe('heartbeat boundaries and compact rows', () => {
    it('classifies only empty/DONT_NOTIFY checks with no message as pure', () => {
        expect(isPureHeartbeatText(pureA)).toBe(true)
        expect(isPureHeartbeatText(pureB)).toBe(true)
        expect(isPureHeartbeatText(`${pureA}\n${pureB}`)).toBe(true)
        expect(isPureHeartbeatText(result)).toBe(false)
        expect(isPureHeartbeatText(notify)).toBe(false)
        expect(isPureHeartbeatText(exception)).toBe(false)
        expect(isPureHeartbeatText(`前文 ${pureA}`)).toBe(false)
        expect(isPureHeartbeatText(`\`${pureA}\``)).toBe(false)
        expect(isPureHeartbeatText(`\`\`\`xml\n${pureA}\n\`\`\``)).toBe(false)
    })
    it('treats blank and directive-only placeholders as inert, but keeps code examples', () => {
        expect(isEmptyInertText(' \n\t')).toBe(true)
        expect(isEmptyInertText('::created-thread{threadId="x"}')).toBe(true)
        expect(isEmptyInertText('`::created-thread{threadId="x"}`')).toBe(false)
        expect(isEmptyInertText('普通正文')).toBe(false)
    })
    it('merges adjacent pure checks into one compact row and mounts each raw record only on demand', () => {
        const { container } = render(<NativeMessageContent text={`${pureA}\n${pureB}`} />)
        expect(container.querySelectorAll('.nd-heartbeat')).toHaveLength(1)
        expect(screen.getByText('×2')).toBeInTheDocument()
        expect(container.querySelector('.nd-heartbeat-time')).not.toBeEmptyDOMElement()
        expect(container.querySelector('.nd-heartbeat pre')).toBeNull()
        const details = container.querySelector<HTMLDetailsElement>('.nd-heartbeat')!
        details.open = true
        fireEvent(details, new Event('toggle'))
        const pre = [...details.querySelectorAll('pre')].map(value => value.textContent)
        expect(pre).toEqual([pureA, pureB])
        expect(details).toHaveTextContent('check-a')
        expect(details).toHaveTextContent('check-b')
        expect(details).toHaveTextContent('继续按原任务核对。')
    })
    it('never merges across a notification, exception, prose or gap', () => {
        const { container } = render(<NativeMessageContent text={`${pureA}\n${notify}\n${exception}\n普通说明\n${pureB}`} />)
        expect(container.querySelectorAll('.nd-heartbeat')).toHaveLength(4)
        expect(screen.getByText('任务已完成，请查看结果。')).toBeInTheDocument()
        expect(screen.getByText('检查异常。')).toBeInTheDocument()
        expect(screen.getByText('普通说明')).toBeInTheDocument()
        expect(screen.queryByText('×2')).toBeNull()
    })
    it('does not turn code-fenced heartbeat examples into rows', () => {
        const { container } = render(<NativeMessageContent text={`\`\`\`xml\n${pureA}\n\`\`\``} />)
        expect(container.querySelectorAll('.nd-heartbeat')).toHaveLength(0)
        expect(container).toHaveTextContent('check-a')
    })
    it('renders nothing for a whitespace-only assistant placeholder', () => {
        const { container } = render(<NativeMessageContent text={' \n\t '} />)
        expect(container.querySelector('.nd-message-parts')?.childElementCount).toBe(0)
        expect(container.querySelector('p, pre, .nd-render')).toBeNull()
    })
})

it('hides native created-thread directives without deleting code examples', async () => {
    const { stripInternalDirectives } = await import('./MessageContent')
    expect(stripInternalDirectives('已完成。\n::created-thread{threadId="test"}')).toBe('已完成。\n')
    expect(stripInternalDirectives('`::created-thread{threadId="test"}`')).toContain('::created-thread')
})

describe('orchestra notice folding', () => {
    const watchdog = '[orchestra-watchdog:wd-20261104T063000-ab12cd] 巡检：P0 1 项，P1 3 项，历史遗留 7 项。读取：codex-orchestra watchdog-brief wd-20261104T063000-ab12cd。处理后静默结束，不要回复 ACK。'
    const receipt = '[orchestra-receipt:T022-final-20261103-v1] Task review pending. Read with: codex-orchestra receipt-get T022-final-20261103-v1.'
    it('parses only a leading marker', () => {
        expect(parseOrchestraMarker(watchdog)).toMatchObject({ kind: 'watchdog', id: 'wd-20261104T063000-ab12cd' })
        expect(parseOrchestraMarker(receipt)).toMatchObject({ kind: 'receipt', id: 'T022-final-20261103-v1' })
        expect(parseOrchestraMarker(`说明 ${watchdog}`)).toBeNull()
        expect(parseOrchestraMarker('[orchestra-other:x] hi')).toBeNull()
        expect(parseOrchestraMarker('`' + watchdog + '`')).toBeNull()
    })
    it('folds a user watchdog message into one compact row with counts and mounts the raw text on demand', () => {
        const { container } = render(<NativeMessageContent user text={watchdog} />)
        const details = container.querySelector<HTMLDetailsElement>('.nd-heartbeat')!
        expect(container.querySelectorAll('.nd-heartbeat')).toHaveLength(1)
        expect(details).toHaveTextContent('巡检提示')
        expect(details).toHaveTextContent('P0 1 · P1 3 · 历史 7')
        expect(container.querySelector('.nd-user-text')).toBeNull()
        expect(container.querySelector('pre')).toBeNull()
        details.open = true
        fireEvent(details, new Event('toggle'))
        expect(container.querySelector('pre')?.textContent).toBe(watchdog)
    })
    it('folds a receipt notice with its id and leaves assistant text and ordinary user text alone', () => {
        const folded = render(<NativeMessageContent user text={receipt} />)
        expect(folded.container.querySelector('.nd-heartbeat')).toHaveTextContent('回执待核验')
        expect(folded.container.querySelector('.nd-heartbeat')).toHaveTextContent('T022-final-20261103-v1')
        cleanup()
        const assistant = render(<NativeMessageContent text={watchdog} />)
        expect(assistant.container.querySelector('.nd-heartbeat')).toBeNull()
        cleanup()
        const plain = render(<NativeMessageContent user text="继续" />)
        expect(plain.container.querySelector('.nd-heartbeat')).toBeNull()
        expect(plain.container).toHaveTextContent('继续')
    })
})
