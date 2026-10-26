import net from 'node:net';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// Observed in the installed Codex desktop, CLI 0.163.0. Internal protocol.
const versions = Object.freeze({
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-read-model-settings': 1,
  'thread-follower-load-complete-history': 1,
});
const controlVersions = Object.freeze({
  'thread-follower-start-turn': 2,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-user-input': 1,
});
const MAX_FRAME = 32 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

/** Apply JSON-compatible Immer patches atomically, without mutating the source. */
export function applyPatches(source, patches) {
  if (!Array.isArray(patches)) throw Error('Invalid patch list');
  let result = structuredClone(source);
  for (const { op, path, value } of patches) {
    if (!['add', 'replace', 'remove'].includes(op) || !Array.isArray(path)) throw Error('Invalid patch');
    if (path.some(key => !['string', 'number'].includes(typeof key) ||
        ['__proto__', 'prototype', 'constructor'].includes(String(key)))) throw Error('Unsafe patch path');
    if (!path.length) {
      if (op === 'remove') throw Error('Cannot remove snapshot root');
      result = structuredClone(value);
      continue;
    }
    let parent = result;
    for (const key of path.slice(0, -1)) {
      if (!object(parent) && !Array.isArray(parent) || !own(parent, key)) throw Error('Missing patch parent');
      parent = parent[key];
    }
    const key = path.at(-1);
    if (Array.isArray(parent)) {
      // Immer emits an array length replacement when truncating arrays.
      if (key === 'length' && op === 'replace' && Number.isInteger(value) && value >= 0 && value <= parent.length) {
        parent.length = value;
        continue;
      }
      if (!Number.isInteger(key) || key < 0 || key > parent.length || op !== 'add' && key === parent.length)
        throw Error('Invalid array patch index');
      if (op === 'remove') parent.splice(key, 1);
      else if (op === 'add') parent.splice(key, 0, structuredClone(value));
      else parent[key] = structuredClone(value);
    } else {
      if (!object(parent) || op !== 'add' && !own(parent, key)) throw Error('Missing patch target');
      if (op === 'remove') delete parent[key];
      else parent[key] = structuredClone(value);
    }
  }
  return result;
}

/** Read-only adapter. Never starts, resumes, forks, or takes ownership of a native thread. */
export class CodexDesktop extends EventEmitter {
  constructor({ socketPath = join(homedir(), '.codex/ipc/ipc.sock'), timeoutMs = 5000, allowControl = false } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.allowControl = allowControl;
    this.clientId = null;
    this.pending = new Map();
    this.threads = new Map();
    this.buffer = Buffer.alloc(0);
    this.socket = null;
  }

  async connect() {
    if (this.socket) throw Error('Already connected or connecting');
    for (const [path, isSocket] of [[dirname(this.socketPath), false], [this.socketPath, true]]) {
      const stat = lstatSync(path);
      if ((isSocket ? !stat.isSocket() : !stat.isDirectory()) || stat.uid !== process.getuid() || stat.mode & 0o077)
        throw Error('Native IPC path must be private and owned by the current user');
    }
    const activeSocket = net.createConnection(this.socketPath);
    this.socket = activeSocket;
    this.buffer = Buffer.alloc(0);
    activeSocket.on('data', chunk => {
      if (this.socket !== activeSocket) return;
      try { this.receive(chunk); } catch (error) { activeSocket.destroy(error); }
    });
    activeSocket.on('error', error => { if (this.socket === activeSocket) this.disconnect(error); });
    activeSocket.on('close', () => { if (this.socket === activeSocket) this.disconnect(Error('Desktop disconnected')); });
    try {
      await new Promise((resolve, reject) => {
        const socket = this.socket;
        const timer = setTimeout(() => finish(Error('Desktop connect timeout')), this.timeoutMs);
        const finish = error => {
          clearTimeout(timer);
          socket.off('connect', connected);
          socket.off('error', failed);
          error ? reject(error) : resolve();
        };
        const connected = () => finish();
        const failed = error => finish(error);
        socket.once('connect', connected);
        socket.once('error', failed);
      });
      const response = await this.request('initialize', { clientType: 'native-session-readonly' });
      if (typeof response.result?.clientId !== 'string') throw Error('Invalid initialization result');
      this.clientId = response.result.clientId;
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  write(message) {
    if (!this.socket || this.socket.destroyed) throw Error('Desktop unavailable');
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME) throw Error('IPC frame exceeds limit');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  request(method, params, targetClientId) {
    const version = versions[method] ?? (this.allowControl ? controlVersions[method] : undefined);
    if (version === undefined) return Promise.reject(Error('Read-only method allowlist rejected request'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Error(`Desktop request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method });
      try {
        this.write({ type: 'request', requestId, sourceClientId: this.clientId ?? 'initializing-client',
          version, method, params, timeoutMs: this.timeoutMs,
          ...(targetClientId ? { targetClientId } : {}) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME) throw Error('Invalid IPC frame length');
      if (this.buffer.length < length + 4) return;
      const message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
      this.buffer = this.buffer.subarray(length + 4);
      if (!object(message)) throw Error('Invalid IPC envelope');
      this.handle(message);
    }
  }

  handle(message) {
    if (message.type === 'client-discovery-request') {
      this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.method !== undefined && message.method !== pending.method) pending.reject(Error('Unexpected IPC response method'));
      else if (message.resultType === 'success') pending.resolve(message);
      else pending.reject(Error(`Desktop request failed: ${String(message.error)}`));
      return;
    }
    if (message.type !== 'broadcast') return;
    if (message.method === 'ipc-connection-reset') {
      this.close();
      return;
    }
    if (message.method !== 'thread-stream-state-changed') return;
    const params = message.params;
    if (!object(params) || params.hostId !== 'local') return;
    const thread = this.threads.get(params.conversationId);
    if (!thread || thread.owner !== message.sourceClientId) return;
    if (message.version !== 11) throw Error('Unsupported native stream protocol version');
    const change = params.change;
    if (!object(change) || !Number.isSafeInteger(change.revision) || change.revision < 0) throw Error('Invalid stream revision');
    if (thread.revision !== null && change.revision <= thread.revision) return;
    if (change.type === 'snapshot') {
      if (!object(change.conversationState) || change.conversationState.id !== params.conversationId) throw Error('Invalid snapshot identity');
      thread.state = change.conversationState;
    } else if (change.type === 'patches') {
      if (thread.state === null || change.baseRevision !== thread.revision) {
        // Clear stale state; caller must explicitly subscribe again to acquire a fresh snapshot.
        thread.state = null;
        thread.revision = null;
        this.emit('stale', { conversationId: params.conversationId, reason: 'revision-gap' });
        return;
      }
      thread.state = applyPatches(thread.state, change.patches);
      if (thread.state?.id !== params.conversationId) throw Error('Patch changed snapshot identity');
    } else throw Error('Unsupported native stream change');
    thread.revision = change.revision;
    this.emit('state', { conversationId: params.conversationId, revision: thread.revision,
      state: structuredClone(thread.state) });
  }

  following(conversationId, following) {
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: this.clientId, params: { hostId: 'local', conversationId, following } });
  }

  async subscribe(conversationId) {
    if (!this.clientId || typeof conversationId !== 'string' || !conversationId) throw Error('Connection and thread ID required');
    if (this.threads.has(conversationId)) this.unsubscribe(conversationId);
    const response = await this.request('thread-owner-discovery', { hostId: 'local', conversationId });
    if (typeof response.handledByClientId !== 'string') throw Error('No native thread owner');
    this.threads.set(conversationId, { owner: response.handledByClientId, revision: null, state: null });
    this.following(conversationId, true);
  }

  unsubscribe(conversationId) {
    if (this.threads.has(conversationId)) {
      this.threads.delete(conversationId);
      this.following(conversationId, false);
    }
  }

  disconnect(error) {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.destroy();
    this.clientId = null;
    this.buffer = Buffer.alloc(0);
    this.threads.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('offline', { reason: error.message });
  }

  close() { this.disconnect(Error('Adapter closed')); }
}

/** Preserve native IDs and order; expose native items without copying execution ownership. */
export function projectConversation(state) {
  const history = state.turnHistory?.history;
  let turns;
  if (state.turnHistory?.kind === 'canonical') {
    const seen = new Set();
    turns = (history?.islands ?? []).flatMap(island => island.entries ?? [])
      .flatMap(entry => {
        const key = entry.value ?? entry.key;
        if (typeof key !== 'string' || seen.has(key)) return [];
        seen.add(key);
        const turn = history?.entitiesByKey?.[key];
        return turn ? [turn] : [];
      });
  } else turns = state.turns ?? [];
  return { nativeThreadId: state.id, title: state.title, cwd: state.cwd,
    runtimeStatus: state.threadRuntimeStatus ?? null,
    requests: state.requests ?? [],
    turns: turns.map(turn => ({ nativeTurnId: turn.turnId, status: turn.status,
      input: turn.params?.input ?? [], items: turn.items ?? [] })),
    historyComplete: state.turnHistory?.kind === 'canonical' ? history?.isComplete === true : null };
}
