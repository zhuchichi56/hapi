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
  const match = /(?:^|[;\n&|])\s*(?:[A-Za-z_]\w*=\S+\s+)*(?:(?:bash|sh|python3?)(?:\s+-[A-Za-z]+)*\s+)?["']?(?:[^\s"'`;|&]+\/)?dsh_(run|steer|status)\.(?:sh|py)(?=["'\s]|$)/.exec(command);
  if (!match && !/(?:^|[;\n&|])\s*dsh\s+--profile\s+headless\b/.test(command)) return undefined;
  const phase = match?.[1] === 'status' ? '检查进度' : match?.[1] === 'steer' ? '续跑 / 纠偏' : '委托调用';
  return { label:'DSH', phase, status: ['running','inProgress','active'].includes(status) ? '调用中' : ['failed','error'].includes(status) ? '调用失败' : '已记录' };
}
