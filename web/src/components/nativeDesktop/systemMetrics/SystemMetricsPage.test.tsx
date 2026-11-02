import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ snapshot: null as unknown, connection: 'online', load: vi.fn(), data: null as any }));
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ token: 'test-only-token', baseUrl: 'https://private.example.test' }) }));
vi.mock('../useOrchestraSnapshot', () => ({ useOrchestraSnapshot: () => ({ snapshot: state.snapshot, connection: state.connection, refreshing: false, load: state.load }) }));
vi.mock('./SystemMetricsView', () => ({ SystemMetricsView: ({ data, onRefresh }: any) => { state.data = data; return <button onClick={onRefresh}>shared-refresh</button>; } }));
import { SystemMetricsPage } from './SystemMetricsPage';
import { aggregateSystemMetrics } from './systemMetrics';
beforeEach(() => {
    state.snapshot = { version: 1, generatedAt: new Date().toISOString(), tasks: [{ id: 'T021', execution: 'running', review: 'pending', archive: 'none' }], operations: [], collector: {} };
    state.connection = 'online'; state.load.mockReset(); state.data = null;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('passes an authorized shared snapshot through the pure adapter and uses only the shared refresh', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<SystemMetricsPage />); fireEvent.click(screen.getByText('shared-refresh'));
    expect(state.load).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
    expect(state.data.usage).toBeNull(); expect(state.data.coverage.historyComplete).toBe(false);
});
it('reads the exact registered report with existing auth, and repeated successful probes count once', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: '交接.md', content: '# Verified report' }) }); vi.stubGlobal('fetch', fetch);
    render(<SystemMetricsPage />);
    fireEvent.click(screen.getByRole('button', { name: '打开系统页交付报告' }));
    await screen.findByText('Verified report');
    fireEvent.click(screen.getByRole('button', { name: '打开系统页交付报告' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const args = fetch.mock.calls[0]!; expect(args[0]).toBe('https://private.example.test/api/orchestra/artifact?task=T021&index=0');
    expect(args[1].headers.authorization).toBe('Bearer test-only-token');
    await waitFor(() => expect(aggregateSystemMetrics(state.data).acceptance.artifactAccess).toMatchObject({ numerator: 1, denominator: 1 }));
});
it('keeps unavailable report reads as failed probes instead of asserting accessibility', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    render(<SystemMetricsPage />); fireEvent.click(screen.getByRole('button', { name: '打开系统页交付报告' }));
    await screen.findByRole('alert');
    expect(aggregateSystemMetrics(state.data).acceptance.artifactAccess).toMatchObject({ numerator: 0, denominator: 1 });
});
