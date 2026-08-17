import type { Processor } from 'unified'

interface MarkdownNode {
    type: string
    value?: string
    children?: MarkdownNode[]
    position?: {
        start?: { offset?: number }
        end?: { offset?: number }
    }
    data?: unknown
}

interface MarkdownFile {
    value?: unknown
}

const LATEX_DELIMITER = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g
const MARKDOWN_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g
const TEX_CONTROL_WORD = /\\([A-Za-z]+)/g
const EQUATION_WITH_SCRIPT = /(?:[A-Za-z0-9})\s*(?:\^|_)\s*(?:[A-Za-z0-9{])/u
const COMMON_TEX_MATH_COMMANDS = new Set([
    'alpha', 'beta', 'boxed', 'cdot', 'cos', 'delta', 'epsilon', 'exp', 'frac',
    'gamma', 'geq', 'infty', 'int', 'lambda', 'left', 'leq', 'lim', 'log',
    'mathbb', 'mathbf', 'mathcal', 'mathrm', 'mu', 'nabla', 'neq', 'omega',
    'operatorname', 'partial', 'phi', 'pi', 'pm', 'prod', 'psi', 'rho', 'right',
    'sigma', 'sin', 'sqrt', 'sum', 'tan', 'text', 'theta', 'times',
])
const OPAQUE_NODE_TYPES = new Set([
    'code',
    'inlineCode',
    'math',
    'inlineMath',
    'link',
    'linkReference',
    'html',
])
const LEGACY_MATH_SEQUENCE_NODE_TYPES = new Set(['paragraph', 'list', 'blockquote'])

function decodeMarkdownEscapes(value: string): string {
    return value.replace(MARKDOWN_ESCAPE, '$1')
}

function replaceLatexDelimitersOutsideCode(source: string): string {
    const protectedOffsets = new Uint8Array(source.length)
    let fenceCharacter = ''
    let fenceLength = 0
    let inlineCodeTicks = 0
    let lineStart = 0

    while (lineStart < source.length) {
        const newline = source.indexOf('\n', lineStart)
        const lineEnd = newline === -1 ? source.length : newline
        const line = source.slice(lineStart, lineEnd).replace(/\r$/, '')
        const fence = line.match(/^[ \t]*(`{3,}|~{3,})/)
        if (fence && inlineCodeTicks === 0) {
            const marker = fence[1] ?? ''
            const character = marker[0] ?? ''
            if (!fenceCharacter) {
                fenceCharacter = character
                fenceLength = marker.length
            } else if (
                character === fenceCharacter
                && marker.length >= fenceLength
                && line.slice((fence.index ?? 0) + marker.length).trim().length === 0
            ) {
                fenceCharacter = ''
                fenceLength = 0
            }
            protectedOffsets.fill(1, lineStart, newline === -1 ? lineEnd : lineEnd + 1)
            lineStart = newline === -1 ? source.length : lineEnd + 1
            continue
        }
        if (fenceCharacter) {
            protectedOffsets.fill(1, lineStart, newline === -1 ? lineEnd : lineEnd + 1)
            lineStart = newline === -1 ? source.length : lineEnd + 1
            continue
        }

        for (let index = lineStart; index < lineEnd;) {
            if (source[index] === '`') {
                let end = index + 1
                while (source[end] === '`') end += 1
                const ticks = end - index
                if (inlineCodeTicks === 0) inlineCodeTicks = ticks
                else if (inlineCodeTicks === ticks) inlineCodeTicks = 0
                protectedOffsets.fill(1, index, end)
                index = end
                continue
            }
            if (inlineCodeTicks > 0) protectedOffsets[index] = 1
            index += 1
        }
        if (inlineCodeTicks > 0 && newline !== -1) protectedOffsets[newline] = 1
        lineStart = newline === -1 ? source.length : lineEnd + 1
    }

    return source.replace(LATEX_DELIMITER, (match, displayValue, inlineValue, offset: number) => {
        const value = displayValue ?? inlineValue ?? ''
        const singleLineDisplay = displayValue !== undefined && !match.includes('\n')
        const escapedOpening = offset > 0 && source[offset - 1] === '\\'
        const escapedClosing = match.length >= 3 && match[match.length - 3] === '\\'
        const intersectsCode = protectedOffsets.subarray(offset, offset + match.length).some(Boolean)
        if (value.trim().length === 0 || singleLineDisplay || escapedOpening || escapedClosing || intersectsCode) return match
        return `$$${value}$$`
    })
}

function createMathNode(type: 'math' | 'inlineMath', value: string): MarkdownNode {
    if (type === 'math') {
        return {
            type,
            value,
            data: {
                hName: 'pre',
                hChildren: [{
                    type: 'element',
                    tagName: 'code',
                    properties: { className: ['language-math', 'math-display'] },
                    children: [{ type: 'text', value }],
                }],
            },
        }
    }

    return {
        type,
        value,
        data: {
            hName: 'code',
            hProperties: { className: ['language-math', 'math-inline'] },
            hChildren: [{ type: 'text', value }],
        },
    }
}

function closesOuterSquareBracket(raw: string): boolean {
    let depth = 0
    for (let index = 0; index < raw.length; index += 1) {
        if (raw[index] === '[') depth += 1
        if (raw[index] !== ']') continue

        depth -= 1
        if (depth === 0) return index === raw.length - 1
        if (depth < 0) return false
    }
    return false
}

function recoverLegacyBracketDisplayMath(rawSource: string): MarkdownNode | null {
    const raw = rawSource.trim()
    if (!raw.startsWith('[') || !closesOuterSquareBracket(raw)) return null

    const value = raw.slice(1, -1).trim()
    if (value.length === 0) return null

    // Some model responses use plain square brackets as display-math
    // delimiters. Recover only a whole standalone paragraph with strong math
    // evidence, so prose, citations, and Markdown links keep their meaning.
    const texCommands = [...value.matchAll(TEX_CONTROL_WORD)].map((match) => match[1] ?? '')
    const hasTexCommand = texCommands.some((command) => COMMON_TEX_MATH_COMMANDS.has(command))
    const hasEquationWithScript = value.includes('=')
        && (value.includes('^') || value.includes('_'))
        && EQUATION_WITH_SCRIPT.test(value)
    if (!hasTexCommand && !hasEquationWithScript) return null

    return createMathNode('math', value)
}

function recoverLegacyBracketMathSequence(
    children: MarkdownNode[],
    startIndex: number,
    source: string,
): { endIndex: number; node: MarkdownNode } | null {
    const first = children[startIndex]
    if (first?.type !== 'paragraph') return null

    const start = first.position?.start?.offset
    const firstEnd = first.position?.end?.offset
    if (typeof start !== 'number' || typeof firstEnd !== 'number') return null
    if (!source.slice(start, firstEnd).trimStart().startsWith('[')) return null

    // Blank lines inside model-generated formulas become separate Markdown
    // blocks. Leading +, -, or > can also make a formula line parse as a list
    // or quote. Join only a short run of those sibling blocks, then apply the
    // same strict math-evidence check used for a single paragraph.
    const lastIndex = Math.min(children.length - 1, startIndex + 7)
    for (let endIndex = startIndex; endIndex <= lastIndex; endIndex += 1) {
        const current = children[endIndex]
        if (!current || !LEGACY_MATH_SEQUENCE_NODE_TYPES.has(current.type)) return null

        const end = current.position?.end?.offset
        if (typeof end !== 'number') return null

        const raw = source.slice(start, end).trim()
        if (!closesOuterSquareBracket(raw)) continue

        const node = recoverLegacyBracketDisplayMath(raw)
        return node ? { endIndex, node } : null
    }
    return null
}

function splitTextNode(node: MarkdownNode, source: string): MarkdownNode[] {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (typeof start !== 'number' || typeof end !== 'number') return [node]

    const raw = source.slice(start, end)
    if (!raw.includes('\\[') && !raw.includes('\\(')) return [node]
    if (decodeMarkdownEscapes(raw) !== node.value) return [node]

    const matches = [...raw.matchAll(LATEX_DELIMITER)]
    if (matches.length === 0) return [node]

    const children: MarkdownNode[] = []
    let cursor = 0
    for (const match of matches) {
        const index = match.index
        if (index > cursor) {
            children.push({ type: 'text', value: decodeMarkdownEscapes(raw.slice(cursor, index)) })
        }

        const displayValue = match[1]
        const inlineValue = match[2]
        const value = (displayValue ?? inlineValue ?? '').trim()
        children.push(value.length > 0
            ? createMathNode(displayValue === undefined ? 'inlineMath' : 'math', value)
            : { type: 'text', value: decodeMarkdownEscapes(match[0]) })
        cursor = index + match[0].length
    }

    if (cursor < raw.length) {
        children.push({ type: 'text', value: decodeMarkdownEscapes(raw.slice(cursor)) })
    }
    return children
}

function hoistDisplayMath(node: MarkdownNode): MarkdownNode[] | null {
    const children = node.children ?? []
    const isDisplayOrWhitespace = (child: MarkdownNode) => child.type === 'math'
        || (child.type === 'text' && (child.value ?? '').trim().length === 0)
    if (!children.some((child) => child.type === 'math')) return null
    if (!children.every(isDisplayOrWhitespace)) return null
    return children.filter((child) => child.type === 'math')
}

function transformContainer(node: MarkdownNode, source: string): void {
    if (!node.children) return

    const children: MarkdownNode[] = []
    for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index]
        if (!child) continue

        const recoveredSequence = recoverLegacyBracketMathSequence(node.children, index, source)
        if (recoveredSequence) {
            children.push(recoveredSequence.node)
            index = recoveredSequence.endIndex
            continue
        }
        if (OPAQUE_NODE_TYPES.has(child.type)) {
            children.push(child)
            continue
        }
        if (child.type === 'text') {
            children.push(...splitTextNode(child, source))
            continue
        }

        transformContainer(child, source)
        const displayMath = child.type === 'paragraph' ? hoistDisplayMath(child) : null
        children.push(...(displayMath ?? [child]))
    }
    node.children = children
}

/** Convert TeX bracket delimiters before CommonMark escape information is lost. */
export default function remarkLatexBracketMath(this: Processor) {
    const parser = this.parser
    if (parser) {
        this.parser = (document, file) => parser.call(
            this,
            replaceLatexDelimitersOutsideCode(document),
            file,
        )
    }

    return (tree: MarkdownNode, file: MarkdownFile): void => {
        if (typeof file.value !== 'string') return
        transformContainer(tree, file.value)
    }
}
