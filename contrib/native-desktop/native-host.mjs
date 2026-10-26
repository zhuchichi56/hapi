import net from 'node:net';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CodexDesktop, projectConversation } from './codex-desktop.mjs';
import { ClaudeNative } from './claude-native.mjs';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const toolsAllowed = new Set(['list_threads', 'read_thread', 'list_projects', 'create_thread', 'send_message_to_thread']);
const safe = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorText = error => error instanceof Error ? error.message : String(error);

export function nativeRpc(socketPath, method, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = Buffer.alloc(0), settled = false, dispatched = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        error.delivery = dispatched ? 'unknown' : 'not-sent';
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(Error('桌面请求超时；请刷新会话确认结果，勿重复发送。')), timeoutMs);
    socket.on('connect', () => {
      const payload = Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length);
      dispatched = true;
      socket.write(Buffer.concat([header, payload]));
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(Error('桌面控制连接断开')));
    socket.on('data', chunk => {
      try {
        data = Buffer.concat([data, chunk]);
        if (data.length < 4) return;
        const length = data.readUInt32LE(0);
        if (!length || length > 8 * 1024 * 1024) throw Error('Invalid desktop frame length');
        if (data.length < length + 4) return;
        const response = JSON.parse(data.subarray(4, length + 4));
        if (response.id !== 1 || response.jsonrpc !== '2.0') throw Error('Invalid desktop response');
        if (response.error) finish(Error(String(response.error.message)));
        else finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}

export async function discoverAppPipe() {
  const directory = '/tmp/codex-app-tools';
  const parent = await fs.lstat(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o022)
    throw Error('Codex control directory is not owner-controlled');
  const candidates = [];
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.sock')) continue;
    const path = join(directory, name);
    const stat = await fs.lstat(path).catch(() => null);
    if (stat?.isSocket() && stat.uid === process.getuid() && !(stat.mode & 0o077)) candidates.push({ path, time: stat.mtimeMs });
  }
  for (const { path } of candidates.sort((a, b) => b.time - a.time)) {
    try {
      const result = await nativeRpc(path, 'tools/list', { threadStartKind: 'all' }, 1500);
      if (result?.tools?.some(tool => tool.name === 'list_threads')) return path;
    } catch { /* Probe only; never replay an action on another pipe. */ }
  }
  throw Error('Codex 桌面控制未连接。请保持桌面 App 开启。');
}

export function decodeToolResult(result) {
  const text = result?.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n') ?? '';
  if (result?.success !== true) throw Error(text.slice(0, 1000) || '桌面 App 拒绝了请求');
  try { return JSON.parse(text); } catch { return { text }; }
}

function textContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item.text ?? item.content ?? '').filter(value => typeof value === 'string').join('\n');
}

export function normalizeItem(item) {
  const id = String(item.id ?? '');
  if (item.type === 'userMessage') return { id, role: 'user', text: textContent(item.content) };
  if (item.type === 'agentMessage') return { id, role: 'assistant', text: textContent(item.text ?? item.content), phase: item.phase };
  if (item.type === 'reasoning') return null;
  if (item.type === 'functionCallOutput' && item.namespace === 'codex_app' && ['create_thread', 'send_message_to_thread'].includes(item.name)) {
    const input = String(item.output ?? '').match(/<input>([\s\S]*)<\/input>/)?.[1];
    if (input) return { id, role: 'user', text: input };
  }
  if (item.type === 'functionCallOutput') return { id, role: 'tool', text: String(item.name ?? '工具输出'), output: textContent(item.output) };

  if (item.type === 'commandExecution') return { id, role: 'tool', text: String(item.command ?? ''), output: String(item.aggregatedOutput ?? item.output?.text ?? ''), status: item.status };
  if (item.type === 'fileChange') return { id, role: 'tool', text: '文件修改', output: JSON.stringify(item.changes ?? [], null, 2), status: item.status };
  if (item.type?.includes('Tool') || item.type?.includes('tool')) return { id, role: 'tool', text: String(item.tool ?? item.name ?? item.type), output: textContent(item.result ?? item.content), status: item.status };
  return null;
}

export function normalizeSnapshot(state) {
  const projection = projectConversation(state);
  const turns = projection.turns.map(turn => {
    const items = turn.items.map(normalizeItem).filter(Boolean);
    const input = textContent(turn.input);
    if (input && !items.some(item => item.role === 'user')) items.unshift({ id: `${turn.nativeTurnId}:input`, role: 'user', text: input });
    return { id: turn.nativeTurnId, status: turn.status, items };
  });
  return { id: projection.nativeThreadId, title: projection.title, cwd: projection.cwd,
    status: projection.runtimeStatus?.type ?? 'unknown', turns,
    requests: projection.requests, live: true, historyComplete: projection.historyComplete };
}

export function normalizeReadThread(data, id) {
  return { id, title: data.thread?.title ?? '', status: data.thread?.status?.type ?? data.thread?.status ?? 'unknown',
    turns: [...data.turns ?? []].reverse().map(turn => ({ id: turn.id, status: turn.status,
      items: (turn.items ?? []).map(item => {
        if (item.type === 'agentMessage') return normalizeItem(item);
        if (item.type === 'userMessage') return normalizeItem(item);
        if (item.type === 'commandExecution') return normalizeItem(item);
        return null;
      }).filter(Boolean) })), requests: [], live: false, historyComplete: !data.page?.hasMore };
}

export class CodexRuntime {
  constructor({ callerThreadId, callTool, desktop } = {}) {
    if (!idPattern.test(callerThreadId ?? '')) throw Error('A real caller thread ID is required');
    this.callerThreadId = callerThreadId;
    this.callOverride = callTool;
    this.desktop = desktop ?? new CodexDesktop({ allowControl: true });
    this.lastList = null;
    this.pipe = null;
    this.cache = new Map();
    this.following = null;
    this.connection = null;
    this.desktop.on('stale', ({ conversationId }) => {
      if (this.following === conversationId) this.following = null;
    });
    this.desktop.on('offline', () => { this.following = null; this.connection = null; });
  }

  async tool(name, args) {
    if (!toolsAllowed.has(name)) throw Error('Unsupported native tool');
    if (this.callOverride) return this.callOverride(name, args);
    this.pipe ??= await discoverAppPipe();
    try {
      return decodeToolResult(await nativeRpc(this.pipe, 'tools/call', {
        namespace: 'codex_app', tool: name, threadId: this.callerThreadId,
        hostId: 'local', callerSource: 'codex', callId: randomUUID(), turnId: randomUUID(), arguments: args,
      }, name === 'create_thread' ? 55000 : 25000));
    } catch (error) { this.pipe = null; throw error; }
  }

  async connectStream(id) {
    try {
      if (!this.desktop.clientId) {
        this.connection ??= this.desktop.connect().finally(() => { this.connection = null; });
        await this.connection;
      }
      if (this.following !== id) {
        if (this.following) this.desktop.unsubscribe(this.following);
        this.following = null;
        await this.desktop.subscribe(id);
        this.following = id;
        if (!this.desktop.threads.get(id)?.state) await new Promise(resolve => {
          const done = ({ conversationId } = {}) => { if (conversationId && conversationId !== id) return; clearTimeout(timer); this.desktop.off('state', done); resolve(); };
          const timer = setTimeout(done, 2500);
          this.desktop.on('state', done);
        });
      }
    } catch { /* Tool history remains readable when the thread has no live owner. */ }
  }

  async list() {
    if (this.lastList && Date.now() - this.lastList.at < 4000) return this.lastList.value;
    const result = await this.tool('list_threads', { limit: 50 });
    const seen = new Set();
    const threads = [...result.pinnedThreads ?? [], ...result.threads ?? []]
      .filter(thread => thread.kind === 'codex' && (thread.hostId ?? 'local') === 'local')
      .filter(thread => { if (seen.has(thread.id)) return false; seen.add(thread.id); return true; })
      .map(thread => ({ id: thread.id, title: thread.title, status: thread.status?.type ?? thread.status,
        cwd: thread.cwd, updatedAt: thread.updatedAt, pinned: !!thread.pinnedIndex }));
    this.lastList = { at: Date.now(), value: { threads } };
    return this.lastList.value;
  }

  async read(id, { limit = 20, complete = false } = {}) {
    await this.connectStream(id);
    let snapshot = this.desktop.threads.get(id)?.state;
    if (complete && snapshot && !projectConversation(snapshot).historyComplete) {
      const owner = this.desktop.threads.get(id).owner;
      await this.desktop.request('thread-follower-load-complete-history', { conversationId: id }, owner);
      snapshot = this.desktop.threads.get(id)?.state;
    }
    if (snapshot) return normalizeSnapshot(snapshot);
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < 1300 && cached.limit >= limit) return cached.value;
    const raw = await this.tool('read_thread', { threadId: id, turnLimit: Math.min(limit, 10), includeOutputs: true, maxOutputCharsPerItem: 2000 });
    const value = normalizeReadThread(raw, id);
    this.cache.clear();
    this.cache.set(id, { at: Date.now(), value, limit });
    return value;
  }

  async execute(command) {
    if (command.op === 'list') return this.list();
    if (command.op === 'projects') return this.tool('list_projects', {});
    if (command.op === 'read') return this.read(command.id, command);
    if (command.op === 'create') {
      const result = await this.tool('create_thread', { prompt: command.text,
        target: command.projectId ? { type: 'project', projectId: command.projectId, environment: { type: 'local' } } : { type: 'projectless' },
        ...(command.title ? { title: command.title } : {}) });
      this.lastList = null;
      return result;
    }
    if (command.op === 'send') {
      await this.connectStream(command.id);
      const thread = this.desktop.threads.get(command.id);
      if (!thread?.state || !thread.owner) throw Error('请先在桌面 App 打开这个会话，才能发送消息');
      const result = await this.desktop.request('thread-follower-start-turn', {
        conversationId: command.id,
        turnStart: { request: { threadId: command.id, input: [{ type: 'text', text: command.text, text_elements: [] }], clientUserMessageId: command.actionId }, context: { inheritThreadSettings: true } },
      }, thread.owner);
      this.cache.delete(command.id);
      this.lastList = null;
      return { threadId: command.id, native: result.resultType === 'success' };
    }
    await this.connectStream(command.id);
    const thread = this.desktop.threads.get(command.id);
    if (!thread?.state || !thread.owner) throw Error('该会话没有已连接的桌面执行进程');
    if (command.op === 'stop') {
      const view = projectConversation(thread.state);
      const active = [...view.turns].reverse().find(turn => turn.status === 'inProgress');
      if (!active?.nativeTurnId) throw Error('没有可停止的运行中轮次');
      return this.desktop.request('thread-follower-interrupt-turn', { conversationId: command.id, mode: 'user-stop', expectedTurnId: active.nativeTurnId }, thread.owner);
    }
    if (command.op === 'respond') {
      const pending = thread.state.requests?.find(request => String(request.id ?? request.requestId) === String(command.requestId));
      if (!pending) throw Error('这个待处理请求已经结束，请刷新');
      const method = pending.method ?? pending.request?.method;
      const base = { conversationId: command.id, requestId: pending.id ?? pending.requestId };
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        if (!['accept', 'decline'].includes(command.decision)) throw Error('Invalid approval decision');
        const name = method.includes('commandExecution') ? 'thread-follower-command-approval-decision' : 'thread-follower-file-approval-decision';
        return this.desktop.request(name, { ...base, decision: command.decision }, thread.owner);
      }
      if (method === 'item/tool/requestUserInput' && safe(command.response))
        return this.desktop.request('thread-follower-submit-user-input', { ...base, response: command.response }, thread.owner);
      throw Error('该请求类型暂不支持，请在桌面 App 中处理');
    }
    throw Error('Unsupported operation');
  }
}

export function validateCommand(command) {
  if (!safe(command) || !['codex', 'claude'].includes(command.app)) throw Error('Invalid application');
  if (!['list', 'read', 'projects', 'create', 'send', 'stop', 'respond'].includes(command.op)) throw Error('Invalid operation');
  if (['read', 'send', 'stop', 'respond'].includes(command.op) && !idPattern.test(command.id ?? '')) throw Error('Invalid native thread ID');
  if (['create', 'send'].includes(command.op) && (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 131072)) throw Error('请输入消息（最多 128K 字符）');
  if (['create', 'send', 'stop', 'respond'].includes(command.op) && !idPattern.test(command.actionId ?? '')) throw Error('An action ID is required');
  return command;
}

export function createDispatcher({ codex, claude } = {}) {
  const actions = new Map();
  return async raw => {
    const command = validateCommand(raw);
    const runtime = command.app === 'codex' ? codex : claude;
    if (!runtime) throw Error('Claude 桌面桥接尚未连接');
    const write = ['create', 'send', 'stop', 'respond'].includes(command.op);
    if (!write) return runtime.execute(command);
    const key = `${command.app}:${command.actionId}`;
    const fingerprint = JSON.stringify(command);
    const existing = actions.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Error('Action ID was reused with different content');
      return existing.promise;
    }
    if (actions.size > 256) {
      const cutoff = Date.now() - 120000;
      for (const [key, value] of actions) if (value.at < cutoff) actions.delete(key);
      if (actions.size > 256) throw Error('操作过多，请稍后重试');
    }
    const promise = Promise.resolve().then(() => runtime.execute(command));
    actions.set(key, { fingerprint, promise, at: Date.now() });
    return promise;
  };
}

export async function startHost({ socketPath, callerThreadId, claudeSessionDirectory }) {
  await fs.mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const parent = await fs.lstat(dirname(socketPath));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077) throw Error('Private socket directory required');
  const existing = await fs.lstat(socketPath).catch(() => null);
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid()) throw Error('Refusing to replace foreign socket path');
    const active = await new Promise(resolve => { const s = net.createConnection(socketPath); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
    if (active) throw Error('Native bridge is already running');
    await fs.unlink(socketPath);
  }
  const runtime = new CodexRuntime({ callerThreadId });
  const dispatch = createDispatcher({ codex: runtime, claude: claudeSessionDirectory ? new ClaudeNative({sessionDirectory:claudeSessionDirectory}) : null });
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (request.method !== 'POST' || new URL(request.url, 'http://localhost').pathname !== '/command') { response.writeHead(404); response.end('{}'); return; }
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 524288) throw Error('Request too large'); chunks.push(chunk); }
      const result = await dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.writeHead(502);
      response.end(JSON.stringify({ ok: false, error: errorText(error), delivery: error.delivery ?? null }));
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 60000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(homedir(), '.local/state/native-desktop-bridge');
  const config = JSON.parse(await fs.readFile(join(root, 'config.json'), 'utf8'));
  const socketPath = join(root, 'host.sock');
  const server = await startHost({ socketPath, callerThreadId: config.callerThreadId, claudeSessionDirectory: config.claudeSessionDirectory });
  console.log('Native desktop bridge ready');
  const close = () => server.close(() => process.exit(0));
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
