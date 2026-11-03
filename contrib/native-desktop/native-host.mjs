import net from 'node:net';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CodexDesktop, projectConversation } from './codex-desktop.mjs';
import { ClaudeNative } from './claude-native.mjs';
import { presentHistory } from './native-view.mjs';
import { readNativeImage } from './native-media.mjs';
import { delegationRecord } from './native-delegation.mjs';
import { attachDelegationState } from './native-dsh-state.mjs';
import { storeImages, validateImages, attachmentText, MAX_COMMAND_BYTES } from './native-attachments.mjs';
import { parseModelCatalog, compatibleReasoningEffort } from './native-models.mjs';
import { acquireHostLock } from './native-host-lock.mjs';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const toolsAllowed = new Set(['list_threads', 'read_thread', 'list_projects', 'create_thread', 'send_message_to_thread', 'set_thread_archived', 'list_archived_threads', 'set_thread_pinned', 'navigate_to_codex_page']);
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
  if (item.type === 'userMessage') return { id, role: 'user', text: textContent(item.content), images: (Array.isArray(item.content) ? item.content : []).filter(part => part.type === 'localImage').map(part => part.path) };
  if (item.type === 'agentMessage') return { id, role: 'assistant', text: textContent(item.text ?? item.content), phase: item.phase };
  if (item.type === 'reasoning') return null;
  if (item.type === 'functionCallOutput' && item.namespace === 'codex_app' && ['create_thread', 'send_message_to_thread'].includes(item.name)) {
    const input = String(item.output ?? '').match(/<input>([\s\S]*)<\/input>/)?.[1];
    if (input) return { id, role: 'user', text: input };
  }
  if (item.type === 'functionCallOutput') return { id, role: 'tool', text: String(item.name ?? '工具输出'), output: textContent(item.output) };

  if (item.type === 'commandExecution') return { id, role: 'tool', text: String(item.command ?? ''), output: String(item.aggregatedOutput ?? item.output?.text ?? ''), status: item.status, delegation: delegationRecord(item.command, '', item.status) };
  if (item.type === 'fileChange') return { id, role: 'tool', text: '文件修改', output: JSON.stringify(item.changes ?? [], null, 2), status: item.status,
    files: (item.changes ?? []).filter(change => typeof change.path === 'string').map(change => {
      const lines = typeof change.diff === 'string' ? change.diff.split('\n') : [];
      return {path: change.path, ...(lines.length ? {additions: lines.filter(line => line.startsWith('+') && !line.startsWith('+++ ')).length,
        deletions: lines.filter(line => line.startsWith('-') && !line.startsWith('--- ')).length} : {})};
    }) };
  if (item.type?.includes('Tool') || item.type?.includes('tool')) return { id, role: 'tool', text: String(item.tool ?? item.name ?? item.type), output: textContent(item.result?.content ?? item.result ?? item.content), status: item.status, delegation: delegationRecord(typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? item.input ?? {}), '', item.status) };
  return null;
}

export function nativePendingState(status, requests = []) {
  const flags = status && typeof status === 'object' && Array.isArray(status.activeFlags) ? status.activeFlags : [];
  const methods = requests.map(request => request?.method ?? request?.request?.method);
  if (flags.includes('waitingOnApproval') || methods.some(method => ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method))) return 'approval';
  if (flags.includes('waitingOnUserInput') || methods.includes('item/tool/requestUserInput')) return 'input';
  return null;
}

export function normalizeSnapshot(state) {
  const projection = projectConversation(state);
  const turns = projection.turns.map(turn => {
    const items = turn.items.map(normalizeItem).filter(Boolean);
    const input = textContent(turn.input);
    if (input && !items.some(item => item.role === 'user')) items.unshift({ id: `${turn.nativeTurnId}:input`, role: 'user', text: input });
    return { id: turn.nativeTurnId, status: turn.status, items,
      startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs };
  });
  // The App can retain a null-ID input placeholder after inserting the real user item.
  const confirmedInputs = new Set(turns.filter(turn => turn.id != null).flatMap(turn => turn.items.filter(item => item.role === 'user').map(item => item.text)));
  const visibleTurns = turns.map(turn => turn.id != null ? turn : { ...turn, items: turn.items.filter(item => item.id !== `${turn.id}:input` || !confirmedInputs.has(item.text)) }).filter(turn => turn.id != null || turn.items.length);
  return { id: projection.nativeThreadId, title: projection.title, cwd: projection.cwd,
    status: projection.runtimeStatus?.type ?? 'unknown', activeFlags: projection.runtimeStatus?.activeFlags ?? [], pendingState: nativePendingState(projection.runtimeStatus, projection.requests), turns: visibleTurns,
    requests: projection.requests, live: true, historyComplete: projection.historyComplete,
    modelSettings: { model: state.latestCollaborationMode?.settings?.model ?? state.latestModel ?? null,
      reasoningEffort: state.latestReasoningEffort ?? null } };
}

export function normalizeReadThread(data, id) {
  return { id, title: data.thread?.title ?? '', status: data.thread?.status?.type ?? data.thread?.status ?? 'unknown',
    turns: [...data.turns ?? []].reverse().map(turn => ({ id: turn.id, status: turn.status,
      startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs,
      items: (turn.items ?? []).map(normalizeItem).filter(Boolean) })), requests: [], live: false, historyComplete: !data.page?.hasMore };
}

export class CodexRuntime {
  constructor({ callerThreadId, callTool, desktop, liveWaitMs = 2500, liveHoldMs = 5000 } = {}) {
    if (!idPattern.test(callerThreadId ?? '')) throw Error('A real caller thread ID is required');
    this.callerThreadId = callerThreadId;
    this.callOverride = callTool;
    this.desktop = desktop ?? new CodexDesktop({ allowControl: true });
    this.lastList = null;
    this.pipe = null;
    this.cache = new Map();
    this.following = null;
    this.connection = null;
    this.subscriptions = new Map();
    this.historyLoads = new Map();
    this.liveViews = new Map();
    this.readerUse = new Map();
    this.liveWaitMs = liveWaitMs;
    this.liveHoldMs = liveHoldMs;
    this.streamAdmissions = new Set();
    this.streamSlotWaiters = new Set();
    this.desktop.on('stale', ({ conversationId }) => {
      if (this.following === conversationId) this.following = null;
    });
    this.desktop.on('offline', () => { this.following = null; this.connection = null; });
    this.desktop.on('state', ({ conversationId, state }) => {
      const thread = this.lastList?.value.threads.find(thread => thread.id === conversationId);
      if (!thread || !state?.threadRuntimeStatus) return;
      thread.status = state.threadRuntimeStatus.type ?? thread.status;
      thread.activeFlags = state.threadRuntimeStatus.activeFlags ?? [];
      thread.pendingState = nativePendingState(state.threadRuntimeStatus, state.requests);
    });
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

  rememberLive(id, view) {
    // Accept every authoritative owner snapshot as-is: native conversations
    // may edit, roll back, trim or paginate. This cache only covers a short
    // missing-snapshot gap; it is not a monotonic merge.
    const entry = { at: Date.now(), view };
    this.liveViews.delete(id);
    this.liveViews.set(id, entry);
    if (this.liveViews.size > 16) this.liveViews.delete(this.liveViews.keys().next().value);
    return view;
  }

  async connectStream(id, { background = false } = {}) {
    if (this.subscriptions.has(id)) return this.subscriptions.get(id);
    const job = this.connectStreamOnce(id, { background }).finally(() => this.subscriptions.delete(id));
    this.subscriptions.set(id, job);
    return job;
  }
  async connectStreamOnce(id, { background = false } = {}) {
    try {
      if (!this.desktop.clientId) {
        this.connection ??= this.desktop.connect().finally(() => { this.connection = null; });
        await this.connection;
      }
      if (!this.desktop.threads.get(id)?.state) {
        // Reserve before subscribing: concurrent reads must not all pass the
        // old post-subscribe eviction check while protecting one another.
        while (new Set([...this.desktop.threads.keys(), ...this.streamAdmissions].filter(key => key !== id)).size >= 4) {
          if (background) return;
          const evict = [...this.desktop.threads.keys()].find(key => key !== id && !this.streamAdmissions.has(key));
          if (evict !== undefined) this.desktop.unsubscribe(evict);
          else await new Promise(resolve => this.streamSlotWaiters.add(resolve));
        }
        this.streamAdmissions.add(id);
        try {
          await this.desktop.subscribe(id);
          this.following = id;
          if (!this.desktop.threads.get(id)?.state) await new Promise(resolve => {
            const done = ({ conversationId } = {}) => { if (conversationId && conversationId !== id) return; clearTimeout(timer); this.desktop.off('state', done); resolve(); };
            const timer = setTimeout(done, 2500);
            this.desktop.on('state', done);
          });
        } finally {
          this.streamAdmissions.delete(id);
          const waiters = [...this.streamSlotWaiters];
          this.streamSlotWaiters.clear();
          for (const resolve of waiters) resolve();
        }
      }
    } catch { /* Tool history remains readable when the thread has no live owner. */ }
  }

  async list(archived = false, cursor) {
    if (archived) {
      const result = await this.tool('list_archived_threads', {limit:50,...(cursor ? {cursor} : {})});
      return {threads:(result.threads ?? []).filter(thread => thread.kind === 'codex' && (thread.hostId ?? 'local') === 'local').map(thread => ({...thread,status:thread.status?.type ?? thread.status,archived:true})),nextCursor:result.nextCursor ?? null};
    }
    if (this.lastList && Date.now() - this.lastList.at < 4000) return this.lastList.value;
    const result = await this.tool('list_threads', { limit: 50 });
    const seen = new Set();
    const threads = [...result.pinnedThreads ?? [], ...result.threads ?? []]
      .filter(thread => thread.kind === 'codex' && (thread.hostId ?? 'local') === 'local')
      .filter(thread => { if (seen.has(thread.id)) return false; seen.add(thread.id); return true; })
      .map(thread => ({ id: thread.id, title: thread.title, status: thread.status?.type ?? thread.status,
        activeFlags: thread.status?.activeFlags ?? [], pendingState: nativePendingState(thread.status),
        cwd: thread.cwd, updatedAt: thread.updatedAt, pinned: !!thread.pinnedIndex }));
    // The tools list flattens native status. Read the original live owner for
    // active threads; flags/requests are never inferred from idle/completed.
    // Background list hydration must not evict an explicit reader's stream.
    // Reserve only free slots; existing subscriptions can still refresh flags.
    const activeThreads = threads.filter(thread => ['active', 'running', 'inProgress', 'busy'].includes(thread.status));
    const freeSlots = Math.max(0, 4 - this.desktop.threads.size - this.subscriptions.size);
    const existing = activeThreads.filter(thread => this.desktop.threads.has(thread.id) || this.subscriptions.has(thread.id));
    const discover = activeThreads.filter(thread => !this.desktop.threads.has(thread.id) && !this.subscriptions.has(thread.id)).slice(0, freeSlots);
    await Promise.allSettled([...existing, ...discover].map(async thread => {
      await this.connectStream(thread.id, { background: true });
      const state = this.desktop.threads.get(thread.id)?.state;
      if (!state) return;
      const status = state.threadRuntimeStatus;
      thread.activeFlags = status?.activeFlags ?? [];
      thread.pendingState = nativePendingState(status, state.requests);
    }));
    this.lastList = { at: Date.now(), value: { threads } };
    return this.lastList.value;
  }

  async read(id, { limit = 20, complete = false } = {}) {
    this.readerUse.set(id, Date.now());
    const knownLive = this.liveViews.get(id);
    const stream = this.connectStream(id);
    let timer;
    // Once original history was readable without an owner, keep discovering the
    // live owner in parallel. A thread that has produced a live snapshot gets
    // the full reconnect budget: a fast cached fallback here would win the race
    // against a reconnect and replace the full conversation with a partial one.
    const grace = knownLive && Date.now() - knownLive.at <= this.liveHoldMs ? this.liveWaitMs
      : this.cache.has(id) ? 0 : 400;
    if (grace > 0) await Promise.race([stream, new Promise(resolve => { timer = setTimeout(resolve, grace); })]);
    clearTimeout(timer);
    let snapshot = this.desktop.threads.get(id)?.state;
    if (complete && snapshot && !projectConversation(snapshot).historyComplete) {
      const owner = this.desktop.threads.get(id).owner;
      // Older-history hydration is optional to the live conversation. Share an
      // in-flight load across readers, and keep a fresh snapshot after a timeout.
      let loading = this.historyLoads.get(id);
      if (!loading || loading.owner !== owner) {
        const job = this.desktop.request('thread-follower-load-complete-history', { conversationId: id }, owner);
        loading = { owner, job };
        this.historyLoads.set(id, loading);
        const clear = () => { if (this.historyLoads.get(id) === loading) this.historyLoads.delete(id); };
        job.then(clear, clear);
      }
      let historyLoadError;
      try { await loading.job; }
      catch (error) {
        if (error.message !== 'Desktop request timed out: thread-follower-load-complete-history') throw error;
        historyLoadError = '较早的消息加载超时，已保留当前内容，请稍后重试。';
      }
      snapshot = this.desktop.threads.get(id)?.state;
      if (snapshot) {
        const view = this.rememberLive(id, normalizeSnapshot(snapshot));
        return historyLoadError && !view.historyComplete ? { ...view, historyLoadError } : view;
      }
    }
    if (snapshot) return this.rememberLive(id, normalizeSnapshot(snapshot));
    // Retain full live content during a brief reconnect. Once that budget
    // expires, return fresh original-App history with live:false. The Web
    // source guard labels this bounded fallback and resumes live automatically.
    const last = this.liveViews.get(id);
    if (last && Date.now() - last.at <= this.liveHoldMs) return last.view;
    if (last) this.liveViews.delete(id);
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < 1300 && cached.limit >= limit) return cached.value;
    let raw;
    try { raw = await this.tool('read_thread', { threadId: id, turnLimit: Math.min(limit, 10), includeOutputs: true, maxOutputCharsPerItem: 2000 }); }
    catch (error) {
      if (!/exceeds the size limit|oversized turn/i.test(error.message)) throw error;
      raw = await this.tool('read_thread', { threadId: id, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 500 });
    }
    const value = normalizeReadThread(raw, id);
    this.cache.clear();
    this.cache.set(id, { at: Date.now(), value, limit });
    // The owner snapshot can land while the fallback RPC is in flight. Recheck
    // before returning so a slow historical read cannot overwrite live state.
    const raced = this.desktop.threads.get(id)?.state;
    if (raced) return this.rememberLive(id, normalizeSnapshot(raced));
    // Another reader may have observed live state while this RPC was pending.
    const latest = this.liveViews.get(id);
    if (latest && Date.now() - latest.at <= this.liveHoldMs) return latest.view;
    return value;
  }

  async models() {
    if (this.modelCatalog && Date.now() - this.modelCatalog.at < 300000) return this.modelCatalog.value;
    this.pipe ??= await discoverAppPipe();
    const pipe = this.pipe;
    let result;
    try { result = await nativeRpc(pipe, 'tools/list', { threadStartKind: 'all' }, 3000); }
    catch (error) { if (this.pipe === pipe) this.pipe = null; throw error; }
    const value = parseModelCatalog(result?.tools);
    this.modelCatalog = { at: Date.now(), value };
    return value;
  }

  async modelSettings(id, { activate = false } = {}) {
    await this.connectStream(id);
    let thread = this.desktop.threads.get(id);
    if (!thread?.owner && activate) {
      // Only an explicit model change opens the original App conversation. History reads stay passive.
      await this.tool('navigate_to_codex_page', { threadId: id });
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.connectStream(id);
        thread = this.desktop.threads.get(id);
        if (thread?.owner) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    if (!thread?.owner) {
      if (!activate) return { model: null, reasoningEffort: null, needsActivation: true };
      throw Error('原会话暂时未能连接，请稍后重试切换模型');
    }
    const response = await this.desktop.request('thread-follower-read-model-settings', { conversationId: id }, thread.owner);
    const settings = response.result?.settings;
    if (typeof settings?.model !== 'string' || !settings.model) throw Error('桌面模型设置暂不可用，请重试');
    return { model: settings.model, reasoningEffort: settings.reasoningEffort ?? null };
  }

  async execute(command) {
    if (command.op === 'list') return this.list(command.archived, command.cursor);
    if (command.op === 'archive') {
      const result = await this.tool('set_thread_archived', {threadId:command.id,archived:command.archived,source:'codex'});
      this.lastList = null; this.cache.delete(command.id);
      return {id:command.id,archived:command.archived,native:true,result};
    }
    if (command.op === 'pin') {
      const result = await this.tool('set_thread_pinned', {threadId:command.id,pinned:command.pinned,source:'codex'});
      this.lastList = null;
      if (result.threadId !== command.id || result.pinned !== command.pinned) throw Error('桌面置顶状态尚未确认，请刷新原会话');
      return {id:command.id,pinned:result.pinned,native:true};
    }
    if (command.op === 'projects') return this.tool('list_projects', {});
    if (command.op === 'models') return this.models();
    if (command.op === 'model-settings') return { id: command.id, ...await this.modelSettings(command.id) };
    if (command.op === 'set-model') {
      const model = (await this.models()).models.find(model => model.id === command.model);
      if (!model) throw Error('当前桌面不支持这个模型，请重新选择');
      const previous = await this.modelSettings(command.id, { activate: true });
      if (command.expectedModel !== undefined && previous.model !== command.expectedModel) throw Error('桌面模型已变化，请重新读取后调整强度');
      const effort = command.reasoningEffort === undefined ? compatibleReasoningEffort(model, previous.reasoningEffort) : command.reasoningEffort;
      if (effort != null && !model.reasoningEfforts.includes(effort)) throw Error('这个模型不支持当前思考强度，请重新选择');
      const thread = this.desktop.threads.get(command.id);
      const response = await this.desktop.request('thread-follower-update-thread-settings', {
        conversationId: command.id, threadSettings: { model: command.model, effort },
        condition: { ifModelEquals: previous.model, ifEffortEquals: previous.reasoningEffort },
      }, thread.owner);
      if (response.result?.applied !== true) throw Error('桌面模型设置已变化，请刷新后重试');
      const settings = await this.modelSettings(command.id);
      if (settings.model !== command.model || settings.reasoningEffort !== effort) throw Error('模型切换结果尚未确认，请刷新原会话查看');
      return { id: command.id, native: true, ...settings };
    }
    if (command.op === 'read') return this.read(command.id, command);
    if (command.op === 'create') {
      if (command.model && !(await this.models()).models.some(model => model.id === command.model)) throw Error('当前桌面不支持这个模型，请重新选择');
      const paths = await storeImages(command.images);
      const result = await this.tool('create_thread', { prompt: attachmentText(command.text, paths),
        target: command.projectId ? { type: 'project', projectId: command.projectId, environment: { type: 'local' } } : { type: 'projectless' },
        ...(command.title ? { title: command.title } : {}), ...(command.model ? { model: command.model } : {}) });
      this.lastList = null;
      return result;
    }
    if (command.op === 'send') {
      await this.connectStream(command.id);
      let thread = this.desktop.threads.get(command.id);
      if (!thread?.state || !thread.owner) {
        // Explicit send activates the same original conversation, just as model
        // changes do. Passive history reads never move the desktop selection.
        try { await this.tool('navigate_to_codex_page', {threadId:command.id}); }
        catch (error) { error.delivery = 'not-sent'; throw error; }
        for (let attempt = 0; attempt < 3; attempt++) {
          await this.connectStream(command.id);
          thread = this.desktop.threads.get(command.id);
          if (thread?.state && thread.owner) break;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      if (!thread?.state || !thread.owner) throw Object.assign(Error('原会话暂时未能加载，消息尚未发送，请稍后重试'), {delivery:'not-sent'});
      const result = await this.desktop.request('thread-follower-start-turn', {
        conversationId: command.id,
        turnStart: { request: { threadId: command.id, input: [...(command.text.trim() ? [{ type: 'text', text: command.text, text_elements: [] }] : []), ...(await storeImages(command.images)).map(path => ({ type: 'localImage', path }))], clientUserMessageId: command.actionId }, context: { inheritThreadSettings: true } },
      }, thread.owner);
      this.cache.delete(command.id);
      this.lastList = null;
      const turnId = result.result?.result?.turn?.id;
      if (result.resultType !== 'success' || typeof turnId !== 'string' || !turnId) {
        throw Object.assign(Error('原会话已收到请求但未返回有效轮次回执，请先核对会话，不要自动重发'), { delivery: 'unknown' });
      }
      return { threadId: command.id, turnId, native: true };
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
  if (!['list', 'read', 'projects', 'models', 'model-settings', 'set-model', 'create', 'send', 'stop', 'respond', 'archive', 'pin'].includes(command.op)) throw Error('Invalid operation');
  if (['read', 'model-settings', 'set-model', 'send', 'stop', 'respond', 'archive', 'pin'].includes(command.op) && !idPattern.test(command.id ?? '')) throw Error('Invalid native thread ID');
  if (['create', 'send'].includes(command.op) && (typeof command.text !== 'string' || !command.text.trim() && !command.images?.length || command.text.length > 131072)) throw Error('请输入消息（最多 128K 字符）');
  if (['create', 'set-model', 'send', 'stop', 'respond', 'archive', 'pin'].includes(command.op) && !idPattern.test(command.actionId ?? '')) throw Error('An action ID is required');
  if (['model-settings', 'set-model'].includes(command.op) && command.app !== 'codex') throw Error('Claude 桌面暂不支持切换模型');
  if ((command.model !== undefined || command.op === 'set-model') && (!['create', 'set-model'].includes(command.op) || command.app !== 'codex' || typeof command.model !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(command.model))) throw Error('Invalid conversation model');
  if (command.reasoningEffort !== undefined && (command.op !== 'set-model' || command.app !== 'codex' || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(command.reasoningEffort))) throw Error('Invalid reasoning effort');
  if (command.expectedModel !== undefined && (command.op !== 'set-model' || command.expectedModel !== command.model || command.reasoningEffort === undefined)) throw Error('Invalid expected model');
  if (command.images !== undefined) {
    if (!['create', 'send'].includes(command.op)) throw Error('图片仅用于发送消息');
    validateImages(command.images);
  }
  if (command.op === 'archive' && typeof command.archived !== 'boolean') throw Error('归档状态必须明确');
  if (command.op === 'pin' && typeof command.pinned !== 'boolean') throw Error('置顶状态必须明确');
  if (command.pinned !== undefined && (command.op !== 'pin' || typeof command.pinned !== 'boolean')) throw Error('Invalid pin state');
  if (command.archived !== undefined && (typeof command.archived !== 'boolean' || !['archive','list'].includes(command.op))) throw Error('Invalid archive query');
  if (command.cursor !== undefined && (command.op !== 'list' || typeof command.cursor !== 'string' || command.cursor.length > 256)) throw Error('Invalid archive cursor');
  if (command.imageSize !== undefined && (command.op !== 'read' || !command.imageSrc || !['preview', 'large'].includes(command.imageSize))) throw Error('Invalid image size');
  return command;
}

export function createDispatcher({ codex, claude } = {}) {
  const actions = new Map();
  return async raw => {
    const command = validateCommand(raw);
    const runtime = command.app === 'codex' ? codex : claude;
    if (!runtime) throw Error('Claude 桌面桥接尚未连接');
    const write = ['create', 'set-model', 'send', 'stop', 'respond', 'archive', 'pin'].includes(command.op);
    if (!write) {
      const result = await runtime.execute(command);
      if (command.op !== 'read') return result;
      if (command.imageSrc && !command.itemKey) throw Error('图片需要原始消息标识');
      const detail = presentHistory(command.itemKey ? result : await attachDelegationState(result), command);
      return command.imageSrc ? readNativeImage(detail, command.imageSrc, command.imageSize) : detail;
    }
    const key = `${command.app}:${command.actionId}`;
    const fingerprint = JSON.stringify(command);
    const existing = actions.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Error('Action ID was reused with different content');
      return existing.promise;
    }
    if (actions.size >= 256) {
      const cutoff = Date.now() - 120000;
      for (const [key, value] of actions) if (value.state === 'settled' && value.at < cutoff) actions.delete(key);
      if (actions.size >= 256) throw Object.assign(Error('待确认操作过多，请先核对原会话再重试'), {delivery:'not-sent'});
    }
    const entry = { fingerprint, at: Date.now(), state: 'pending' };
    entry.promise = Promise.resolve().then(() => runtime.execute(command)).then(result => {
      entry.state = 'settled'; entry.at = Date.now(); return result;
    }, error => {
      entry.state = error.delivery === 'not-sent' ? 'settled' : 'uncertain'; entry.at = Date.now(); throw error;
    });
    actions.set(key, entry);
    return entry.promise;
  };
}

export async function startHost({ socketPath, callerThreadId, claudeSessionDirectory }) {
  await fs.mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const parent = await fs.lstat(dirname(socketPath));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077) throw Error('Private socket directory required');
  const lock = await acquireHostLock(socketPath);
  let server;
  lock.onLost(() => { server?.close(); server?.closeAllConnections(); });
  try {
  const existing = await fs.lstat(socketPath).catch(() => null);
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid()) throw Error('Refusing to replace foreign socket path');
    const active = await new Promise((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.setTimeout(1500, () => s.destroy(Error('Existing bridge probe timed out')));
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', error => ['ECONNREFUSED','ENOENT'].includes(error.code) ? resolve(false) : reject(error));
    });
    if (active) throw Error('Native bridge is already running');
    const current = await fs.lstat(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (current && (current.dev !== existing.dev || current.ino !== existing.ino)) throw Error('Bridge socket changed during recovery');
    if (current) await fs.unlink(socketPath);
  }
  const runtime = new CodexRuntime({ callerThreadId });
  const dispatch = createDispatcher({ codex: runtime, claude: claudeSessionDirectory ? new ClaudeNative({sessionDirectory:claudeSessionDirectory}) : null });
  server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (request.method !== 'POST' || new URL(request.url, 'http://localhost').pathname !== '/command') { response.writeHead(404); response.end('{}'); return; }
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > MAX_COMMAND_BYTES) throw Error('Request too large'); chunks.push(chunk); }
      const result = await dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.writeHead(502);
      response.end(JSON.stringify({ ok: false, error: errorText(error), delivery: error.delivery ?? null }));
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 60000;
  server.once('close', () => lock.release());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  return server;
  } catch (error) { server?.close(); lock.release(); throw error; }
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
