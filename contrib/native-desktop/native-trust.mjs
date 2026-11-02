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

// CLI mode: exit 0 only when this process has a verified App ancestor. Used by
// native-mcp.pl immediately before it attempts to become the singleton host.
// realpath both sides: macOS /tmp is a symlink to /private/tmp.
if (process.argv[1]) {
  let invokedHere = false;
  try { invokedHere = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])); } catch {}
  if (invokedHere) process.exit(resolveTrustedApp() ? 0 : 1);
}
