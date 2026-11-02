import { OrchestraBoard } from './OrchestraBoard';
import { SystemMetricsPage } from './systemMetrics/SystemMetricsPage';
import './OrchestraWorkspace.css';

export function OrchestraWorkspace({ view }: { view: 'orchestra' | 'orchestra-system' }) {
    return <main className="os-workspace">
        <nav className="os-navigation" aria-label="总控视图">
            <a href="/desktop?app=codex&view=orchestra" aria-current={view === 'orchestra' ? 'page' : undefined}>任务总控</a>
            <a href="/desktop?app=codex&view=orchestra-system" aria-current={view === 'orchestra-system' ? 'page' : undefined}>系统运行</a>
        </nav>
        <div className="os-content">{view === 'orchestra-system' ? <SystemMetricsPage /> : <OrchestraBoard />}</div>
    </main>;
}
