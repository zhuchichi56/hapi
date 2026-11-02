// Tests for the candidate codex-desktop.mjs framing path (no socket, no App).
import assert from 'node:assert/strict';
import { CodexDesktop } from './codex-desktop.mjs';

const MAX_FRAME = 32 * 1024 * 1024;

function frameFor(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function harness() {
  const desktop = new CodexDesktop({});
  const got = [];
  desktop.handle = message => got.push(message);
  return { desktop, got };
}
function feed(desktop, wire, chunkSize) {
  const size = chunkSize ?? wire.length;
  for (let offset = 0; offset < wire.length; offset += size) {
    desktop.receive(wire.subarray(offset, Math.min(wire.length, offset + size)));
  }
}
const one = frameFor({ type: 'response', n: 1 });
const two = frameFor({ type: 'broadcast', n: 2, pad: 'y'.repeat(1000) });
const three = frameFor({ type: 'broadcast', n: 3 });

// 1. header split across reads (1 + 2 + 1 header bytes, then body in odd pieces).
{
  const { desktop, got } = harness();
  const wire = one;
  desktop.receive(wire.subarray(0, 1));
  desktop.receive(wire.subarray(1, 3));
  desktop.receive(wire.subarray(3, 4));
  for (let i = 4; i < wire.length; i += 3) desktop.receive(wire.subarray(i, Math.min(wire.length, i + 3)));
  assert.equal(got.length, 1);
  assert.equal(got[0].n, 1);
  console.log('ok 1 split header');
}

// 2. byte-at-a-time for three frames.
{
  const { desktop, got } = harness();
  feed(desktop, Buffer.concat([one, two, three]), 1);
  assert.deepEqual(got.map(m => m.n), [1, 2, 3]);
  assert.equal(got[1].pad.length, 1000);
  console.log('ok 2 byte chunks');
}

// 3. coalesced frames in a single read, including a trailing partial header.
{
  const { desktop, got } = harness();
  const wire = Buffer.concat([one, two, three]);
  desktop.receive(Buffer.concat([wire, three.subarray(0, 2)]));
  assert.deepEqual(got.map(m => m.n), [1, 2, 3]);
  desktop.receive(three.subarray(2));
  assert.deepEqual(got.map(m => m.n), [1, 2, 3, 3]);
  console.log('ok 3 coalesced frames + split follow-up');
}

// 4. 8 MB frame fragmented at 64 KB (the reported case).
{
  const { desktop, got } = harness();
  const pad = 'x'.repeat(8 * 1024 * 1024 - 32);
  const wire = frameFor({ type: 'snapshot', pad });
  const started = process.hrtime.bigint();
  feed(desktop, wire, 64 * 1024);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(got.length, 1);
  assert.equal(got[0].pad.length, pad.length);
  console.log(`ok 4 8MB fragmented frame (${ms.toFixed(1)} ms incl. JSON.parse)`);
}

// 5. invalid lengths.
{
  const { desktop } = harness();
  const zero = Buffer.alloc(4);
  assert.throws(() => desktop.receive(zero), /Invalid IPC frame length/);
  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(MAX_FRAME + 1);
  assert.throws(() => desktop.receive(huge), /Invalid IPC frame length/);
  console.log('ok 5 invalid length (0 and > MAX_FRAME)');
}

// 6. invalid JSON.
{
  const { desktop } = harness();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(5);
  assert.throws(() => desktop.receive(Buffer.concat([header, Buffer.from('abcde')])), SyntaxError);
  console.log('ok 6 invalid JSON');
}

// 7. valid JSON that is not an object envelope.
{
  const { desktop } = harness();
  assert.throws(() => desktop.receive(frameFor('just-a-string')), /Invalid IPC envelope/);
  assert.throws(() => desktop.receive(frameFor([1, 2, 3])), /Invalid IPC envelope/);
  console.log('ok 7 invalid envelope');
}

// 8. disconnect mid-frame resets header/body, and the next connection parses.
{
  const { desktop, got } = harness();
  const wire = frameFor({ type: 'snapshot', pad: 'z'.repeat(100) });
  desktop.receive(wire.subarray(0, 40)); // header + partial body
  assert.notEqual(desktop.frame, null);
  desktop.socket = { destroy() {} };
  desktop.disconnect(Error('test disconnect'));
  assert.equal(desktop.headerLength, 0);
  assert.equal(desktop.frame, null);
  feed(desktop, one);
  assert.equal(got.length, 1);
  assert.equal(got[0].n, 1);
  console.log('ok 8 disconnect reset');
}

console.log('all receive tests passed');
