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

function decodeMarkdownEscapes(value: string): string {
    return value.replace(MARKDOWN_ESCAPE, '$1')
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

function recoverLegacyBracketDisplayMath(node: MarkdownNode, source: string): MarkdownNode | null {
    if (node.type !== 'paragraph') return null

    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (typeof start !== 'number' || typeof end !== 'number') return null

    const raw = source.slice(start, end).trim()
    if (!raw.startsWith('[') || !raw.endsWith(']')) return null

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
    for (const child of node.children) {
        if (OPAQUE_NODE_TYPES.has(child.type)) {
            children.push(child)
            continue
        }
        const recoveredMath = recoverLegacyBracketDisplayMath(child, source)
        if (recoveredMath) {
            children.push(recoveredMath)
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
export default function remarkLatexBracketMath() {
    return (tree: MarkdownNode, file: MarkdownFile): void => {
        if (typeof file.value !== 'string') return
        transformContainer(tree, file.value)
    }
}
