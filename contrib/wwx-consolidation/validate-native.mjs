#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(cfg.out, 'manifest.json'), 'utf8'));
const profile = path.join(cfg.out, 'native');
// Isolated native loader: no credential, no turn/start, no model request.
fs.writeFileSync(path.join(profile, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "${cfg.provider}"\n[model_providers.${cfg.provider}]\nname = "Offline migration loader"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n`, { mode: 0o600 });
const child = spawn(cfg.codex, ['app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: profile }, stdio: ['pipe', 'pipe', 'pipe'] });
const stderr = fs.openSync(path.join(cfg.out, 'native-loader.stderr'), 'a', 0o600);
child.stderr.on('data', data => fs.writeSync(stderr, data));
let buffer = '', id = 0;
const pending = new Map();
child.stdout.on('data', data => {
    buffer += data.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        const p = pending.get(value.id);
        if (p) {
            clearTimeout(p.timer); pending.delete(value.id);
            if (value.error) {
                fs.appendFileSync(path.join(cfg.out, 'native-errors.private.jsonl'), JSON.stringify({ method: p.method, error: value.error }) + '\n', { mode: 0o600 });
                p.reject(Error('Native loader rejected ' + p.method + ': ' + value.error.code));
            } else p.resolve(value.result);
        }
    }
});
function rpc(method, params) {
    return new Promise((resolve, reject) => {
        const n = ++id;
        const timer = setTimeout(() => { pending.delete(n); reject(Error('Native loader timeout: ' + method)); }, 60000);
        pending.set(n, { resolve, reject, timer, method });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
}
const previous = process.argv.includes('--failed-only') ? JSON.parse(fs.readFileSync(path.join(cfg.out, 'native-validation.json'), 'utf8')) : null;
const validated = previous?.validated || [], failed = [];
const selected = previous ? new Set(previous.failed.map(e => e.id)) : null;
try {
    await rpc('initialize', { clientInfo: { name: 'wwx-migration-offline-loader', version: '1.0.0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    for (const entry of manifest.entries.filter(e => e.nativeId && (!selected || selected.has(e.id)))) {
        try {
            const read = await rpc('thread/read', { threadId: entry.nativeId, includeTurns: false });
            if (read.thread?.id !== entry.nativeId) throw Error('Read changed native identity');
            const resumed = await rpc('thread/resume', { threadId: entry.nativeId, cwd: cfg.cwd, modelProvider: cfg.provider });
            if (resumed.thread?.id !== entry.nativeId || fs.realpathSync(resumed.thread?.cwd) !== fs.realpathSync(cfg.cwd)) throw Error('Resume identity/directory mismatch');
            if (!resumed.thread?.turns?.length) throw Error('No recovered native context');
            await rpc('thread/unsubscribe', { threadId: entry.nativeId });
            validated.push({ id: entry.id, nativeId: entry.nativeId, recovery: entry.recovery.source, turns: resumed.thread.turns.length });
        } catch (error) { failed.push({ id: entry.id, error: error.message }); }
        if ((validated.length + failed.length) % 16 === 0) console.log(JSON.stringify({ checked: validated.length + failed.length, passed: validated.length, failed: failed.length }));
    }
} finally {
    child.stdin.end(); child.kill('SIGTERM'); fs.closeSync(stderr);
    fs.writeFileSync(path.join(cfg.out, 'native-validation.json'), JSON.stringify({ validated, failed, modelRequests: 0 }, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ validated: validated.length, failed: failed.length, modelRequests: 0 }));
if (failed.length) process.exitCode = 1;
