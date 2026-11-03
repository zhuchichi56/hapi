import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { CodexRuntime } = await import(process.env.NATIVE_HOST_TEST_TARGET ?? './native-host.mjs');
const snapshot = title => ({ id: 'original', title, turns: [], threadRuntimeStatus: { type: 'idle' } });
const history = title => ({ thread: { title, status: 'idle' }, turns: [], page: { hasMore: false } });
const desktopFixture = () => Object.assign(new EventEmitter(), { clientId: 'native', threads: new Map(),
    subscribe: async () => { throw Error('No current native owner'); }, unsubscribe(id) { this.threads.delete(id); } });

test('a discovered owner without a snapshot cannot permanently block original history', async () => {
    const desktop = desktopFixture();
    desktop.threads.set('original', { owner: 'retired-owner', state: null });
    let reads = 0;
    const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop, liveWaitMs: 1,
        callTool: async name => { assert.equal(name, 'read_thread'); reads++; return history('Original history'); } });
    const result = await runtime.read('original');
    assert.equal(result.live, false);
    assert.equal(result.title, 'Original history');
    assert.equal(reads, 1);
});

test('a brief snapshot gap retains live content, expiry reads fresh original history, and live resumes', async () => {
    const desktop = desktopFixture();
    desktop.threads.set('original', { owner: 'native-owner', state: snapshot('Live content') });
    let reads = 0;
    const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop, liveWaitMs: 0, liveHoldMs: 5000,
        callTool: async name => { assert.equal(name, 'read_thread'); reads++; return history('Fresh original history'); } });
    runtime.connectStream = async () => {};
    const live = await runtime.read('original');
    assert.equal(live.live, true);
    desktop.threads.clear();
    assert.deepEqual(await runtime.read('original'), live);
    assert.equal(reads, 0);
    runtime.liveViews.get('original').at = Date.now() - 5001;
    const fallback = await runtime.read('original');
    assert.equal(fallback.live, false);
    assert.equal(fallback.title, 'Fresh original history');
    assert.equal(reads, 1);
    desktop.threads.set('original', { owner: 'replacement-owner', state: snapshot('New native content') });
    const resumed = await runtime.read('original');
    assert.equal(resumed.live, true);
    assert.equal(resumed.title, 'New native content');
    assert.equal(reads, 1);
});

test('live state arriving during the original-history read wins the race', async () => {
    const desktop = desktopFixture();
    const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop, callTool: async name => {
        assert.equal(name, 'read_thread');
        desktop.threads.set('original', { owner: 'new-owner', state: snapshot('Latest native content') });
        return history('Earlier historical response');
    } });
    runtime.connectStream = async () => {};
    const result = await runtime.read('original');
    assert.equal(result.live, true);
    assert.equal(result.title, 'Latest native content');
});

test('optional complete-history timeout preserves the current live snapshot', async () => {
    const desktop = desktopFixture();
    desktop.threads.set('original', { owner: 'native-owner', state: { ...snapshot('Current content'),
        turnHistory: { kind: 'canonical', history: { islands: [], hasMore: true } } } });
    desktop.request = async method => { throw Error(`Desktop request timed out: ${method}`); };
    const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop,
        callTool: async () => assert.fail('must retain live state') });
    const result = await runtime.read('original', { complete: true });
    assert.equal(result.live, true);
    assert.equal(result.title, 'Current content');
    assert.equal(result.historyComplete, false);
    assert.match(result.historyLoadError, /较早的消息加载超时/);
});
