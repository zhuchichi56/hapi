#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const registry = JSON.parse(fs.readFileSync(cfg.codes, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(cfg.out, 'manifest.json'), 'utf8'));
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameDirectory = value => { try { return fs.realpathSync(value) === fs.realpathSync(cfg.cwd); } catch { return false; } };
function save(name, value) { fs.writeFileSync(path.join(cfg.out, name), JSON.stringify(value, null, 2), { mode: 0o600 }); }
async function login(namespace) {
    const code = registry.codes.find(c => c.namespace === namespace)?.code;
    const response = await fetch('http://127.0.0.1:3006/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: code }), signal: AbortSignal.timeout(15000) });
    const { token } = await response.json();
    if (!response.ok || !token) throw Error('Login failed: ' + namespace);
    return async (p, body, method) => {
        const response = await fetch('http://127.0.0.1:3006/api' + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
        const value = await response.json();
        if (!response.ok || value.type === 'error' || value.error || value.success === false) throw Error('HTTP/business failure ' + response.status + ' ' + p + ' ' + (value.code || ''));
        return value;
    };
}
if (process.argv.includes('--read')) {
    for (const namespace of ['default', 'wwx']) {
        const api = await login(namespace);
        const { sessions, ownerBackends } = await api('/sessions');
        const wwx = sessions.filter(s => sameDirectory(s.metadata?.path));
        if (sessions.some(s => ['/Users/zhuhe/wwx', '/home/v-hezhu2/wwx'].includes(s.metadata?.path))) throw Error('Duplicate historical WWX groups remain');
        if (manifest.entries.some(e => !wwx.some(s => s.id === e.id))) throw Error('A migrated ID is missing from the list');
        const reads = [];
        // Bounded concurrency reads the actual API and latest saved page of every real history.
        const queue = manifest.entries.filter(e => e.nativeId).slice();
        await Promise.all(Array.from({ length: 4 }, async () => {
            let entry;
            while ((entry = queue.shift())) {
                const start = performance.now();
                const { session } = await api('/sessions/' + entry.id);
                const { messages } = await api('/sessions/' + entry.id + '/messages?limit=20');
                if (session?.metadata?.codexSessionId !== entry.nativeId || !sameDirectory(session.metadata.path) || !messages?.length) throw Error('History read identity/content mismatch');
                reads.push({ id: entry.id, ms: Math.round(performance.now() - start), messages: messages.length });
            }
        }));
        const sorted = reads.map(r => r.ms).sort((a, b) => a - b);
        results.push({ namespace, listed: wwx.length, realHistoriesRead: reads.length, ownerBackends, p50ms: sorted[Math.floor(sorted.length / 2)], p95ms: sorted[Math.floor(sorted.length * .95)] });
    }
    save('live-read.json', results); console.log(JSON.stringify(results));
}
if (process.argv.includes('--continue')) {
    const api = await login('default');
    const file = path.join(cfg.out, 'live-continuation.json');
    const pending = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { cases: [] };
    if (!pending.cases.length) {
        for (const source of ['original-rollout', 'saved-hapi-history']) {
            const entry = manifest.entries.filter(e => e.recovery.source === source && e.digest.count > 0).sort((a, b) => a.digest.count - b.digest.count)[0];
            pending.cases.push({ id: entry.id, nativeId: entry.nativeId, source, localId: 'wwx-consolidation-accept-' + entry.id });
        }
        save('live-continuation.json', pending);
    }
    for (const item of pending.cases) {
        let { session } = await api('/sessions/' + item.id);
        if (!session.active && !item.messageRequested) {
            if (item.resumeRequested) throw Error('Prior resume outcome requires reconciliation');
            item.resumeRequested = true; save('live-continuation.json', pending);
            const resumed = await api('/sessions/' + item.id + '/resume', {});
            if (resumed.sessionId !== item.id) throw Error('Resume changed the HAPI identity');
        }
        ({ session } = await api('/sessions/' + item.id));
        if (session.thinking) throw Error('Acceptance history is busy; no message sent');
        if (session.metadata.codexSessionId !== item.nativeId) throw Error('Resume changed native identity');
        if (!item.messageRequested) {
            item.messageRequested = true; item.beforeSeq = session.seq; save('live-continuation.json', pending);
            await api('/sessions/' + item.id + '/messages', { localId: item.localId, text: '这是用户授权的 WWX 迁移验收。本条不继续此前旧任务。请调用一次 shell 工具，只运行 pwd 和 test -d /Users/zhuhe/Workspaces/wwx/RouterXBench；确认可以读取当前项目目录后，只回复 WWX_CONTINUE_OK，不修改任何文件。' });
        }
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
            const { messages } = await api('/sessions/' + item.id + '/messages?limit=100');
            const submitted = messages.find(m => m.localId === item.localId);
            if (submitted) item.beforeMessageSeq = submitted.seq - 1;
            const appended = messages.filter(m => item.beforeMessageSeq !== undefined && m.seq > item.beforeMessageSeq);
            const tools = appended.filter(m => m.content?.content?.data?.type === 'tool-call');
            const toolOk = appended.some(m => {
                const data = m.content?.content?.data;
                return data?.type === 'tool-call-result' && data.is_error !== true && data.output?.exit_code === 0 && sameDirectory(data.output.cwd);
            });
            const ok = appended.some(m => m.content?.role === 'agent' && m.content?.content?.data?.type === 'message' && m.content.content.data.message?.trim() === 'WWX_CONTINUE_OK');
            ({ session } = await api('/sessions/' + item.id));
            if (ok && tools.length && toolOk && !session.thinking) {
                item.verified = true; item.toolCalls = tools.length; item.toolExitCode = 0; item.identityPreserved = session.metadata.codexSessionId === item.nativeId;
                save('live-continuation.json', pending); break;
            }
            await sleep(2500);
        }
        if (!item.verified) throw Error('Acceptance did not complete; no automatic replay');
        console.log(JSON.stringify({ source: item.source, modelAndToolVerified: true, identityPreserved: item.identityPreserved }));
        if (!item.archiveRequested) {
            item.archiveRequested = true; save('live-continuation.json', pending);
            await api('/sessions/' + item.id + '/archive', {});
        }
    }
}
