import { test, expect } from 'bun:test';
import { zstdCompressSync } from 'node:zlib';
import { decode, visibleText, migratedMetadata, messageDigest, rolloutBasename, originalMessages } from './consolidate.mjs';
import { Database } from 'bun:sqlite';
test('original-row verification tolerates appended turns and fully drains SQLite iterators', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE messages(id TEXT,session_id TEXT,seq INTEGER,content TEXT)');
    db.query('INSERT INTO messages VALUES (?,?,?,?)').run('old', 's', 1, 'original');
    const before = messageDigest(originalMessages(db, 's', 1));
    db.query('INSERT INTO messages VALUES (?,?,?,?)').run('new', 's', 2, 'new turn');
    expect(messageDigest(originalMessages(db, 's', 1))).toEqual(before);
    expect(messageDigest(originalMessages(db, 's', 0)).count).toBe(0);
    expect(messageDigest(originalMessages(db, 's', 1))).toEqual(before);
    db.close();
});
test('uses canonical native filenames for paginated histories', () => {
    expect(rolloutBasename('2026-10-24T19:26:39.591Z', 'id')).toBe('rollout-2026-10-24T19-26-39-id.jsonl');
});
test('preserves TEXT/BLOB semantics and excludes hidden thought and executable historical tools', () => {
    const user = { role: 'user', content: { type: 'text', text: 'continue' } };
    expect(decode(JSON.stringify(user))).toEqual(user);
    expect(decode(zstdCompressSync(Buffer.from(JSON.stringify(user))))).toEqual(user);
    expect(visibleText(user)).toEqual({ role: 'user', text: 'continue' });
    for (const type of ['reasoning', 'tool-call', 'tool-call-result']) expect(visibleText({ role: 'agent', content: { type: 'codex', data: { type, message: 'private' } } })).toBe(null);
});
test('maps execution identity without rewriting transcript or retaining stale RPC endpoints', () => {
    const result = migratedMetadata({ path: '/home/v-hezhu2/wwx', name: 'My title', hostPid: 12, hapiMcpUrl: 'old', codexSessionId: 'native' },
        { cwd: '/current/wwx', machineId: 'machine', host: 'mini', profile: '/profile' }, 'native', { source: 'original-rollout' });
    expect(result.path).toBe('/current/wwx'); expect(result.codexSessionId).toBe('native'); expect(result.name).toBe('My title');
    expect(result.hostPid).toBeUndefined(); expect(result.hapiMcpUrl).toBeUndefined(); expect(result.lifecycleState).toBe('archived');
});
test('raw digest catches content, delivery and identity changes', () => {
    const row = { id: 'm', session_id: 's', seq: 1, content: 'hello', invoked_at: 4, delivery_state: 'queued' };
    const a = messageDigest([row]);
    for (const mutation of [{ content: 'changed' }, { invoked_at: null }, { id: 'new' }, { content: Buffer.from('hello') }]) expect(messageDigest([{ ...row, ...mutation }]).sha256).not.toBe(a.sha256);
});
