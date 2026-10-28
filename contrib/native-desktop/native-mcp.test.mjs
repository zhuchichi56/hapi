import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';

const runtime = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  // macOS Unix socket paths are limited to 104 bytes, including the fixture HOME.
  const home = await mkdtemp('/tmp/nm-');
  const lib = join(home, '.local/lib/native-desktop-bridge');
  const state = join(home, '.local/state/native-desktop-bridge');
  await mkdir(lib, { recursive: true }); await mkdir(state, { recursive: true, mode: 0o700 });
  for (const name of ['native-mcp.mjs', 'native-mcp.pl']) {
    await writeFile(join(lib, name), await readFile(new URL(name, import.meta.url)));
  }
  await writeFile(join(state, 'config.json'), JSON.stringify({ callerThreadId: 'acceptance' }));
  // Only the real lifecycle/stdio implementation runs; no desktop or model is contacted.
  await writeFile(join(lib, 'native-host.mjs'), `import http from 'node:http';
export async function startHost({socketPath}) {
 const server=http.createServer((req,res)=>res.end(JSON.stringify({fixture:true})));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)});
 return server;
}`);
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, lib, socketPath: join(state, 'host.sock') };
}
function child(t, command, args, home) {
  const process = spawn(command, args, { env: { ...globalThis.process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stderr.resume();
  t.after(async () => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exited = once(process, 'exit'); process.kill('SIGTERM'); await exited;
  });
  return process;
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

test('the singleton keeps serving after its chat MCP input closes', async t => {
  const { home, lib, socketPath } = await fixture(t);
  const host = child(t, process.execPath, [join(lib, 'native-mcp.mjs')], home);
  assert.deepEqual(await ready(socketPath), { fixture: true });
  host.stdin.end(); await pause(150);
  assert.equal(host.exitCode, null, 'closing one chat must not terminate the shared bridge');
  assert.deepEqual(await read(socketPath), { fixture: true });
});

test('an existing follower takes over a failed host in under 3.5 seconds', async t => {
  try { await access(runtime) } catch { t.skip('Installed Codex desktop runtime is required'); return }
  const { home, lib, socketPath } = await fixture(t);
  const previous = http.createServer((req, res) => res.end('{}'));
  await new Promise(resolve => previous.listen(socketPath, resolve));
  t.after(() => previous.close());
  const follower = child(t, '/usr/bin/perl', [join(lib, 'native-mcp.pl')], home);
  const initialized = once(follower.stdout, 'data');
  follower.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  assert.equal(JSON.parse((await initialized)[0].toString()).id, 1);
  await new Promise(resolve => previous.close(resolve));
  const start = Date.now();
  assert.deepEqual(await ready(socketPath), { fixture: true });
  assert.ok(Date.now() - start < 3500);
});
