type BuildChunk = {
    file: string
    isEntry?: boolean
    imports?: string[]
    css?: string[]
    assets?: string[]
}

/** Include the entry's static dependency graph, leaving optional imports on demand. */
export function shellPrecachePaths(manifest: Record<string, BuildChunk>): Set<string> {
    const paths = new Set<string>()
    const visited = new Set<string>()
    const visit = (key: string) => {
        if (visited.has(key)) return
        visited.add(key)
        const chunk = manifest[key]
        if (!chunk) throw new Error(`Missing static build dependency: ${key}`)
        paths.add(chunk.file)
        for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) paths.add(file)
        for (const dependency of chunk.imports ?? []) visit(dependency)
    }
    for (const [key, chunk] of Object.entries(manifest)) {
        if (chunk.isEntry) visit(key)
    }
    if (visited.size === 0) throw new Error('No app entry in build manifest')
    return paths
}
