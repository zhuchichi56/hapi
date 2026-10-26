import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div> }))
import { NativeMessageContent, splitMessageContent } from './MessageContent'

const result = '<heartbeat> <automation_id>example-check</automation_id> <decision>DONT_NOTIFY</decision> <message>结果无变化，无需用户操作。</message> </heartbeat>'
const wake = '<heartbeat>\n<automation_id>example-check</automation_id>\n<current_time_iso>2026-10-10T13:28:19.329Z</current_time_iso>\n<instructions>继续按原任务核对，仅用于渲染测试。</instructions>\n</heartbeat>'

afterEach(cleanup)
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
    it('renders event fields as inert text and leaves normal assistant Markdown intact', () => {
        const raw = '<heartbeat><automation_id>test</automation_id><message><img src="bad" onerror="alert(1)"></message><instructions><script>alert(1)</script></instructions></heartbeat>'
        const { container } = render(<NativeMessageContent text={`**normal Markdown**\n${raw}`} />)
        expect(screen.getByTestId('markdown')).toHaveTextContent('**normal Markdown**')
        expect(screen.getByText('<img src="bad" onerror="alert(1)">')).toBeInTheDocument()
        expect(container.querySelector('img, script')).toBeNull()
    })
})
