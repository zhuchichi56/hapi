import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
const unquote = value => value.replace(/["']/g, '');
export function delegationDirectories(input, cwd = '') {
  let text = String(input ?? '');
  if (text.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(text); cwd = data.workdir ?? data.cwd ?? cwd;
      text = data.command ?? data.cmd ?? (typeof data.code === 'string' ? [...data.code.matchAll(/\b(?:cmd|command)["']?\s*:\s*("(?:\\.|[^"\\])*")/g)].flatMap(m => { try { return [JSON.parse(m[1])]; } catch { return []; } }).join('\n') : '');
    } catch { return []; }
  }
  if (typeof cwd !== 'string') cwd = '';
  const tokens = (text.match(/&&|\|\||[;\n|&]|(?:[^\s"';|&]+|"[^"]*"|'[^']*')+/g) ?? []).map(unquote);
  const result = [];
  for (let index = 0; index < tokens.length; index++) {
    const kind = /^dsh_(run\.sh|steer\.sh|status\.py)$/.exec(basename(tokens[index]))?.[1];
    if (!kind) continue;
    const args = [];
    for (let i = index + 1; i < tokens.length && !/^(?:&&|\|\||[;|&\n])$/.test(tokens[i]); i++) {
      const arg = tokens[i];
      if (['--detach','--clear-task-context','-I'].includes(arg)) continue;
      if (['--skill','--skill-dir','--context-file','--tail','--flag','--stall-min'].includes(arg)) { i++; continue; }
      if (/^\d*[<>]/.test(arg)) break;
      if (arg.startsWith('-')) { args.length = 0; break; }
      args.push(arg);
    }
    const dirs = kind === 'run.sh' ? args.slice(1, 2) : kind === 'steer.sh' ? args.slice(0, 1) : args;
    for (let path of dirs) {
      if (!path || /[$`\\\n]/.test(path)) continue;
      if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
      if (!path.startsWith('/') && !cwd) continue;
      result.push(resolve(cwd || '/', path));
    }
  }
  return [...new Set(result)];
}
let processSnapshot;
async function runningDirectories() {
  if (processSnapshot && Date.now() - processSnapshot.at < 1500) return processSnapshot.value;
  const pending = (async () => {
    const { stdout } = await execute('/bin/ps', ['-axo','pid=,stat=,command='], { timeout: 1800, maxBuffer: 4 * 1024 * 1024 });
    const pids = stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      return match && !match[2].includes('Z') && (/\bdsh_run\.sh(?:\s|$)/.test(match[3]) || /(?:^|[ /])dsh\s+.*--profile\s+headless\b/.test(match[3])) && !/\s(?:-c|--command)\s/.test(match[3]) ? [match[1]] : [];
    });
    if (!pids.length) return new Set();
    const { stdout: directories } = await execute('/usr/sbin/lsof', ['-a','-p',pids.join(','),'-d','cwd','-Fn'], { timeout: 1800, maxBuffer: 128 * 1024 });
    return new Set(directories.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1)));
  })().catch(() => null);
  processSnapshot = { at: Date.now(), value: pending };
  return pending;
}
const stateCache = new Map();
async function inspectDirectory(path) {
  const existing = stateCache.get(path);
  if (existing && Date.now() - existing.at < 1500) return existing.value;
  const value = (async () => {
    const real = await fs.realpath(path).catch(() => null);
    if (!real) return 'unknown';
    const running = await runningDirectories();
    if (running === null) return 'unknown';
    if (running.has(real)) return 'running';
    if (await fs.stat(join(real,'DSH_BLOCKED.json')).catch(() => null)) return 'blocked';
    if (await fs.stat(join(real,'DONE')).catch(() => null)) return 'completed';
    if (await fs.stat(join(real,'dispatch.log')).catch(() => null)) return 'stopped';
    return 'unknown';
  })();
  if (stateCache.size > 128) stateCache.delete(stateCache.keys().next().value);
  stateCache.set(path, { at: Date.now(), value });
  return value;
}
export async function attachDelegationState(view, inspect = inspectDirectory) {
  const associations = new Map();
  for (const turn of view.turns ?? []) for (const item of turn.items) {
    if (!item.delegation) continue;
    const dirs = [...new Set([...(item.delegation.workDirs ?? []), ...delegationDirectories(item.output ?? '', view.cwd), ...delegationDirectories(item.text, view.cwd)])];
    if (dirs.length) associations.set(item, dirs);
  }
  const allPaths = [...new Set([...associations.values()].flat())];
  const live = inspect === inspectDirectory && allPaths.length > 64 ? await runningDirectories() : null;
  const livePaths = live ? allPaths.filter(path => live.has(path) || live.has(path.replace(/^\/tmp(?=\/)/, '/private/tmp').replace(/^\/var(?=\/)/, '/private/var'))) : [];
  const paths = [...new Set([...livePaths, ...allPaths.slice(-64)])];
  if (!paths.length) return view;
  const tasks = await Promise.all(paths.map(async path => ({ id: createHash('sha256').update(path).digest('hex').slice(0,16), title: basename(path), state: await inspect(path), path })));
  let number = 0;
  for (const task of tasks) if (task.state === 'running') task.number = ++number;
  const byPath = new Map(tasks.map(task => [task.path, task]));
  return { ...view, delegations: { running: number, tasks: tasks.map(({path,...task}) => task) }, turns: view.turns.map(turn => ({ ...turn, items: turn.items.map(item => {
    if (!associations.has(item)) return item;
    const associated = associations.get(item).map(path => byPath.get(path)).filter(Boolean);
    const numbers = associated.flatMap(task => task.number ? [task.number] : []);
    const state = numbers.length ? 'running' : associated.length && associated.every(task => task.state === 'completed') ? 'completed' : 'unknown';
    const { workDirs, ...delegation } = item.delegation;
    return { ...item, delegation: { ...delegation, numbers, state } };
  }) })) };
}
