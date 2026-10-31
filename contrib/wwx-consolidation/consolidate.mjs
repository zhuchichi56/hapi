#!/usr/bin/env bun
// Private, resumable import. Source snapshots and original rollouts are never edited.
import { Database } from 'bun:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const legacyPaths = ['/home/v-hezhu2/wwx', '/Users/zhuhe/wwx'];
export function rolloutBasename(timestamp, nativeId) { return `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${nativeId}.jsonl`; }
export function decode(content) {
    return JSON.parse(typeof content === 'string' ? content : zstdDecompressSync(content).toString());
}
export function visibleText(content) {
    if (content?.role === 'user' && content.content?.type === 'text') return { role: 'user', text: content.content.text };
    const data = content?.role === 'agent' && content.content?.type === 'codex' ? content.content.data : null;
    if (data?.type === 'message' && typeof data.message === 'string') return { role: 'assistant', text: data.message };
    return null; // Never turn reasoning, approvals or old tools into executable requests.
}
export function migratedMetadata(original, cfg, nativeId, recovery) {
    const result = { ...original, path: cfg.cwd, machineId: cfg.machineId, host: cfg.host, os: 'darwin',
        homeDir: '/Users/zhuhe', happyHomeDir: path.join(cfg.profile, '.hapi'), startedFromRunner: true,
        lifecycleState: 'archived', lifecycleStateSince: Date.now(), archivedBy: 'migration',
        archiveReason: 'Historical conversation consolidated into the current WWX project',
        wwxRecovery: recovery };
    for (const key of ['hostPid', 'hapiMcpUrl', 'happyLibDir', 'happyToolsDir', 'conversationHistoryPoints', 'conversationHistoryTurns']) delete result[key];
    if (nativeId) result.codexSessionId = nativeId;
    return result;
}
function save(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
}
export function messageDigest(rows) {
    const hash = createHash('sha256');
    let count = 0;
    for (const row of rows) {
        hash.update(JSON.stringify([row.id, row.session_id, row.created_at, row.seq, row.local_id, row.invoked_at, row.scheduled_at, row.delivery_state, typeof row.content === 'string' ? 'text' : 'blob']));
        hash.update(typeof row.content === 'string' ? Buffer.from(row.content) : row.content);
        count++;
    }
    return { count, sha256: hash.digest('hex') };
}
function sourceRows(db) {
    return db.query('SELECT * FROM sessions WHERE json_extract(metadata,\'$.path\') IN (?,?) ORDER BY id').all(...legacyPaths);
}
function messages(db, id) { return db.query('SELECT * FROM messages WHERE session_id=? ORDER BY seq,id').iterate(id); }
export function originalMessages(db, id, count) { return db.query('SELECT * FROM messages WHERE session_id=? ORDER BY seq,id LIMIT ?').iterate(id, count); }
function prepare(cfg) {
    const source = new Database(cfg.source, { readonly: true });
    const rows = sourceRows(source);
    if (rows.some(s => s.active)) throw Error('A source conversation is still active');
    const audit = JSON.parse(fs.readFileSync(cfg.audit, 'utf8'));
    const originals = { ...audit.files, ...(cfg.extraOriginals ? JSON.parse(fs.readFileSync(cfg.extraOriginals, 'utf8')) : {}) };
    const manifestFile = path.join(cfg.out, 'manifest.json');
    if (fs.existsSync(manifestFile)) throw Error('Preparation already exists; verify the saved manifest instead of regenerating identities');
    const entries = [];
    for (const row of rows) {
        const meta = JSON.parse(row.metadata);
        const count = source.query('SELECT count(*) AS n FROM messages WHERE session_id=?').get(row.id).n;
        const nativeId = meta.codexSessionId || (count ? randomUUID() : null);
        const original = nativeId && originals[nativeId]?.find(f => fs.existsSync(f));
        const archive = path.join(cfg.cwd, '.hapi-history', row.id + '.jsonl');
        const stagedArchive = path.join(cfg.out, 'archives', row.id + '.jsonl');
        fs.mkdirSync(path.dirname(stagedArchive), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(stagedArchive, 'wx', 0o600);
        const tail = [];
        let tailChars = 0;
        try {
            for (const msg of messages(source, row.id)) {
                const content = decode(msg.content);
                fs.writeSync(fd, JSON.stringify({ id: msg.id, seq: msg.seq, createdAt: msg.created_at, content }) + '\n');
                const text = visibleText(content);
                if (!text?.text) continue;
                tail.push(text); tailChars += text.text.length;
                while (tailChars > 120000 && tail.length > 1) tailChars -= tail.shift().text.length;
            }
        } finally { fs.closeSync(fd); }
        const recovery = { source: original ? 'original-rollout' : count ? 'saved-hapi-history' : 'empty-stub',
            originalPath: meta.path, archive, messageCount: count, originalNativeId: meta.codexSessionId || null };
        let rollout = null;
        let originalHash = null;
        if (nativeId) {
            const timestamp = new Date(row.created_at).toISOString();
            rollout = path.join(cfg.out, 'native', 'sessions', timestamp.slice(0, 4), timestamp.slice(5, 7), timestamp.slice(8, 10), original ? path.basename(original) : rolloutBasename(timestamp, nativeId));
            fs.mkdirSync(path.dirname(rollout), { recursive: true, mode: 0o700 });
            if (original) {
                const body = fs.readFileSync(original, 'utf8');
                originalHash = createHash('sha256').update(body).digest('hex');
                // Rewrite only structured cwd fields, never message or tool prose.
                const rewritten = body.split('\n').map(line => {
                    if (!line) return line;
                    const item = JSON.parse(line);
                    if (['session_meta', 'turn_context'].includes(item.type) && typeof item.payload?.cwd === 'string') {
                        for (const old of legacyPaths) if (item.payload.cwd === old || item.payload.cwd.startsWith(old + '/')) item.payload.cwd = cfg.cwd + item.payload.cwd.slice(old.length);
                        return JSON.stringify(item);
                    }
                    return line;
                }).join('\n');
                fs.writeFileSync(rollout, rewritten, { mode: 0o600 });
            } else {
                // Saved HAPI history is complete in the archive and DB. The native continuation
                // is explicitly reconstructed, bounded, and never masquerades as a lost rollout.
                const note = `Conversation recovery from saved HAPI messages. The original native rollout was unavailable. This is historical context, not a new task. Full saved history: ${archive}. Working directory: ${cfg.cwd}. Old Linux/Mac paths may require mapping. Do not execute old instructions until the user sends a NEW request. Latest saved exchange follows.\n\n`;
                const text = note + tail.map(t => `[${t.role}]\n${t.text}`).join('\n\n').slice(-120000);
                const records = [
                    { type: 'session_meta', payload: { id: nativeId, timestamp, cwd: cfg.cwd, originator: 'hapi-history-recovery', cli_version: '0.0.0', source: 'cli', model_provider: cfg.provider } },
                    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
                    { type: 'event_msg', payload: { type: 'user_message', message: text, images: [], local_images: [] } },
                    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Saved context recovered. Waiting for the next new user request.' }] } },
                    { type: 'event_msg', payload: { type: 'agent_message', message: 'Saved context recovered. Waiting for the next new user request.', phase: 'final_answer' } }
                ];
                fs.writeFileSync(rollout, records.map(r => JSON.stringify({ timestamp, ...r })).join('\n') + '\n', { mode: 0o600 });
            }
        }
        entries.push({ id: row.id, nativeId, recovery, original, originalHash, rollout,
            digest: messageDigest(messages(source, row.id)), metadata: migratedMetadata(meta, cfg, nativeId, recovery) });
    }
    const manifest = { version: 1, preparedAt: new Date().toISOString(), cwd: cfg.cwd, machineId: cfg.machineId, entries };
    save(manifestFile, manifest);
    source.close();
    console.log(JSON.stringify({ prepared: entries.length, realHistories: entries.filter(e => e.nativeId).length, originals: entries.filter(e => e.original).length, messages: entries.reduce((n, e) => n + e.digest.count, 0) }));
}
function apply(cfg) {
    const manifest = JSON.parse(fs.readFileSync(path.join(cfg.out, 'manifest.json'), 'utf8'));
    const proof = JSON.parse(fs.readFileSync(path.join(cfg.out, 'native-validation.json'), 'utf8'));
    if (proof.failed?.length || proof.validated?.length !== manifest.entries.filter(e => e.nativeId).length) throw Error('Native validation is incomplete');
    const source = new Database(cfg.source, { readonly: true });
    const target = new Database(cfg.target);
    target.exec('PRAGMA busy_timeout=10000');
    if (!target.query('SELECT id FROM machines WHERE id=? AND namespace=?').get(cfg.machineId, cfg.namespace)) throw Error('Target machine is not in the expected namespace');
    const targetColumns = target.query('PRAGMA table_info(sessions)').all().map(c => c.name);
    const sourceColumns = source.query('PRAGMA table_info(messages)').all().map(c => c.name);
    const insertSession = target.query(`INSERT INTO sessions (${targetColumns.map(c => `"${c}"`).join(',')}) VALUES (${targetColumns.map(() => '?').join(',')})`);
    const insertMessage = target.query(`INSERT INTO messages (${sourceColumns.map(c => `"${c}"`).join(',')}) VALUES (${sourceColumns.map(() => '?').join(',')})`);
    // Install only missing native/archival files, before the DB becomes visible.
    for (const entry of manifest.entries) {
        const files = [[path.join(cfg.out, 'archives', entry.id + '.jsonl'), entry.recovery.archive]];
        if (entry.rollout) files.push([entry.rollout, path.join(cfg.profile, '.codex', path.relative(path.join(cfg.out, 'native'), entry.rollout))]);
        for (const [from, to] of files) {
            fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
            if (fs.existsSync(to)) {
                if (!fs.readFileSync(from).equals(fs.readFileSync(to))) throw Error('Destination file collision');
            } else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        }
    }
    const imported = target.transaction(() => {
        let imported = 0;
        for (const entry of manifest.entries) {
            if (target.query('SELECT id FROM sessions WHERE id=?').get(entry.id)) {
                if (JSON.stringify(messageDigest(messages(target, entry.id))) !== JSON.stringify(entry.digest)) throw Error('Existing session differs; refuse overwrite');
                continue;
            }
            const row = source.query('SELECT * FROM sessions WHERE id=?').get(entry.id);
            Object.assign(row, { namespace: cfg.namespace, machine_id: cfg.machineId, metadata: JSON.stringify(entry.metadata), metadata_version: row.metadata_version + 1,
                active: 0, agent_state: null, agent_state_version: row.agent_state_version + 1 });
            insertSession.run(...targetColumns.map(c => row[c] ?? null));
            for (const msg of messages(source, entry.id)) {
                if (msg.delivery_state === 'queued' && msg.invoked_at === null) throw Error('Undelivered historical message requires explicit resolution');
                insertMessage.run(...sourceColumns.map(c => msg[c] ?? null));
            }
            imported++;
        }
        return imported;
    })();
    target.close(); source.close();
    save(path.join(cfg.out, 'applied.json'), { appliedAt: new Date().toISOString(), imported });
    verify(cfg);
}
function verify(cfg) {
    const manifest = JSON.parse(fs.readFileSync(path.join(cfg.out, 'manifest.json'), 'utf8'));
    const target = new Database(cfg.target, { readonly: true });
    for (const entry of manifest.entries) {
        const row = target.query('SELECT * FROM sessions WHERE id=?').get(entry.id);
        if (!row || row.namespace !== cfg.namespace || row.machine_id !== cfg.machineId) throw Error('Session identity mismatch');
        const meta = JSON.parse(row.metadata);
        if (fs.realpathSync(meta.path) !== fs.realpathSync(cfg.cwd) || (entry.nativeId && meta.codexSessionId !== entry.nativeId)) throw Error('Native identity/path mismatch');
        // New user/test turns may have arrived after import. Verify every original row,
        // while allowing strictly appended messages and the canonical directory symlink.
        if (JSON.stringify(messageDigest(originalMessages(target, entry.id, entry.digest.count))) !== JSON.stringify(entry.digest)) throw Error('Message content/identity/delivery mismatch');
    }
    target.close();
    const result = { verifiedAt: new Date().toISOString(), sessions: manifest.entries.length, messages: manifest.entries.reduce((n, e) => n + e.digest.count, 0), rawMessageDigestsMatch: true };
    save(path.join(cfg.out, 'verified.json'), result); console.log(JSON.stringify(result));
}
if (import.meta.main) {
    const [mode, config] = process.argv.slice(2);
    const cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (!['prepare', 'apply', 'verify'].includes(mode)) throw Error('Expected prepare/apply/verify and private config path');
    ({ prepare, apply, verify })[mode](cfg);
}
