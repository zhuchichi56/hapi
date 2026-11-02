import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexRuntime } from './native-host.mjs';
import { presentHistory } from './native-view.mjs';

function state(id, count = 60) {
  return {
    id,
    turns: [{ turnId: `${id}-turn`, items: Array.from({ length: count }, (_, index) => ({
      id: `item-${index}`, type: 'agentMessage', text: `message ${index}`, phase: 'final_answer',
    })) }],
    threadRuntimeStatus: { type: 'idle' },
  };
}

function desktopWith(states = {}, { subscribe } = {}) {
  const desktop = Object.assign(new EventEmitter(), {
    clientId: 'ready',
    threads: new Map(),
    connect: async () => { desktop.clientId = 'ready'; },
    unsubscribe: id => { desktop.threads.delete(id); },
  });
  desktop.subscribe = subscribe ?? (async id => {
    const current = states[id];
    if (!current) throw Error('No native thread owner');
    desktop.threads.set(id, { owner: 'native', state: current });
  });
  for (const [id, value] of Object.entries(states)) desktop.threads.set(id, { owner: 'native', state: value });
  return desktop;
}

const itemCount = view => view.turns.reduce((count, turn) => count + turn.items.length, 0);

test('a missing live snapshot reuses the short-lived live view instead of read_thread', async () => {
  let fallbacks = 0;
  const desktop = desktopWith({ hot: state('hot') });
  const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop, liveWaitMs: 20,
    callTool: async () => { fallbacks++; return { thread: { status: 'active' }, turns: [{ id: 'rpc', items: [] }], page: { hasMore: true } }; } });

  const first = await runtime.read('hot');
  assert.equal(first.live, true);
  assert.equal(itemCount(first), 60);

  // Stream eviction / reconnect: the owner exists but its snapshot is not here.
  desktop.threads.delete('hot');
  desktop.subscribe = () => new Promise(() => {});
  const second = await runtime.read('hot');
  assert.equal(fallbacks, 0);
  assert.equal(second.live, true);
  assert.deepEqual(second, first);
  const revision = presentHistory(first).revision;
  assert.deepEqual(presentHistory(second, { since: revision }), { id: 'hot', revision, unchanged: true });
});

test('an expired live gap fails explicitly and never calls read_thread', async () => {
  let fallbacks = 0;
  const desktop = desktopWith({ hot: state('hot') });
  const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop, liveWaitMs: 10, liveHoldMs: 1,
    callTool: async () => { fallbacks++; return { turns: [], page: { hasMore: true } }; } });
  assert.equal((await runtime.read('hot')).live, true);
  desktop.threads.delete('hot');
  desktop.subscribe = () => new Promise(() => {});
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(runtime.read('hot'), /桌面实时快照暂不可用/);
  assert.equal(fallbacks, 0);
  assert.equal(runtime.ownerSeen.has('hot'), true);
});

test('a thread that never had an owner still reads original history', async () => {
  let fallbacks = 0;
  const desktop = desktopWith({}, { subscribe: async () => { throw Error('No native thread owner'); } });
  const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop,
    callTool: async name => { assert.equal(name, 'read_thread'); fallbacks++; return {
      thread: { status: 'idle' }, turns: [{ id: 'old', items: [{ id: 'u', type: 'userMessage', content: [{ text: 'old' }] }] }],
      page: { hasMore: true } }; } });
  const view = await runtime.read('ownerless');
  assert.equal(fallbacks, 1);
  assert.equal(view.live, false);
  assert.equal(view.historyComplete, false);
  assert.equal(runtime.liveViews.has('ownerless'), false);
});

test('a snapshot that arrives during the fallback RPC wins the race', async () => {
  const desktop = desktopWith({}, { subscribe: async () => { throw Error('No native thread owner'); } });
  const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop,
    callTool: async () => {
      desktop.threads.set('race', { owner: 'native', state: state('race', 7) });
      return { thread: { status: 'idle' }, turns: [{ id: 'rpc', items: [{ id: 'u', type: 'userMessage', content: [{ text: 'stale' }] }] }], page: { hasMore: true } };
    } });
  const view = await runtime.read('race');
  assert.equal(view.live, true);
  assert.equal(itemCount(view), 7);
  assert.equal(view.turns[0].id, 'race-turn');
});

test('a newly edited or trimmed owner snapshot is accepted, not merged monotonically', async () => {
  let current = state('hot', 60);
  const desktop = desktopWith({ hot: current });
  const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop, liveWaitMs: 50 });
  assert.equal(itemCount(await runtime.read('hot')), 60);
  current = state('hot', 4);
  desktop.threads.clear();
  desktop.clientId = null;
  desktop.subscribe = async id => { desktop.threads.set(id, { owner: 'native', state: current }); };
  const view = await runtime.read('hot');
  assert.equal(view.live, true);
  assert.equal(itemCount(view), 4);
});

test('a recently read stream survives list-hydration eviction; the cap stays four', async () => {
  const desktop = desktopWith({ hot: state('hot'), idleA: state('idleA', 1), idleB: state('idleB', 1), idleC: state('idleC', 1) });
  desktop.subscribe = async id => { desktop.threads.set(id, { owner: 'native', state: state(id, 1) }); };
  const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop });
  assert.equal((await runtime.read('hot')).live, true);
  await runtime.connectStream('idleD');
  assert.equal(desktop.threads.has('hot'), true);
  assert.equal(desktop.threads.has('idleA'), false);
  assert.equal(desktop.threads.size, 4);
});

test('four concurrently read conversations keep their native subscriptions', async () => {
  const desktop = desktopWith({});
  desktop.subscribe = async id => { desktop.threads.set(id, { owner: 'native', state: state(id, 2) }); };
  const runtime = new CodexRuntime({ callerThreadId: 'caller', desktop });
  const views = await Promise.all(['one', 'two', 'three', 'four'].map(id => runtime.read(id)));
  assert.deepEqual(views.map(view => view.live), [true, true, true, true]);
  assert.deepEqual([...desktop.threads.keys()].sort(), ['four', 'one', 'three', 'two']);
});

test('an in-flight fallback cannot overwrite live state another reader observed and lost', async () => {
  const desktop = desktopWith({}, { subscribe: async () => { throw Error('No native thread owner'); } });
  let runtime;
  runtime = new CodexRuntime({ callerThreadId: 'caller', desktop,
    callTool: async () => {
      runtime.rememberLive('race', { id: 'race', live: true, turns: [{ id: 'new', items: [{ id: 'new', role: 'assistant', text: 'latest' }] }] });
      return { thread: { status: 'idle' }, turns: [], page: { hasMore: true } };
    } });
  const view = await runtime.read('race');
  assert.equal(view.live, true);
  assert.equal(view.turns[0].id, 'new');
  assert.equal(runtime.ownerSeen.has('race'), true);
});
