// Benchmark the real receive() parser: original snapshot vs candidate.
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw Error('Usage: node bench-receive.mjs /absolute/path/to/baseline-codex-desktop.mjs');
const { CodexDesktop: Original } = await import(pathToFileURL(process.argv[2]).href);
import { CodexDesktop as Candidate } from './codex-desktop.mjs';

const CHUNK = 64 * 1024;
const SIZE = 8 * 1024 * 1024;
const body = Buffer.from(JSON.stringify({ type: 'snapshot', pad: 'x'.repeat(SIZE - 40) }));
const header = Buffer.alloc(4);
header.writeUInt32LE(body.length);
const wire = Buffer.concat([header, body]);

function run(Desktop) {
  const desktop = new Desktop({});
  let handled = 0;
  desktop.handle = () => { handled += 1; };
  const started = process.hrtime.bigint();
  for (let offset = 0; offset < wire.length; offset += CHUNK) {
    desktop.receive(wire.subarray(offset, Math.min(wire.length, offset + CHUNK)));
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (handled !== 1) throw Error(`frame not parsed (${handled})`);
  return ms;
}
function parseOnly() {
  const started = process.hrtime.bigint();
  JSON.parse(body.toString('utf8'));
  return Number(process.hrtime.bigint() - started) / 1e6;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const chunks = Math.ceil(wire.length / CHUNK);
// Bytes the original code copies: 1 chunk, 2 chunks, ... chunks (Buffer.concat each read).
let originalCopied = 0;
for (let i = 1; i <= chunks; i += 1) originalCopied += Math.min(i * CHUNK, wire.length);
const candidateCopied = wire.length;

run(Original); run(Candidate); parseOnly(); // warm-up

const originalRuns = [];
const candidateRuns = [];
const parseRuns = [];
for (let i = 0; i < 5; i += 1) {
  originalRuns.push(run(Original));
  candidateRuns.push(run(Candidate));
  parseRuns.push(parseOnly());
}

const report = {
  frame_bytes: wire.length,
  chunks,
  original_ms_median: Number(median(originalRuns).toFixed(2)),
  candidate_ms_median: Number(median(candidateRuns).toFixed(2)),
  json_parse_ms_median: Number(median(parseRuns).toFixed(2)),
  original_copied_bytes: originalCopied,
  candidate_copied_bytes: candidateCopied,
  original_runs_ms: originalRuns.map(v => Number(v.toFixed(2))),
  candidate_runs_ms: candidateRuns.map(v => Number(v.toFixed(2))),
};
console.log(JSON.stringify(report, null, 2));
