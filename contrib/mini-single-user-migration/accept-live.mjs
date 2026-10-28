import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, realpathSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = '/Users/zhuhe/.local/lib/hapi-mini';
const project = '/Users/zhuhe/Workspaces/wwx';
const machineId = '1038f411-05fb-454f-a9cd-3c4e226168f0';
const dir = root + '/single-user-migration-20261028/acceptance';
const pendingFile = dir + '/pending-live.json';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(readFileSync(file, 'utf8'));
function save(file, value) {
    writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(file + '.tmp', file);
}
export function sameDirectory(a, b) {
    try { return typeof a === 'string' && realpathSync(a) === realpathSync(b); } catch { return false; }
}
export function businessError(data) {
    if (data?.type !== 'error' && data?.success !== false && !data?.error) return null;
    return ['code', 'error', 'errorMessage', 'message'].filter(k => typeof data[k] === 'string')
        .map(k => k + ': ' + data[k].slice(0, 1000)).join('; ') || 'Operation failed';
}
export function isModelReply(message) {
    const content = message?.content;
    const event = content?.content;
    return content?.role === 'agent' && event?.type === 'codex'
        && event.data?.type === 'message' && event.data.message?.trim() === 'MIGRATION_OK';
}
export function testCommand(nonce, proof, physicalProject) {
    const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    return `set -eu; test "$(/usr/bin/id -u)" = 501; test "$(/usr/bin/id -un)" = zhuhe; test "$HOME" = /Users/zhuhe; test "$(pwd -P)" = ${quote(physicalProject)}; migration_http_status=$(/usr/bin/curl --connect-timeout 15 --max-time 40 --silent --show-error --output /dev/null --write-out '%{http_code}' https://example.com); test "$migration_http_status" = 200; /usr/bin/printf '%s\\n' ${quote(JSON.stringify({ nonce, uid: 501, user: 'zhuhe', networkStatus: 200 }))} > ${quote(proof)}`;
}

async function run() {
    if (!process.argv.includes('--run')) {
        console.log('Usage: accept-live.mjs --run [--session <known-test-session>]. Continues a recorded test without replaying messages.');
        return;
    }
    if (process.getuid() !== 501) throw Error('Run live acceptance as zhuhe, without sudo');
    const receipt = read(root + '/projects/wwx/migration-receipt.json');
    const registry = read(root + '/data/web-access-codes.json');
    const code = registry.codes.find(c => c.namespace === 'wwx')?.code;
    if (!code) throw Error('Missing namespace code');
    const auth = await fetch('http://127.0.0.1:3006/api/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: code }), signal: AbortSignal.timeout(15000)
    });
    if (!auth.ok) throw Error('Authentication failed');
    const { token } = await auth.json();
    async function api(path, body) {
        const r = await fetch('http://127.0.0.1:3006/api' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000)
        });
        const result = await r.json();
        const error = businessError(result);
        if (!r.ok || error) throw Error(path + ' HTTP ' + r.status + ': ' + (error ?? result.error ?? 'Request failed'));
        return result;
    }
    // Persisted machine.active can outlive a runner restart. Require a live RPC.
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const result = await api('/machines/' + machineId + '/paths/exists', { paths: [project] });
            if (result.exists?.[project] === true) { ready = true; break; }
        } catch { /* No mutations: allow runner startup to complete. */ }
        await sleep(1000);
    }
    if (!ready) throw Error('Runner RPC is not ready; no test session was created');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sessionFlag = process.argv.indexOf('--session');
    const requested = sessionFlag >= 0 ? process.argv[sessionFlag + 1] : undefined;
    if (sessionFlag >= 0 && !/^[0-9a-f-]{36}$/.test(requested ?? '')) throw Error('Invalid explicit test session');
    let pending = existsSync(pendingFile) ? read(pendingFile) : null;
    if (pending && requested && pending.sessionId !== requested) throw Error('Another recorded acceptance exists; inspect it first');
    if (pending && pending.appliedAt !== receipt.appliedAt) throw Error('Recorded acceptance belongs to another migration');
    if (!pending) {
        const nonce = randomUUID();
        pending = { nonce, proof: project + '/.hapi-migration-check-' + nonce + '.json', sessionId: requested,
            appliedAt: receipt.appliedAt, createdAt: new Date().toISOString(), stage: requested ? 'selected' : 'spawn-requested' };
        save(pendingFile, pending);
        if (!requested) {
            const spawned = await api('/machines/' + machineId + '/spawn', { directory: project, agent: 'codex', model: 'gpt-6.1-sol', permissionMode: 'yolo' });
            if (!spawned.sessionId) throw Error('Spawn returned no session ID; intent preserved for reconciliation');
            pending.sessionId = spawned.sessionId;
            pending.stage = 'spawned';
            save(pendingFile, pending);
        }
    }
    const sessionId = pending.sessionId;
    if (!sessionId) throw Error('An earlier spawn has an unknown result; inspect sessions before retrying');
    let current = (await api('/sessions/' + sessionId)).session;
    if (!sameDirectory(current?.metadata?.path, project) || current.metadata.flavor !== 'codex' || current.model !== 'gpt-6.1-sol') throw Error('Test session identity mismatch');
    if (!current.active) {
        if (!current.metadata.codexSessionId) throw Error('Empty stub has no Codex binding; inspect failed startup before creating a replacement');
        if (pending.resumeRequested) throw Error('Earlier resume outcome needs reconciliation; no automatic replay');
        pending.resumeRequested = true; save(pendingFile, pending);
        const resumed = await api('/sessions/' + sessionId + '/resume', { permissionMode: 'yolo' });
        if (resumed.sessionId !== sessionId) throw Error('Resume did not preserve the test session ID');
        current = (await api('/sessions/' + sessionId)).session;
    }
    if (current.permissionMode !== 'yolo') throw Error('Test session is not using yolo permissions');
    const localId = 'migration-' + pending.nonce;
    let messages = (await api('/sessions/' + sessionId + '/messages?limit=100')).messages ?? [];
    if (!pending.messageRequested) {
        if (current.thinking || messages.some(m => m.content?.role === 'user')) throw Error('Selected test session is already in use');
        pending.messageRequested = true; save(pendingFile, pending);
        const command = testCommand(pending.nonce, pending.proof, realpathSync(project));
        await api('/sessions/' + sessionId + '/messages', { localId,
            text: '这是主人授权的迁移验收测试。请只执行下面这条 shell 命令，检查实际系统身份、HOME、项目写入和 HTTPS 联网；成功后只回复 MIGRATION_OK，失败如实报告，不改其他文件。\n' + command });
    } else if (!messages.some(m => m.localId === localId)) {
        throw Error('Earlier message result is unknown; inspect before replaying');
    }
    console.log(JSON.stringify({ testSession: sessionId, status: 'verifying-model-tools-network' }));
    let verified = false;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
        current = (await api('/sessions/' + sessionId)).session;
        messages = (await api('/sessions/' + sessionId + '/messages?limit=100')).messages ?? [];
        if (existsSync(pending.proof)) {
            const result = read(pending.proof);
            if (result.nonce !== pending.nonce || result.uid !== 501 || result.user !== 'zhuhe' || result.networkStatus !== 200 || statSync(pending.proof).uid !== 501) throw Error('Tool proof mismatch');
            if (messages.some(isModelReply) && !current.thinking) { verified = true; break; }
        }
        await sleep(3000);
    }
    if (!verified) throw Error('Live test is incomplete; session and pending record preserved, no automatic replay');
    let candidate;
    if (pending.historyId) candidate = (await api('/sessions/' + pending.historyId)).session;
    else {
        const { sessions } = await api('/sessions');
        for (const s of sessions ?? []) {
            if (s.id === sessionId || s.createdAt >= Date.parse(receipt.appliedAt)) continue;
            const { session } = await api('/sessions/' + s.id);
            if (session?.metadata?.codexSessionId && !session.thinking && sameDirectory(session.metadata.path, project)) { candidate = session; break; }
        }
        if (!candidate) throw Error('No migrated Codex history is available');
        pending.historyId = candidate.id; pending.historyCodexId = candidate.metadata.codexSessionId;
        save(pendingFile, pending);
    }
    if (!candidate.active) {
        if (pending.historyResumeRequested) throw Error('Earlier history resume needs reconciliation; no automatic replay');
        pending.historyResumeRequested = true; save(pendingFile, pending);
        const resumed = await api('/sessions/' + candidate.id + '/resume', { permissionMode: 'yolo' });
        if (resumed.sessionId !== candidate.id) throw Error('Old conversation ID changed on resume');
    }
    let resumed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
        const { session } = await api('/sessions/' + candidate.id);
        if (session?.active && session.metadata?.codexSessionId === pending.historyCodexId && Number.isSafeInteger(session.metadata.hostPid)) {
            const uid = Number(execFileSync('/bin/ps', ['-p', String(session.metadata.hostPid), '-o', 'uid='], { encoding: 'utf8' }).trim());
            if (uid === 501) { resumed = true; break; }
        }
        await sleep(1000);
    }
    if (!resumed) throw Error('Old Codex history did not resume as zhuhe');
    const report = { verifiedAt: new Date().toISOString(), sessionId, nonce: pending.nonce, proof: pending.proof,
        uid: 501, user: 'zhuhe', project, physicalProject: realpathSync(project), networkStatus: 200,
        model: current.model, permissionMode: current.permissionMode, realReply: true, resumedHistory: true, resumedSessionId: candidate.id };
    save(dir + '/live-proof.json', report);
    console.log(JSON.stringify(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { await run(); } catch (error) { console.error('ERROR: ' + error.message); process.exitCode = 1; }
}
