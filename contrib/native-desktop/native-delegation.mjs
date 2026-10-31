import { delegationDirectories } from './native-dsh-state.mjs';
// Label observed shell invocations. A launcher exit is not external task completion.
export function delegationRecord(text, output = '', status = '') {
  let command = String(text ?? '');
  if (command.trimStart().startsWith('{')) {
    try {
      const value = JSON.parse(command);
      command = value.command ?? value.cmd ?? '';
      if (!command && typeof value.code === 'string') {
        command = [...value.code.matchAll(/\b(?:cmd|command)\s*:\s*("(?:\\.|[^"\\])*")/g)].flatMap(match => { try { return [JSON.parse(match[1])]; } catch { return []; } }).join('\n');
      }
    } catch { return undefined; }
  }
  const match = /(?:^|[;\n&|])\s*(?:[A-Za-z_]\w*=\S+\s+)*(?:(?:bash|sh|python3?)(?:\s+-[A-Za-z]+)*\s+)?["']?(?:[^\s"'`;|&]+\/)?(dsh_(run|steer|status)\.(?:sh|py)|delegate_run\.sh|codex_run\.(?:sh|py)|antigravity_(?:run\.sh|launch\.py))(?=["'\s]|$)/.exec(command);
  if (!match && !/(?:^|[;\n&|])\s*dsh\s+--profile\s+headless\b/.test(command)) return undefined;
  const phase = match?.[2] === 'status' ? '检查进度' : match?.[2] === 'steer' ? '续跑 / 纠偏' : '委托调用';
  const executor = match?.[1] === 'delegate_run.sh' ? /--executor(?:=|\s+)["']?(dsh|codex|antigravity)(?=["'\s]|$)/.exec(command)?.[1] : match?.[1]?.startsWith('codex_') ? 'codex' : match?.[1]?.startsWith('antigravity_') ? 'antigravity' : 'dsh';
  const label = executor === 'codex' ? 'Codex' : executor === 'antigravity' ? 'Antigravity' : 'DSH';
  const workDirs = delegationDirectories(text);
  return { label, phase, ...(workDirs.length ? { workDirs } : {}), status: ['running','inProgress','active'].includes(status) ? '调用中' : ['failed','error'].includes(status) ? '调用失败' : '已记录' };
}
