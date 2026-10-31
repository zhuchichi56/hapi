import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { storeImages } from './native-attachments.mjs';
import { delegationRecord } from './native-delegation.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const allowed = ['Allow', 'Allow once', 'Allow this time', 'Approve', 'Reject', 'Deny', '拒绝', '允许', '允许一次'];
const activeButtons = ['Stop', 'Stop response', 'Stop generating', '停止'];
export function normalizeClaudeTranscript(entries) {
  const turns = [];
  for (const entry of entries) {
    if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command' && entry.attachment.humanTurn && entry.attachment.origin?.kind === 'human' && typeof entry.attachment.prompt === 'string') {
      turns.push({id:entry.uuid,status:'completed',items:[{id:entry.attachment.source_uuid ?? entry.uuid,role:'user',text:entry.attachment.prompt}]});
      continue;
    }
    if (entry.isMeta || !['user', 'assistant'].includes(entry.type)) continue;
    const message = entry.message;
    if (!message || !['user', 'assistant'].includes(message.role)) continue;
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
    const items = [];
    for (const part of content) {
      const id = String(part.id ?? part.tool_use_id ?? `${entry.uuid}:${items.length}`);
      if (part.type === 'text') items.push({ id, role: message.role, text: part.text });
      else if (part.type === 'image' && part.nativeImagePath) items.push({ id, role: message.role, text: '', images: [part.nativeImagePath] });
      else if (part.type === 'tool_use') items.push({ id, role: 'tool', text: part.name, output: JSON.stringify(part.input, null, 2), status: 'completed', delegation: delegationRecord(JSON.stringify(part.input ?? {})) });
      else if (part.type === 'tool_result') items.push({ id, role: 'tool', text: '工具结果', output: typeof part.content === 'string' ? part.content.slice(0, 30000) : JSON.stringify(part.content, null, 2)?.slice(0, 30000), status: part.is_error ? 'failed' : 'completed' });
    }
    if (items.length) turns.push({ id: entry.uuid, status: 'completed', items });
  }
  return turns;
}
export function transcriptStatus(entries) {
  for (const entry of [...entries].reverse()) {
    if (entry.isMeta || entry.isSidechain) continue;
    if (entry.type === 'system' && ['turn_duration', 'stop_hook_summary'].includes(entry.subtype)) return entry.preventedContinuation ? 'unknown' : 'idle';
    if (entry.type === 'assistant') return ['end_turn', 'stop_sequence'].includes(entry.message?.stop_reason) ? 'idle' : 'unknown';
    if (entry.type === 'user') return 'unknown';
  }
  return 'unknown';
}
export class ClaudeNative {
  constructor({ sessionDirectory, helper = join(homedir(), '.local/lib/native-desktop-bridge/claude-ax') } = {}) {
    this.sessionDirectory = sessionDirectory;
    this.helper = helper;
    this.tail = Promise.resolve();
    this.cache = new Map();
    this.lastView = null;
  }
  async ax(command) {
    if (!this.child || this.child.exitCode !== null) {
      const child = spawn(this.helper, [], {stdio:['pipe','pipe','ignore']});
      const connection = { child, pending: [], closed: false };
      this.child = child; this.connection = connection;
      const offline = (message = 'Claude 桌面接口中断') => {
        if (connection.closed) return;
        connection.closed = true;
        if (this.connection === connection) { this.child = null; this.lastView = null; }
        for (const pending of connection.pending.splice(0)) {
          clearTimeout(pending.timer);
          const error = Error(message);
          if (pending.mutation) error.delivery = pending.dispatched ? 'unknown' : 'not-sent';
          pending.reject(error);
        }
        // Only this disposable helper is stopped; the original App keeps running.
        child.kill();
      };
      connection.offline = offline;
      const lines = readline.createInterface({input:child.stdout});
      lines.on('line', line => {
        const pending = connection.pending.shift(); if (!pending) return;
        clearTimeout(pending.timer);
        try { const result = JSON.parse(line); result.ok ? pending.resolve(result) : pending.reject(Error(result.error)); }
        catch { const error = Error('Claude 桌面接口返回格式错误'); if (pending.mutation) error.delivery = 'unknown'; pending.reject(error); }
      });
      lines.on('error', () => offline());
      child.stdout.on('error', () => offline());
      child.stdout.on('end', () => offline());
      child.stdin.on('error', () => offline());
      child.stdin.on('close', () => offline());
      child.on('exit', () => offline()); child.on('error', () => offline());
    }
    return new Promise((resolve, reject) => {
      const connection = this.connection;
      const pending = {resolve, reject, mutation: command.op !== 'inspect', dispatched: false};
      pending.timer = setTimeout(() => connection.offline('Claude 桌面操作超时'), 15000);
      connection.pending.push(pending);
      try {
        const input = JSON.stringify(command)+'\n';
        pending.dispatched = true;
        connection.child.stdin.write(input, error => { if (error) connection.offline(); });
      } catch { connection.offline(); }
    });
  }
  async records(includeArchived = false) {
    if (this.recordCache && Date.now() - this.recordCache.at < 1000) return this.recordCache.records.filter(record => includeArchived || !record.archived);
    const records = [];
    await Promise.all((await fs.readdir(this.sessionDirectory)).filter(name => /^local_[A-Za-z0-9_-]+\.json$/.test(name)).map(async name => {
      const data = await fs.readFile(join(this.sessionDirectory, name), 'utf8').then(JSON.parse).catch(() => null);
      if (!data || !/^local_[A-Za-z0-9_-]+$/.test(data.sessionId ?? '')) return;
      records.push({ id: data.sessionId, title: data.title ?? '未命名会话', cwd: data.cwd,
        cliSessionId: data.cliSessionId, updatedAt: data.lastActivityAt ?? data.createdAt, status: 'unknown', archived: !!data.isArchived, pinned: !!data.isStarred });
    }));
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    this.recordCache = {at: Date.now(), records};
    return records.filter(record => includeArchived || !record.archived);
  }
  async select(id) {
    let state = await this.ax({ op: 'inspect' });
    if (state.locked) return state;
    if (state.selectedId === id) return state;
    await this.ax({ op: 'open', id });
    for (let i = 0; i < 14; i++) {
      state = await this.ax({ op: 'inspect' });
      if (state.selectedId === id && state.nodes.some(node => node.description === 'Prompt' || node.title === 'Unarchive' || node.description === 'Unarchive')) return state;
      await pause(150);
    }
    throw Error('Claude 原会话正在加载，请稍后重试');
  }
  stateFields(state) {
    if (state.locked) return { status: 'locked', requests: [] };
    const labels = state.nodes.filter(node => node.role === 'AXButton').map(node => node.title || node.description);
    const requests = labels.filter(label => allowed.includes(label));
    return { status: labels.some(label => activeButtons.includes(label)) ? 'active' : 'idle',
      requests: requests.length ? [{ id: 'native-ui-approval', method: 'native/approval', buttons: [...new Set(requests)] }] : [] };
  }
  async transcript(record, complete) {
    if (!/^[A-Za-z0-9_-]+$/.test(record.cliSessionId ?? '') || typeof record.cwd !== 'string') return { turns: [], historyComplete: true };
    // This is the original desktop runtime's transcript. No CLI is started.
    const project = record.cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const path = join(homedir(), '.claude/projects', project, `${record.cliSessionId}.jsonl`);
    const stat = await fs.stat(path).catch(() => null);
    if (!stat) return { turns: [], historyComplete: true };
    const limit = complete ? 64 * 1024 * 1024 : 8 * 1024 * 1024;
    const cached = this.cache.get(record.id);
    if (cached?.mtime === stat.mtimeMs && cached.limit >= limit) return cached.value;
    const handle = await fs.open(path, 'r');
    let raw;
    try {
      const start = Math.max(0, stat.size - limit);
      const buffer = Buffer.alloc(Math.min(stat.size, limit));
      await handle.read(buffer, 0, buffer.length, start);
      raw = buffer.toString('utf8');
      if (start) raw = raw.slice(raw.indexOf('\n') + 1);
    } finally { await handle.close(); }
    const entries = raw.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    for (const entry of entries) {
      if (!Array.isArray(entry.message?.content)) continue;
      for (const part of entry.message.content) if (part.type === 'image' && part.source?.type === 'base64' && ['image/png','image/jpeg','image/webp'].includes(part.source.media_type)) {
        try { part.nativeImagePath = (await storeImages([{data:`data:${part.source.media_type};base64,${part.source.data}`}]))[0]; } catch { /* Preserve the original transcript if a legacy image exceeds the upload limit. */ }
      }
    }
    const value = { status: transcriptStatus(entries), turns: normalizeClaudeTranscript(entries), historyComplete: stat.size <= limit };
    // Receipts confirm native queue acceptance without exposing bookkeeping in history payloads.
    Object.defineProperty(value, 'queueReceipts', {value: entries.filter(entry => entry.type === 'queue-operation' && entry.operation === 'enqueue' && typeof entry.content === 'string').slice(-32).map(entry => ({id:entry.timestamp + ':' + createHash('sha256').update(entry.content.trim()).digest('hex'),hash:createHash('sha256').update(entry.content.trim()).digest('hex')}))});
    if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(record.id, { mtime: stat.mtimeMs, limit, value });
    return value;
  }
  syncState() {
    // Inspect existing desktop state only. List/read polling must never open a
    // session or move Claude's selection; explicit mutations use select() below.
    if (this.inspection || Date.now() - (this.lastView?.at ?? 0) < 1200) return;
    const job = this.tail.then(async () => {
      const state = await this.ax({op:'inspect'});
      this.lastView = {state, at: Date.now()};
    }).catch(() => { this.lastView = null; });
    this.inspection = job;
    this.tail = job;
    void job.finally(() => { if (this.inspection === job) this.inspection = null; });
  }
  async readFast(command) {
    const records = await this.records(true);
    this.syncState();
    const state = this.lastView && Date.now() - this.lastView.at < 6000 ? this.lastView.state : null;
    const fields = state ? this.stateFields(state) : {status:'unknown',requests:[]};
    if (command.op === 'list') return {threads: await Promise.all(records.filter(record => !!record.archived === !!command.archived).map(async ({cliSessionId,...record}) => ({...record,
      status: state?.locked ? 'locked' : record.id === state?.selectedId ? fields.status : (await this.transcript({...record,cliSessionId},false)).status ?? 'unknown'})))};
    const record = records.find(record => record.id === command.id);
    if (!record) throw Error('Claude 桌面原会话不存在或已归档');
    const selected = state?.selectedId === record.id;
    const history = await this.transcript(record,command.complete);
    return {id:record.id,title:record.title,cwd:record.cwd,
      ...history,
      ...(selected || state?.locked ? fields : {status: history.status ?? 'unknown', requests:[]}), live:!!selected && !state?.locked};
  }
  execute(command) {
    if (command.op === 'models') return Promise.resolve({ models: [], supportsSelection: false });
    if (command.op === 'list' || command.op === 'read') return this.readFast(command);
    const job = this.tail.then(() => this.executeSerial(command));
    this.tail = job.catch(() => {});
    return job;
  }
  async executeSerial(command) {
    const records = await this.records(true);
    if (command.op === 'create') {
      this.recordCache = null;
      const before = new Set(records.map(record => record.id));
      await this.ax({ op: 'new' });
      let state;
      for (let i = 0; i < 10; i++) {
        state = await this.ax({ op: 'inspect' });
        if (!state.selectedId && state.nodes.some(node => node.description === 'Prompt' || node.title === 'Unarchive' || node.description === 'Unarchive')) break;
        await pause(150);
      }
      if (state.selectedId) throw Error('Claude 新建界面尚未就绪，未发送消息');
      await this.ax({ op: 'send', text: command.text || '请查看附图。', images: await storeImages(command.images), new: true });
      for (let i = 0; i < 30; i++) {
        state = await this.ax({ op: 'inspect' });
        if (state.selectedId && !before.has(state.selectedId)) return { sessionId: state.selectedId };
        await pause(150);
      }
      const error = Error('Claude 已提交新建请求，请刷新列表确认结果，勿重复发送'); error.delivery = 'unknown'; throw error;
    }
    const record = records.find(record => record.id === command.id);
    if (!record) throw Error('Claude 桌面原会话不存在或已归档');
    const state = await this.select(command.id);
    this.lastView = {state,at:Date.now()};
    const fields = this.stateFields(state);
    if (state.locked) throw Error('Mac 已锁屏，Claude 桌面操作需要先解锁；历史仍可读取');
    if (command.op === 'pin') {
      if (record.pinned === command.pinned) return {id:record.id,pinned:command.pinned,native:true};
      await this.ax({op:'pin',id:command.id,title:record.title,pinned:command.pinned});
      for (let i=0;i<20;i++) {
        this.recordCache=null;
        const updated=(await this.records(true)).find(entry=>entry.id===command.id);
        if (updated?.pinned === command.pinned) {this.lastView=null;return {id:record.id,pinned:command.pinned,native:true};}
        await pause(150);
      }
      const error=Error('已提交桌面置顶操作，请刷新确认状态，勿重复操作');error.delivery='unknown';throw error;
    }
    if (command.op === 'archive') {
      if (record.archived === command.archived) return {id:record.id,archived:command.archived,native:true};
      await this.ax({op:'archive',id:command.id,title:record.title,archived:command.archived});
      for (let i=0;i<20;i++) {
        this.recordCache=null;
        const updated=(await this.records(true)).find(entry=>entry.id===command.id);
        if (updated?.archived === command.archived) {this.lastView=null;return {id:record.id,archived:command.archived,native:true};}
        await pause(150);
      }
      const error=Error('已提交桌面归档操作，请刷新确认状态；若出现原 App 确认窗口，请在桌面处理');error.delivery='unknown';throw error;
    }
    if (command.op === 'send') {
      const before = await this.transcript(record, false);
      const ids = new Set(before.turns.map(turn => turn.id));
      const receipts = new Set((before.queueReceipts ?? []).map(entry => entry.id));
      const inputHash = createHash('sha256').update((command.text || '请查看附图。').trim()).digest('hex');
      await this.ax({ op: 'send', id: command.id, text: command.text || '请查看附图。', images: await storeImages(command.images) });
      for (let i = 0; i < 20; i++) {
        const transcript = await this.transcript(record, false);
        if (transcript.queueReceipts?.some(entry => !receipts.has(entry.id) && entry.hash === inputHash)) return {sessionId:command.id,native:true,queued:true};
        if (transcript.turns.some(turn => !ids.has(turn.id) && turn.items.some(item => item.role === 'user' && item.text.trim() === (command.text || '请查看附图。').trim()))) return { sessionId: command.id, native: true };
        await pause(250);
      }
      const error = Error('Claude 已提交输入，请刷新原会话确认结果，勿重复发送'); error.delivery = 'unknown'; throw error;
    }
    if (command.op === 'stop') return this.ax({ op: 'stop', id: command.id });
    if (command.op === 'respond') {
      if (command.requestId !== 'native-ui-approval' || !fields.requests[0]?.buttons.includes(command.button)) throw Error('Claude 审批已变化，请刷新');
      return this.ax({ op: 'respond', id: command.id, button: command.button });
    }
    throw Error('Unsupported Claude desktop operation');
  }
}
