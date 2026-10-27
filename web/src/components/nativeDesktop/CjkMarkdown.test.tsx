import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
// Use the production standalone parser without unrelated App context dependencies.
vi.mock('@/components/MarkdownRenderer', async () => { const {default:Markdown}=await import('react-markdown'); return {MarkdownRenderer:({content}:{content:string})=><Markdown>{content}</Markdown>} })
import { NativeMessageContent, normalizeCjkStrong } from './MessageContent'
const text = '**下次已经可以直接给我一篇新文章开展宣传，不需要重新注册、建站。**目前跑通过 6 个平台、7 篇文章；今天又检查了登录和编辑入口。'
afterEach(cleanup)
describe('native Chinese strong emphasis', () => {
    it('renders the exact reported sentence using the real Markdown parser', () => {
        const { container } = render(<NativeMessageContent text={text} />)
        expect(container.querySelector('strong')?.textContent).toBe('下次已经可以直接给我一篇新文章开展宣传，不需要重新注册、建站。')
        expect(container.textContent).toContain('目前跑通过 6 个平台、7 篇文章')
        expect(container.textContent).not.toContain('**')
    })
    it.each([`\`${text}\``, `\`\`\`text\n${text}\n\`\`\``, `\\${text}`, 'ordinary **bold** text'])('preserves code and literal markup %s', value => {
        expect(normalizeCjkStrong(value)).toBe(value)
    })
})
