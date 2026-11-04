import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseTrustedApp, checkOriginalApp, inspectProcessRecord, TRUSTED_APP_EXECUTABLE as APP } from './native-trust.mjs';

const chain = map => pid => map[pid] ? { status: 'ok', record: map[pid] } : { status: 'missing' };
const good = { 10: { ppid: 20, comm: '/usr/bin/perl' }, 20: { ppid: 30, comm: 'codex' }, 30: { ppid: 1, comm: APP } };

test('a ps failure is transient, not a cached non-App verdict', () => {
  const r = diagnoseTrustedApp({ pid: 10, inspect: pid => pid === 20 ? { status: 'error', code: 'ETIMEDOUT' } : chain(good)(pid) });
  assert.equal(r.state, 'transient'); assert.equal(r.reason, 'ps-error:ETIMEDOUT');
  assert.equal(diagnoseTrustedApp({ pid: 10, inspect: chain(good) }).state, 'trusted');
});
test('non-App contexts are rejected definitively', () => {
  const other = { 10: { ppid: 20, comm: 'node' }, 20: { ppid: 1, comm: '/Applications/Other.app/Contents/MacOS/Other' } };
  assert.deepEqual(diagnoseTrustedApp({ pid: 10, inspect: chain(other) }).reason, 'no-app-ancestor');
  assert.equal(diagnoseTrustedApp({ pid: 10, inspect: chain({ 10: { ppid: 20, comm: 'x' } }) }).reason, 'process-missing');
});
test('App exit is gone; a failing ps is only unknown', () => {
  const app = diagnoseTrustedApp({ pid: 10, inspect: chain(good) }).app;
  assert.equal(checkOriginalApp(app, { pid: 10, inspect: chain(good) }), 'alive');
  assert.equal(checkOriginalApp(app, { pid: 10, inspect: () => ({ status: 'error', code: 'EAGAIN' }) }), 'unknown');
  assert.equal(checkOriginalApp(app, { pid: 10, inspect: chain({ 10: { ppid: 1, comm: 'perl' } }) }), 'gone');
  assert.equal(checkOriginalApp(app, { pid: 10, inspect: chain({ ...good, 30: { ppid: 1, comm: 'other' } }) }), 'gone');
});
test('inspectProcessRecord separates missing pid from ps failure', () => {
  const fail = err => () => { throw Object.assign(Error('x'), err); };
  assert.equal(inspectProcessRecord(1, { exec: fail({ status: 1, stdout: '' }) }).status, 'missing');
  assert.equal(inspectProcessRecord(1, { exec: fail({ code: 'ETIMEDOUT' }) }).status, 'error');
  const denied = inspectProcessRecord(1, { exec: fail({ status: 1, stdout: '', stderr: 'ps: Operation not permitted\n' }) });
  assert.deepEqual(denied, { status: 'error', code: 'denied' });
  assert.equal(inspectProcessRecord(1, { exec: fail({ status: 1, stdout: '', stderr: 'weird' }) }).code, 'exit1-diagnostic');
  assert.equal(inspectProcessRecord(1, { exec: fail({ status: 1, stdout: '', stderr: '' }) }).status, 'missing');
  assert.equal(inspectProcessRecord(99990).status, 'missing'); // real /bin/ps, genuinely absent pid
  assert.equal(inspectProcessRecord(1, { exec: () => '  12 /bin/x\n' }).status, 'ok');
});
test('sandbox-denied ps keeps a healthy host (unknown), genuine missing ancestry is gone, exact App path retained', () => {
  const app = diagnoseTrustedApp({ pid: 10, inspect: chain(good) }).app;
  assert.equal(app.appExecutable, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
  const inspect = pid => inspectProcessRecord(pid, { exec: () => { throw Object.assign(Error('x'), { status: 1, stdout: '', stderr: 'Operation not permitted' }); } });
  assert.equal(checkOriginalApp(app, { pid: 10, inspect }), 'unknown');
  assert.equal(diagnoseTrustedApp({ pid: 10, inspect }).reason, 'ps-error:denied');
  assert.equal(checkOriginalApp(app, { pid: 10, inspect: chain({}) }), 'gone');
  assert.equal(diagnoseTrustedApp({ pid: 10, inspect: chain({ 10: { ppid: 1, comm: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT2' } }) }).state, 'not-app');
});
