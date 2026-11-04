// One small trust helper shared by the host startup/liveness code and the Perl
// follower's takeover path. It walks the real parent chain to the exact desktop
// App executable; it does not grant App permissions, which the App still enforces.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRUSTED_APP_EXECUTABLE = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
const MAX_ANCESTORS = 64;

export function parseProcessRecord(output) {
  const line = String(output ?? '').split(/\r?\n/).find(value => value.trim());
  const match = line?.match(/^\s*(\d+)\s+(.+?)\s*$/);
  return match ? { ppid: Number(match[1]), comm: match[2] } : null;
}

// `ps -p <pid> -o ppid=,comm=` is the on-device check verified by the planner.
export function readProcessRecord(pid, { ps = '/bin/ps', exec = execFileSync } = {}) {
  try {
    const output = exec(ps, ['-p', String(pid), '-o', 'ppid=,comm='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseProcessRecord(output);
  } catch { return null; }
}

// Like readProcessRecord but keeps the failure kind. `missing` (ps exit 1, no
// output) means the pid is gone: a definite answer. Anything else (spawn error,
// timeout, signal, unparsable output) is `error`: ps itself failed, which says
// nothing about the ancestry and must not be cached as "not an App context".
export function inspectProcessRecord(pid, { ps = '/bin/ps', exec = execFileSync } = {}) {
  try {
    const output = exec(ps, ['-p', String(pid), '-o', 'ppid=,comm='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = parseProcessRecord(output);
    return record ? { status: 'ok', record } : { status: 'error', code: 'unparsable' };
  } catch (error) {
    // A genuinely absent pid is exit 1 with no output at all. Exit 1 with any
    // diagnostic text (e.g. "Operation not permitted" in a sandbox) is a ps failure.
    // stderr is read only for this decision (bounded by maxBuffer) and never reported.
    if (error?.status === 1 && !String(error.stdout ?? '').trim()) {
      const diagnostic = String(error.stderr ?? '').slice(0, 4096);
      if (!diagnostic.trim()) return { status: 'missing' };
      return { status: 'error', code: /not permitted|denied|sandbox/i.test(diagnostic) ? 'denied' : 'exit1-diagnostic' };
    }
    return { status: 'error', code: String(error?.code ?? error?.signal ?? error?.status ?? 'unknown') };
  }
}

// state: trusted | not-app (definite) | transient (could not tell, retry soon).
// reason is a fixed token, never process arguments or environment.
export function diagnoseTrustedApp({ pid = process.pid, appExecutable = TRUSTED_APP_EXECUTABLE, inspect = inspectProcessRecord } = {}) {
  const chain = [];
  const seen = new Set();
  let current = pid;
  while (Number.isInteger(current) && current > 1 && chain.length < MAX_ANCESTORS && !seen.has(current)) {
    seen.add(current);
    const result = inspect(current);
    if (result.status === 'error') return { state: 'transient', reason: `ps-error:${result.code}`, app: null, chain };
    if (result.status === 'missing') return { state: 'not-app', reason: 'process-missing', app: null, chain };
    const { record } = result;
    chain.push({ pid: current, ppid: record.ppid, comm: record.comm });
    if (record.comm === appExecutable) return { state: 'trusted', reason: 'ok', app: { appPid: current, appExecutable, chain }, chain };
    current = record.ppid;
  }
  return { state: 'not-app', reason: 'no-app-ancestor', app: null, chain };
}

// Returns the verified App ancestor plus the chain it was found in, or null.
// A node/codex process is never trusted by name; only the exact App path matches.
export function resolveTrustedApp({ pid = process.pid, appExecutable = TRUSTED_APP_EXECUTABLE, read = readProcessRecord } = {}) {
  const chain = [];
  const seen = new Set();
  let current = pid;
  while (Number.isInteger(current) && current > 1 && chain.length < MAX_ANCESTORS && !seen.has(current)) {
    seen.add(current);
    const record = read(current);
    if (!record) return null;
    chain.push({ pid: current, ppid: record.ppid, comm: record.comm });
    if (record.comm === appExecutable) return { appPid: current, appExecutable, chain };
    current = record.ppid;
  }
  return null;
}

// Host liveness: the original App must still be an ancestor of this process.
// A surviving CLI (unchanged ppid) cannot keep the host alive after App exit.
export function isOriginalAppAlive(app, { pid = process.pid, appExecutable = TRUSTED_APP_EXECUTABLE, read = readProcessRecord } = {}) {
  if (!app || !Number.isInteger(app.appPid) || app.appExecutable !== appExecutable) return false;
  return resolveTrustedApp({ pid, appExecutable, read })?.appPid === app.appPid;
}

// alive | gone | unknown. Only `gone` (App ancestry definitely changed) may stop
// a host; a failed ps is `unknown` and must not terminate a healthy bridge.
export function checkOriginalApp(app, { pid = process.pid, appExecutable = TRUSTED_APP_EXECUTABLE, inspect = inspectProcessRecord } = {}) {
  if (!app || !Number.isInteger(app.appPid) || app.appExecutable !== appExecutable) return 'gone';
  const result = diagnoseTrustedApp({ pid, appExecutable, inspect });
  if (result.state === 'transient') return 'unknown';
  return result.state === 'trusted' && result.app.appPid === app.appPid ? 'alive' : 'gone';
}

export const EXIT_TRUSTED = 0, EXIT_NOT_APP = 1, EXIT_TRANSIENT = 75;

// CLI mode: exit 0 only when this process has a verified App ancestor, 1 for a
// definite non-App context, 75 when ps failed (caller retries). stderr carries
// only the fixed reason token. Used by native-mcp.pl before taking over.
// realpath both sides: macOS /tmp is a symlink to /private/tmp.
if (process.argv[1]) {
  let invokedHere = false;
  try { invokedHere = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])); } catch {}
  if (invokedHere) {
    const result = diagnoseTrustedApp();
    if (result.state !== 'trusted') process.stderr.write(`Desktop bridge trust: ${result.reason}\n`);
    process.exit(result.state === 'trusted' ? EXIT_TRUSTED : result.state === 'transient' ? EXIT_TRANSIENT : EXIT_NOT_APP);
  }
}
