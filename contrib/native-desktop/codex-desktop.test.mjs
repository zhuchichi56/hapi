import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CodexDesktop, applyPatches, projectConversation } from './codex-desktop.mjs';

const frame = message => {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'native-ipc-'));
  await chmod(dir, 0o700);
  const socketPath = join(dir, 'ipc.sock');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0);
        const msg = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        const send = (result, split = false) => {
          const bytes = frame(result);
          if (split) { socket.write(bytes.subarray(0, 2)); setImmediate(() => { if (!socket.destroyed) socket.write(bytes.subarray(2)); }); }
          else socket.write(bytes);
        };
        if (msg.method === 'initialize') send({ type: 'response', method: msg.method,
          requestId: msg.requestId, resultType: 'success', result: { clientId: 'reader' } }, true);
        else handler(msg, send, socket);
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);
  const client = new CodexDesktop({ socketPath, timeoutMs: 100 });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true });
  });
  return { client, socketPath };
}
const success = (msg, result = {}) => ({ type: 'response', method: msg.method,
  requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result });
const broadcast = (change, extras = {}) => ({ type: 'broadcast', method: 'thread-stream-state-changed',
  version: 11, sourceClientId: 'owner', params: { hostId: 'local', conversationId: 't', change }, ...extras });
const snapshot = { type: 'snapshot', revision: 1, conversationState: { id: 't', title: 'original' } };

test('native write transport errors distinguish undispatched from uncertain delivery', async () => {
  const client = new CodexDesktop({allowControl:true,timeoutMs:10});
  const method = 'thread-follower-start-turn';
  await assert.rejects(client.request(method,{}), error => error.delivery === 'not-sent');
  client.socket = {destroyed:false,write(){},destroy(){}};
  await assert.rejects(client.request(method,{}), error => error.delivery === 'unknown');
  const dispatched = client.request(method,{});
  client.disconnect(Error('transport lost'));
  await assert.rejects(dispatched, error => error.delivery === 'unknown');
  client.socket = {destroyed:false,write(){},destroy(){}};
  await assert.rejects(client.request('thread-owner-discovery',{}), error => error.delivery === undefined);
  client.close();
});

test('fragmented frames, native owner, snapshot and incremental patch', async t => {
  const { client } = await fixture(t, (msg, send) => {
    if (msg.type === 'request') send(success(msg));
    else if (msg.params?.following) {
      send(broadcast(snapshot), true);
    }
  });
  await client.connect();
  const state = once(client, 'state');
  await client.subscribe('t');
  assert.equal((await state)[0].state.title, 'original');
  client.handle(broadcast({ type: 'patches', baseRevision: 1, revision: 2,
    patches: [{ op: 'replace', path: ['title'], value: 'changed' }] }));
  assert.equal(client.threads.get('t').state.title, 'changed');
});

test('foreign owner cannot replace a subscribed snapshot; revision gaps invalidate cached state', async t => {
  const { client } = await fixture(t, (msg, send) => { if (msg.type === 'request') send(success(msg)); });
  await client.connect();
  await client.subscribe('t');
  client.handle(broadcast(snapshot, { sourceClientId: 'foreign' }));
  assert.equal(client.threads.get('t').state, null);
  client.handle(broadcast(snapshot));
  const stale = once(client, 'stale');
  client.handle(broadcast({ type: 'patches', revision: 3, baseRevision: 2, patches: [] }));
  assert.equal((await stale)[0].reason, 'revision-gap');
  assert.equal(client.threads.get('t').state, null);
});

test('unsupported protocol and malformed frames are rejected', async t => {
  const { client } = await fixture(t, (msg, send) => { if (msg.type === 'request') send(success(msg)); });
  await client.connect();
  await client.subscribe('t');
  assert.throws(() => client.handle(broadcast(snapshot, { version: 999 })), /protocol/);
  assert.throws(() => client.receive(Buffer.from([255, 255, 255, 127])), /frame length/);
});

test('unavailable native owner never creates a replacement engine', async t => {
  const { client } = await fixture(t, (msg, send) => send({ type: 'response',
    requestId: msg.requestId, resultType: 'error', error: 'no-client-found' }));
  await client.connect();
  await assert.rejects(client.subscribe('missing'), /no-client-found/);
  assert.equal(client.threads.size, 0);
  await assert.rejects(client.request('thread-follower-start-turn', {}), /allowlist/);
});

test('invalid incoming wire frame disconnects and invalidates subscriptions', async t => {
  const { client } = await fixture(t, (msg, send, socket) => {
    if (msg.type === 'request') send(success(msg));
    else if (msg.params?.following) socket.write(Buffer.from([255, 255, 255, 127]));
  });
  await client.connect();
  const offline = once(client, 'offline');
  await client.subscribe('t');
  assert.match((await offline)[0].reason, /frame length/);
  assert.equal(client.threads.size, 0);
  assert.equal(client.socket, null);
});

test('timeouts are not retried and disconnect rejects in-flight requests', async t => {
  let count = 0;
  const { client } = await fixture(t, () => { count++; });
  await client.connect();
  await assert.rejects(client.subscribe('t'), /timed out/);
  assert.equal(count, 1);
  const pending = client.request('thread-owner-discovery', { conversationId: 't', hostId: 'local' });
  client.close();
  await assert.rejects(pending, /closed/);
  assert.equal(client.pending.size, 0);
});

test('world-accessible native sockets are rejected', async t => {
  const { client, socketPath } = await fixture(t, () => {});
  await chmod(socketPath, 0o666);
  await assert.rejects(client.connect(), /private/);
});

test('patches preserve source, validate paths, and support Immer array operations', () => {
  const original = { list: ['a', 'b'], title: 'before' };
  const updated = applyPatches(original, [
    { op: 'replace', path: ['title'], value: 'after' },
    { op: 'add', path: ['list', 1], value: 'c' },
    { op: 'replace', path: ['list', 'length'], value: 2 },
  ]);
  assert.deepEqual(updated, { list: ['a', 'c'], title: 'after' });
  assert.equal(original.title, 'before');
  assert.throws(() => applyPatches(original, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]), /Unsafe/);
  assert.throws(() => applyPatches(original, [{ op: 'replace', path: ['missing'], value: 1 }]), /Missing/);
});

test('canonical histories preserve native island order and deduplicate entries', () => {
  const state = { id: 't', turns: [], turnHistory: { kind: 'canonical', history: {
    isComplete: false, entitiesByKey: { a: { turnId: 'one', items: [] }, b: { turnId: 'two', items: [] } },
    islands: [{ entries: [{ value: 'b' }, { value: 'a' }, { value: 'b' }] }],
  } } };
  const view = projectConversation(state);
  assert.deepEqual(view.turns.map(turn => turn.nativeTurnId), ['two', 'one']);
  assert.equal(view.historyComplete, false);
});
