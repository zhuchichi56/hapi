import test from 'node:test';
import assert from 'node:assert/strict';
import { readProcessRecord, resolveTrustedApp, isOriginalAppAlive, parseProcessRecord, TRUSTED_APP_EXECUTABLE } from '../native-trust.mjs';

const APP = TRUSTED_APP_EXECUTABLE;
function table(rows) {
  const map = new Map(rows.map(([pid, ppid, comm]) => [pid, { ppid, comm }]));
  return { map, read: pid => map.get(pid) ?? null };
}

test('valid App ancestry resolves to the exact App executable, not the CLI', () => {
  const { read } = table([
    [500, 400, '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node'],
    [400, 300, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'],
    [300, 1, APP],
    [1, 0, '/sbin/launchd'],
  ]);
  const app = resolveTrustedApp({ pid: 500, read });
  assert.equal(app?.appPid, 300);
  assert.equal(app?.appExecutable, APP);
  assert.deepEqual(app?.chain.map(entry => entry.pid), [500, 400, 300]);
  assert.equal(isOriginalAppAlive(app, { pid: 500, read }), true);
});

test('detached Homebrew Codex CLI chain has no App and is untrusted', () => {
  const { read } = table([
    [6505, 2358, '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node'],
    [2358, 2357, '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex'],
    [2357, 1, 'node'],
    [1, 0, '/sbin/launchd'],
  ]);
  assert.equal(resolveTrustedApp({ pid: 6505, read }), null);
});

test('only the exact App executable path is trusted', () => {
  for (const comm of [
    'ChatGPT',
    '/Applications/ChatGPT (OpenAI).app/Contents/MacOS/ChatGPT',
    '/tmp/ChatGPT.app/Contents/MacOS/ChatGPT',
    '/Applications/ChatGPT.app/Contents/MacOS/Codex',
    '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT2',
  ]) {
    const { read } = table([[500, 400, 'node'], [400, 300, comm], [300, 1, '/sbin/launchd']]);
    assert.equal(resolveTrustedApp({ pid: 500, read }), null, comm);
  }
});

test('ancestor exit with a surviving CLI invalidates the host lifetime', () => {
  const { map, read } = table([
    [500, 400, 'node'],
    [400, 300, 'codex'],
    [300, 1, APP],
    [1, 0, '/sbin/launchd'],
  ]);
  const app = resolveTrustedApp({ pid: 500, read });
  assert.equal(app?.appPid, 300);
  map.delete(300); // App exited; both CLI (400) and host (500) survived.
  assert.equal(isOriginalAppAlive(app, { pid: 500, read }), false);
});

test('a reparented surviving CLI no longer reaches the original App', () => {
  const { map, read } = table([
    [500, 1, 'node'],
    [400, 300, 'codex'],
    [300, 1, APP],
    [1, 0, '/sbin/launchd'],
  ]);
  const app = { appPid: 300, appExecutable: APP };
  assert.equal(isOriginalAppAlive(app, { pid: 500, read }), false);
  map.set(500, { ppid: 400, comm: 'node' });
  assert.equal(isOriginalAppAlive(app, { pid: 500, read }), true);
});

test('missing ps rows and cycles fail closed', () => {
  assert.equal(resolveTrustedApp({ pid: 900, read: () => null }), null);
  const { read: cycle } = table([[500, 400, 'node'], [400, 500, 'codex']]);
  assert.equal(resolveTrustedApp({ pid: 500, read: cycle }), null);
  assert.deepEqual(parseProcessRecord('   1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n'), { ppid: 1, comm: APP });
  assert.deepEqual(parseProcessRecord('  42 /Applications/ChatGPT (OpenAI).app/Contents/MacOS/ChatGPT  \n'), { ppid: 42, comm: '/Applications/ChatGPT (OpenAI).app/Contents/MacOS/ChatGPT' });
  assert.equal(parseProcessRecord(''), null);
});

test('on-device ps can read this process', t => {
  const record = readProcessRecord(process.pid);
  if (!record) { t.skip('/bin/ps is not executable in this sandbox'); return; }
  assert.equal(record.ppid, process.ppid);
});
