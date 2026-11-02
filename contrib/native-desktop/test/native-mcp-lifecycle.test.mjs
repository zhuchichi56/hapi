import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = name => readFileSync(new URL(`../${name}`, import.meta.url));

async function fixture(t, { lock = false } = {}) {
  const home = await mkdtemp('/tmp/nb-');
  const lib = join(home, '.local/lib/native-desktop-bridge');
  const state = join(home, '.local/state/native-desktop-bridge');
  await mkdir(lib, { recursive: true }); await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(lib, 'native-mcp.mjs'), source('native-mcp.mjs'));
  await writeFile(join(lib, 'native-mcp.pl'), source('native-mcp.pl'));
  const lockSource = new URL('../native-host-lock.mjs', import.meta.url);
  await writeFile(join(lib, 'native-host-lock.mjs'), readFileSync(lockSource));
  await writeFile(join(state, 'config.json'), JSON.stringify({ callerThreadId: 'acceptance' }));
  await writeFile(join(lib, 'native-trust.mjs'), `import { appendFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const TRUSTED_APP_EXECUTABLE = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
export function resolveTrustedApp() {
  const raw = process.env.FIXTURE_TRUST ?? 'none';
  return raw === 'none' ? null : { appPid: Number(raw), appExecutable: TRUSTED_APP_EXECUTABLE };
}
export function isOriginalAppAlive(app) {
  try { process.kill(app.appPid, 0); return true; } catch { return false; }
}
let invokedHere = false;
try { invokedHere = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])); } catch {}
if (invokedHere) {
  if (process.env.FIXTURE_TRUST_LOG) appendFileSync(process.env.FIXTURE_TRUST_LOG, 'checked\\n');
  process.exit(process.env.FIXTURE_TRUST_CLI_EXIT === '0' ? 0 : 1);
}`);
  await writeFile(join(lib, 'native-host.mjs'), `import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { acquireHostLock } from './native-host-lock.mjs';
export async function startHost({socketPath}) {
  const lock = await acquireHostLock(socketPath);
  const server = http.createServer((req, res) => {
    if (process.env.FIXTURE_REQUEST_LOG) appendFileSync(process.env.FIXTURE_REQUEST_LOG, req.method + ' ' + req.url + '\\n');
    res.end(JSON.stringify({fixture: true}));
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  } catch (error) { lock.release(); throw error; }
  server.once('close', () => lock.release());
  return server;
}`);
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, lib, state, socketPath: join(state, 'host.sock') };
}

function child(t, command, args, env) {
  const process = spawn(command, args, { env: { ...globalThis.process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stderr.resume();
  t.after(async () => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exited = once(process, 'exit'); process.kill('SIGTERM'); await exited;
  });
  return process;
}

function fakeApp(t) {
  const app = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => {
    if (app.exitCode !== null || app.signalCode !== null) return;
    const exited = once(app, 'exit'); app.kill('SIGTERM'); await exited;
  });
  return app;
}

function rpc(process, id, method) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('MCP response timed out')), 3000);
    process.stdout.once('data', data => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString().split('\n')[0])); } catch (error) { reject(error); }
    });
    process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n');
  });
}

function read(socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/command', method: 'POST', timeout: 500 }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => raw += chunk); res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('Fixture request timed out'))); req.end('{}');
  });
}
async function ready(socketPath, timeout = 3500) {
  const deadline = Date.now() + timeout;
  do { try { return await read(socketPath) } catch { await pause(25) } } while (Date.now() < deadline);
  throw Error('Bridge did not take over within the bounded recovery window');
}
async function gone(socketPath) {
  try { await access(socketPath); return false; } catch { return true; }
}
async function exited(process, timeout) {
  const result = await Promise.race([
    once(process, 'exit').then(([code, signal]) => ({ code, signal, timedOut: false })),
    pause(timeout).then(() => ({ timedOut: true })),
  ]);
  return result;
}

test('verified App ancestry hosts, and the host survives its chat MCP stdin closing', async t => {
  const { home, socketPath } = await fixture(t);
  const app = fakeApp(t);
  const host = child(t, process.execPath, [join(home, '.local/lib/native-desktop-bridge/native-mcp.mjs')], { HOME: home, FIXTURE_TRUST: String(app.pid) });
  assert.deepEqual(await ready(socketPath), { fixture: true });
  assert.equal((await rpc(host, 1, 'initialize')).id, 1);
  host.stdin.end(); await pause(200);
  assert.equal(host.exitCode, null, 'closing one chat must not terminate the shared bridge');
  assert.deepEqual(await read(socketPath), { fixture: true });
});

test('a detached CLI without a verified App ancestor never becomes host', async t => {
  const { home, socketPath } = await fixture(t);
  const follower = child(t, process.execPath, [join(home, '.local/lib/native-desktop-bridge/native-mcp.mjs')], { HOME: home, FIXTURE_TRUST: 'none' });
  assert.equal((await rpc(follower, 1, 'initialize')).id, 1);
  assert.deepEqual((await rpc(follower, 2, 'tools/list')).result, { tools: [] });
  await pause(500);
  assert.equal(await gone(socketPath), true, 'no singleton socket may be created');
  assert.equal(follower.exitCode, null);
});

test('the host exits when its App ancestor dies while the CLI keeps running', async t => {
  const { home, socketPath } = await fixture(t);
  const app = fakeApp(t);
  const host = child(t, process.execPath, [join(home, '.local/lib/native-desktop-bridge/native-mcp.mjs')], { HOME: home, FIXTURE_TRUST: String(app.pid) });
  await ready(socketPath);
  const appExit = once(app, 'exit'); app.kill('SIGTERM'); await appExit;
  const result = await exited(host, 12000);
  assert.equal(result.timedOut, false, 'host must not outlive the App ancestor');
  assert.equal(result.code, 0);
  await assert.rejects(read(socketPath));
});

test('same-App followers do not fight the singleton and do not replay commands', async t => {
  const { home, socketPath, state } = await fixture(t);
  const requestLog = join(state, 'requests.log'); writeFileSync(requestLog, '');
  const app = fakeApp(t);
  const env = { HOME: home, FIXTURE_TRUST: String(app.pid), FIXTURE_REQUEST_LOG: requestLog };
  const host = child(t, process.execPath, [join(home, '.local/lib/native-desktop-bridge/native-mcp.mjs')], env);
  await ready(socketPath);
  writeFileSync(requestLog, '');
  const follower = child(t, process.execPath, [join(home, '.local/lib/native-desktop-bridge/native-mcp.mjs')], env);
  await pause(700);
  assert.equal(host.exitCode, null);
  assert.equal(follower.exitCode, null);
  assert.equal((await rpc(follower, 1, 'initialize')).id, 1);
  assert.equal(readFileSync(requestLog, 'utf8'), '', 'followers must not emit /command actions');
  assert.deepEqual(await read(socketPath), { fixture: true });
});

test('the retained flock still allows exactly one host', async t => {
  const { lib, socketPath } = await fixture(t);
  const { acquireHostLock } = await import(pathToFileURL(join(lib, 'native-host-lock.mjs')).href);
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => acquireHostLock(socketPath)));
  const held = results.filter(result => result.status === 'fulfilled');
  assert.equal(held.length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && /already running/.test(result.reason.message)).length, 2);
  held[0].value.release();
  let next;
  for (let attempt = 0; attempt < 30 && !next; attempt++) {
    try { next = await acquireHostLock(socketPath); } catch { await pause(10); }
  }
  assert.ok(next?.release);
  next.release();
});

test('the Perl follower refuses takeover without a verified App ancestor', async t => {
  const { home, socketPath, state } = await fixture(t);
  const trustLog = join(state, 'trust.log'); writeFileSync(trustLog, '');
  const follower = child(t, '/usr/bin/perl', [join(home, '.local/lib/native-desktop-bridge/native-mcp.pl')], {
    HOME: home, FIXTURE_TRUST: 'none', FIXTURE_TRUST_CLI_EXIT: '1', FIXTURE_TRUST_LOG: trustLog,
  });
  assert.equal((await rpc(follower, 1, 'initialize')).id, 1);
  await pause(1200);
  assert.equal(readFileSync(trustLog, 'utf8'), 'checked\n', 'Perl must run the shared trust helper on takeover');
  assert.equal(await gone(socketPath), true);
  assert.equal(follower.exitCode, null);
});

test('the Perl follower takes over only after the helper verifies the App ancestor', async t => {
  const { home, socketPath, state } = await fixture(t);
  const trustLog = join(state, 'trust.log'); writeFileSync(trustLog, '');
  const follower = child(t, '/usr/bin/perl', [join(home, '.local/lib/native-desktop-bridge/native-mcp.pl')], {
    HOME: home, FIXTURE_TRUST: String(process.pid), FIXTURE_TRUST_CLI_EXIT: '0', FIXTURE_TRUST_LOG: trustLog,
  });
  assert.deepEqual(await ready(socketPath), { fixture: true });
  assert.equal(readFileSync(trustLog, 'utf8'), 'checked\n');
  assert.equal(follower.exitCode, null);
});
