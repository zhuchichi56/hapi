import { describe, expect, it } from 'vitest'
import { shellPrecachePaths } from './shellPrecache'

describe('shellPrecachePaths', () => {
    it('keeps static dependencies and CSS/assets, excluding optional modules', () => {
        const paths = shellPrecachePaths({
            'index.html': { file: 'assets/app.js', isEntry: true, imports: ['react'], css: ['assets/app.css'] },
            react: { file: 'assets/react.js', imports: ['shared'] },
            shared: { file: 'assets/shared.js', imports: ['react'], assets: ['assets/logo.svg'] },
            terminal: { file: 'assets/terminal.js', css: ['assets/terminal.css'] },
            mermaid: { file: 'assets/mermaid.js' }
        })
        expect([...paths].sort()).toEqual(['assets/app.css', 'assets/app.js', 'assets/logo.svg', 'assets/react.js', 'assets/shared.js'])
    })

    it('fails the build rather than silently producing an incomplete offline shell', () => {
        expect(() => shellPrecachePaths({})).toThrow('No app entry')
        expect(() => shellPrecachePaths({ app: { file: 'app.js', isEntry: true, imports: ['missing'] } })).toThrow('Missing static build dependency')
    })
})
