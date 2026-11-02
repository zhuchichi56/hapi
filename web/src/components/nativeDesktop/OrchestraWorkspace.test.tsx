import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { parseNativeSearch } from './navigation';
vi.mock('./OrchestraBoard', () => ({ OrchestraBoard: () => <div data-testid="task-board">Tasks</div> }));
vi.mock('./systemMetrics/SystemMetricsPage', () => ({ SystemMetricsPage: () => <div data-testid="system-view">System</div> }));
import { OrchestraWorkspace } from './OrchestraWorkspace';
afterEach(cleanup);
it('allows only known system/task views and retains the native thread identity', () => {
    expect(parseNativeSearch({ app: 'codex', view: 'orchestra-system', thread: 'native-id' })).toEqual({ app: 'codex', view: 'orchestra-system', thread: 'native-id' });
    expect(parseNativeSearch({ view: 'arbitrary' }).view).toBeUndefined();
});
it('mounts either the existing board or the system view, never both snapshot consumers', () => {
    const r = render(<OrchestraWorkspace view="orchestra" />);
    expect(screen.getByTestId('task-board')).toBeTruthy();
    expect(screen.queryByTestId('system-view')).toBeNull();
    r.rerender(<OrchestraWorkspace view="orchestra-system" />);
    expect(screen.getByTestId('system-view')).toBeTruthy();
    expect(screen.queryByTestId('task-board')).toBeNull();
    expect(screen.getByRole('link', { name: '系统运行' }).getAttribute('aria-current')).toBe('page');
});
