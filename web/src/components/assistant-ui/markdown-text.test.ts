import { describe, expect, it } from 'vitest'
import { unified, type PluggableList } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { toHtml } from 'hast-util-to-html'
import remarkBreaks from 'remark-breaks'
import remarkNonHttpsAutolink from '@/lib/remark-non-https-autolink'
import remarkStripCjkAutolink from '@/lib/remark-strip-cjk-autolink'
import {
    MARKDOWN_PLUGINS,
    MARKDOWN_PLUGINS_STANDALONE,
    MARKDOWN_PLUGINS_STANDALONE_WITH_BREAKS,
    MARKDOWN_PLUGINS_WITH_BREAKS,
    MARKDOWN_REHYPE_PLUGINS,
} from '@/components/assistant-ui/markdown-text'

describe('MARKDOWN_PLUGINS integration', () => {
    it('includes remarkNonHttpsAutolink', () => {
        expect(MARKDOWN_PLUGINS).toContain(remarkNonHttpsAutolink)
    })

    it('places remarkNonHttpsAutolink BEFORE remarkStripCjkAutolink so CJK strip sees new links', () => {
        const idxAutolink = MARKDOWN_PLUGINS.indexOf(remarkNonHttpsAutolink)
        const idxCjk = MARKDOWN_PLUGINS.indexOf(remarkStripCjkAutolink)
        expect(idxAutolink).toBeGreaterThan(0) // not first (remarkGfm is first)
        expect(idxAutolink).toBeLessThan(idxCjk) // autolink before CJK strip
    })

    it('keeps hard-break parsing scoped to opt-in user prompt rendering', () => {
        expect(MARKDOWN_PLUGINS).not.toContain(remarkBreaks)
        expect(MARKDOWN_PLUGINS_WITH_BREAKS).toContain(remarkBreaks)
    })
})

function render(markdown: string, plugins: PluggableList = MARKDOWN_PLUGINS): string {
    const processor = unified()
        .use(remarkParse)
        .use(plugins)
        .use(remarkRehype)
        .use(MARKDOWN_REHYPE_PLUGINS)
    const tree = processor.runSync(processor.parse(markdown), markdown)
    return toHtml(tree as never)
}

describe('MARKDOWN_PLUGINS — currency prose vs KaTeX', () => {
    // Regression: prose with multiple "$N" amounts must NOT be eaten by KaTeX.
    // remarkMath is configured with `singleDollarTextMath: false` so single
    // dollar signs are treated as literal text, matching GitHub markdown.

    it('does not render single-$ currency amounts as KaTeX math', () => {
        const md = "The plan is $200/mo and the bill is $80 — total $400 saved."
        const html = render(md)
        expect(html).not.toContain('class="katex"')
        expect(html).not.toContain('<math')
        expect(html).toContain('$200')
        expect(html).toContain('$80')
        expect(html).toContain('$400')
    })

    it('does not render the reported real-world prose as KaTeX', () => {
        // Lifted (paraphrased) from the bug report: paragraph with multiple
        // "$N" amounts and apostrophes that previously collapsed into a single
        // KaTeX block and stripped whitespace from the running text.
        const md = "Cursor's UI quotes the ratio: at least $400 of API usage on a $200 plan. That's 2:1."
        const html = render(md)
        expect(html).not.toContain('class="katex"')
        expect(html).not.toContain('<math')
        expect(html).toContain('$400')
        expect(html).toContain('$200')
    })

    it('still renders block math with $$...$$ on its own lines', () => {
        const md = "Before\n\n$$\nE = mc^2\n$$\n\nAfter"
        const html = render(md)
        expect(html).toContain('class="katex"')
    })

    it.each([
        ['default', MARKDOWN_PLUGINS],
        ['standalone', MARKDOWN_PLUGINS_STANDALONE],
        ['with breaks', MARKDOWN_PLUGINS_WITH_BREAKS],
        ['standalone with breaks', MARKDOWN_PLUGINS_STANDALONE_WITH_BREAKS],
    ] as const)('renders TeX bracket delimiters in the %s pipeline', (_, plugins) => {
        const html = render('Inline \\(x^2 + y^2\\).\n\n\\[E = mc^2\\]', plugins)
        expect(html.match(/class="katex"/g)).toHaveLength(2)
        expect(html).toContain('katex-display')
    })

    it('recovers TeX display math split by CommonMark Setext headings', () => {
        const md = String.raw`\[
\mathcal L_{\text{OPD}}
=
\mathbb E_{y\sim\pi_\theta}
\left[
\sum_t D(\pi_\theta, \pi_T)
\right]
\]`
        const html = render(md)
        expect(html.match(/class="katex"/g)).toHaveLength(1)
        expect(html).toContain('katex-display')
        expect(html).not.toContain('<h1>')
    })

    it('recovers indented TeX display math inside a list item', () => {
        const md = String.raw`- \(q_t^*\): smoothed target
  \[
  q_t^*(a)\propto
  \pi_T(a\mid h_t,z)^\alpha
  \pi_{\rm ref}(a\mid h_t)^{1-\alpha}
  \]`
        const html = render(md)
        expect(html.match(/class="katex"/g)).toHaveLength(2)
        expect(html).toContain('katex-display')
    })

    it('does not reinterpret bracket delimiters inside code', () => {
        const html = render('Use `\\(x\\)` or:\n\n```tex\n\\[x\\]\n```')
        expect(html).not.toContain('class="katex"')
        expect(html).toContain('\\(x\\)')
        expect(html).toContain('\\[x\\]')
    })

    it('leaves empty bracket delimiters literal', () => {
        const html = render(String.raw`Keep \(\) and \[ \] literal.`)
        expect(html).not.toContain('class="katex"')
        expect(html).toContain('()')
        expect(html).toContain('[ ]')
    })

    it.each([
        ['TeX-heavy multiline output', String.raw`[
\mathcal L_{\text{OPD}}
\mathbb E_{y\sim\pi_\theta} \left[ \sum_t D(\pi_\theta, \pi_T) \right]
]`],
        ['sampled-token reward', String.raw`[
r_t = \log \pi_T(y_t\mid h_t,z) - \log \pi_\theta(y_t\mid h_t)
]`],
        ['blank-line-separated model output', String.raw`[ \mathcal L_{\text{OPD}}

\mathbb E_{y\sim\pi_\theta} \left[ \sum_t D\left( \pi_\theta(\cdot\mid h_t),

\operatorname{sg}\pi_T(\cdot\mid h_t,z) \right) \right], ]`],
        ['nested brackets ending an intermediate paragraph', String.raw`[ \mathbb E \left[ x \right]

+ y ]`],
        ['simple scripted equation', '[ E = mc^2 ]'],
    ])('recovers legacy square-bracket display math: %s', (_, md) => {
        const html = render(md)
        expect(html).toContain('class="katex"')
        expect(html).toContain('katex-display')
    })

    it.each([
        ['ordinary bracketed prose', '[Markdown 正常]'],
        ['numeric citation', '[12]'],
        ['Markdown link', '[OpenAI](https://openai.com)'],
        ['prose containing an equals sign', '[status = ready]'],
        ['Windows path', String.raw`[C:\Users\name]`],
        ['blank-line-separated prose', '[First paragraph\n\nSecond paragraph]'],
        ['inline bracketed math-like prose', 'Use [E = mc^2] as an example.'],
        ['code', '`[ E = mc^2 ]`'],
    ])('does not reinterpret non-display square brackets: %s', (_, md) => {
        const html = render(md)
        expect(html).not.toContain('class="katex"')
    })
})
