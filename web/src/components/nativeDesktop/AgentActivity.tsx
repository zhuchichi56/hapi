export type Delegations = { running: number; tasks: { id: string; number?: number; title: string; state: string; label?: string }[] }

export function AgentActivity({ delegations }: { delegations?: Delegations }) {
    const tasks = delegations?.tasks.filter(task => task.state === 'running') ?? []
    if (!tasks.length) return null
    return <span className="nd-agent-activity" role="img" aria-label={`${tasks.length} 个子 Agent 正在运行`} title={`${tasks.length} 个子 Agent 正在运行`}>
        {tasks.map(task => <i key={task.id} aria-hidden="true" title={`${task.label ?? 'DSH'} ${task.number ?? ''} · ${task.title}`} />)}
    </span>
}
