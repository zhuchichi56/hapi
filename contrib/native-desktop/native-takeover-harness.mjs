// Isolated takeover harness: runs a source directory's real native-mcp.{mjs,pl}
// and native-trust.mjs in a temp HOME. Only the ps binary and the App path
// constant of a copy of native-trust.mjs are redirected (fake ps fails its first
// N calls, then reports a fixture App ancestor); the production socket, lock and
// processes are never touched. Usage: node native-takeover-harness.mjs <srcDir> <label> [trials] [windowSec]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { acquireHostLock } from './native-host-lock.mjs';

const runtime = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
const here = fileURLToPath(new URL('.', import.meta.url));
const pause = ms => new Promise(r => setTimeout(r, ms));
const FIXTURE_APP = '/fixture/ChatGPT';

const hostStub = `import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { acquireHostLock } from './native-host-lock.mjs';
export async function startHost({socketPath}) {
 const log = e => appendFileSync(socketPath + '.events', JSON.stringify({e, pid: process.pid, t: Date.now()}) + '\\n');
 const lock = await acquireHostLock(socketPath); log('lock-acquired');
 const server = http.createServer((q, s) => s.end(JSON.stringify({fixture: true})));
 try { await new Promise((ok, no) => { server.once('error', no); server.listen(socketPath, ok); }); }
 catch (e) { lock.release(); throw e; }
 log('listening');
 server.once('close', () => { lock.release(); log('lock-released'); });
 return server;
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()) && process.argv[2]) {
 const server = await startHost({ socketPath: process.argv[2] });
 process.on('SIGTERM', () => server.close(() => process.exit(0)));
}`;

async function makeFixture(src, mode) {
  const home = await mkdtemp('/tmp/tk-');
  const lib = join(home, '.local/lib/native-desktop-bridge');
  const state = join(home, '.local/state/native-desktop-bridge');
  await mkdir(lib, { recursive: true }); await mkdir(state, { recursive: true, mode: 0o700 });
  for (const n of ['native-mcp.mjs', 'native-mcp.pl']) await writeFile(join(lib, n), await readFile(join(src, n)));
  await writeFile(join(lib, 'native-host-lock.mjs'), await readFile(join(here, 'native-host-lock.mjs')));
  const fakePs = join(home, 'fake-ps.sh'), counter = join(home, 'ps-count');
  await writeFile(counter, '0');
  await writeFile(fakePs, `#!/bin/sh
n=$(cat '${counter}'); echo $((n+1)) > '${counter}'
[ "$n" -lt ${mode.failFirst} ] && exit 2
if [ "$2" = 99999 ]; then echo "1 ${FIXTURE_APP}"; else echo "99999 /usr/bin/fixture"; fi
`);
  await chmod(fakePs, 0o755);
  let trust = await readFile(join(src, 'native-trust.mjs'), 'utf8');
  trust = trust.replaceAll("'/bin/ps'", `'${fakePs}'`).replace(/(TRUSTED_APP_EXECUTABLE = )'[^']+'/, `$1'${FIXTURE_APP}'`);
  await writeFile(join(lib, 'native-trust.mjs'), trust);
  await writeFile(join(state, 'config.json'), JSON.stringify({ callerThreadId: 'harness' }));
  await writeFile(join(lib, 'native-host.mjs'), hostStub);
  return { home, lib, socketPath: join(state, 'host.sock'), counter };
}
const ping = socketPath => new Promise(ok => {
  const q = http.request({ socketPath, path: '/', method: 'POST', timeout: 400 }, s => { s.resume(); s.on('end', () => ok(true)); });
  q.on('error', () => ok(false)); q.on('timeout', () => { q.destroy(); ok(false); }); q.end('{}');
});
const spawnIn = (cmd, args, home) => { const p = spawn(cmd, args, { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] }); p.stderrText = ''; p.stderr.on('data', d => p.stderrText += d); p.stdout.resume(); return p; };
async function waitUp(socketPath, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await ping(socketPath)) return true; await pause(50); } return false; }
async function events(socketPath) { try { return (await readFile(socketPath + '.events', 'utf8')).trim().split('\n').map(JSON.parse); } catch { return []; } }

async function trial(src, scenario, windowMs) {
  const fx = await makeFixture(src, { failFirst: scenario === 'perl-follower' ? 1 : 2 });
  const procs = [];
  try {
    let t0, killedPrior = false;
    if (scenario === 'perl-follower') {
      const prior = spawnIn(runtime, [join(fx.lib, 'native-host.mjs'), fx.socketPath], fx.home); procs.push(prior);
      if (!await waitUp(fx.socketPath, 3000)) throw Error('prior host did not start');
      const f = spawnIn('/usr/bin/perl', [join(fx.lib, 'native-mcp.pl')], fx.home); procs.push(f);
      await pause(500);
      prior.kill('SIGKILL'); killedPrior = true; t0 = Date.now(); // simulated host loss in the isolated fixture only
      await new Promise(r => prior.once('exit', r)); await rm(fx.socketPath, { force: true }); // stale socket file of the killed fixture host
    } else {
      t0 = Date.now(); procs.push(spawnIn(runtime, [join(fx.lib, 'native-mcp.mjs')], fx.home));
    }
    const up = await waitUp(fx.socketPath, windowMs);
    const seconds = (Date.now() - t0) / 1000;
    const ev1 = await events(fx.socketPath);
    const psCalls = Number(await readFile(fx.counter, 'utf8'));
    const logTail = procs.map(p => p.stderrText).join('').split('\n').filter(l => l.startsWith('Desktop bridge')).slice(-3);
    // release proof: stop the acquired host (fixture process only), then check the lock is free
    const owner = ev1.filter(e => e.e === 'lock-acquired').at(-1)?.pid;
    if (owner) { try { process.kill(owner, 'SIGTERM'); } catch {} await pause(500); }
    // Independent proof the OS released the flock after the owner stopped: a fresh acquire succeeds.
    let lockFreeAfterStop = false;
    try { (await acquireHostLock(fx.socketPath)).release(); lockFreeAfterStop = true; } catch {}
    const ev = await events(fx.socketPath);
    return { scenario, recovered: up, seconds: Number(seconds.toFixed(2)), killedPrior, psCalls, lockAcquired: ev.filter(e => e.e === 'lock-acquired').length, lockFreeAfterStop, logTail };
  } finally {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
    await rm(fx.home, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, label, trials = '3', windowSec = '20'] = process.argv.slice(2);
  const results = [];
  for (let i = 1; i <= Number(trials); i++) for (const scenario of ['perl-follower', 'node-candidate']) {
    const r = { label, trial: i, ...await trial(resolve(src), scenario, Number(windowSec) * 1000) };
    results.push(r); console.log(JSON.stringify(r));
  }
}
