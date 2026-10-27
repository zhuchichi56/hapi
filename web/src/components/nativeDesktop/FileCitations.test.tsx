import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
vi.mock('@/components/MarkdownRenderer', async () => {
    const { default: Markdown } = await import('react-markdown')
    return { MarkdownRenderer: ({ content }: { content: string }) => <Markdown>{content}</Markdown> }
})
import { NativeMessageContent, normalizeFileCitations } from './MessageContent'

const citation = ':codex-file-citation{path="/Users/zhuhe/Documents/Codex/2026-10-27/https-arxiv-org-abs-2607-27146/outputs/MindForge-2607.27146v1.pdf" purpose="source"}'
afterEach(cleanup)
describe('native file citation rendering', () => {
    it('renders the reported citation as a compact filename and preserves surrounding Markdown', () => {
        const { container } = render(<NativeMessageContent text={`**本次阅读原文：**${citation}，正文继续。`} />)
        expect(container.querySelector('code')?.textContent).toBe('MindForge-2607.27146v1.pdf')
        expect(container.querySelector('strong')?.textContent).toBe('本次阅读原文：')
        expect(container.textContent).toBe('本次阅读原文：MindForge-2607.27146v1.pdf，正文继续。')
        expect(container.querySelector('a')).toBeNull()
        expect(container.textContent).not.toContain('codex-file-citation')
    })
    it('accepts reordered attributes, spaces and multiple references', () => {
        const text = ':codex-file-citation{purpose="source" path="/Users/zhuhe/My Report.pdf"} / :codex-file-citation{path="/tmp/next.md"}'
        const { container } = render(<NativeMessageContent text={text} />)
        expect([...container.querySelectorAll('code')].map(code => code.textContent)).toEqual(['My Report.pdf', 'next.md'])
    })
    it('keeps unusual filenames inert', () => {
        const { container } = render(<NativeMessageContent text={':codex-file-citation{path="/tmp/a`[x](javascript:bad)<img>.md"}'} />)
        expect(container.querySelector('code')?.textContent).toBe('a`[x](javascript:bad)<img>.md')
        expect(container.querySelector('a, img, script')).toBeNull()
    })
    it('preserves code and escaped examples and still handles a following real citation', () => {
        for (const text of [`\`${citation}\``, `\`\`\`text\n${citation}\n\`\`\``, `    ${citation}`, `> ${citation}`, `\\${citation}`]) {
            expect(normalizeFileCitations(text)).toBe(text)
        }
        expect(normalizeFileCitations(`\`${citation}\`\n${citation}`)).toBe(`\`${citation}\`\n\` MindForge-2607.27146v1.pdf \``)
    })
    it('preserves incomplete streaming directives and invalid references', () => {
        for (const text of [citation.slice(0, -1), ':codex-file-citation{path="/tmp/', ':codex-file-citation{path="javascript:bad"}', ':codex-file-citation{path="//example.org/file.pdf"}', ':codex-file-citation{path="/tmp/a" path="/tmp/b"}', ':codex-file-citation{path="/tmp/a" onclick="bad"}']) {
            expect(normalizeFileCitations(text)).toBe(text)
        }
    })
})
