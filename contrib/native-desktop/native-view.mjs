import { createHash } from 'node:crypto';

const keyFor = (turn, item, index) => Buffer.from(JSON.stringify([turn.id, item.id, index])).toString('base64url');
export function presentHistory(view, command = {}) {
  const all = view.turns.flatMap(turn => turn.items.map((item, index) => ({ turn, item, key: keyFor(turn, item, index) })));
  if (command.itemKey) {
    const entry = all.find(entry => entry.key === command.itemKey);
    if (!entry) throw Error('这条记录已变化，请重新打开会话');
    const item = entry.item;
    const output = String(item.output ?? '');
    const offset = Math.max(0, Math.min(output.length, Number(command.outputOffset) || 0));
    return { item: { ...item, key: entry.key, output: output.slice(offset, offset + 64000),
      outputOffset: offset, outputLength: output.length, outputMore: offset + 64000 < output.length } };
  }
  let end = all.length;
  if (command.before) {
    end = all.findIndex(entry => entry.key === command.before);
    if (end < 0) throw Error('历史位置已变化，请重新打开会话');
  }
  const size = Math.max(10, Math.min(120, Number(command.pageSize) || 80));
  let start = end, bytes = 0;
  const entries = [];
  for (let index = end - 1; index >= Math.max(0, end - size); index--) {
    const entry = all[index];
    const { output, ...item } = entry.item;
    const textLimit = item.role === 'tool' ? 140 : 24000;
    const text = String(item.text ?? '');
    const compact = { ...item, key: entry.key, text: text.slice(0, textLimit),
      ...(item.role === 'tool' || text.length > textLimit ? { hasDetail: true, outputLength: String(output ?? '').length, textTruncated: text.length > textLimit } : {}) };
    const length = Buffer.byteLength(JSON.stringify(compact));
    if (entries.length && bytes + length > 64000) break;
    entries.unshift({ ...entry, compact }); bytes += length; start = index;
  }
  const turns = [];
  for (const entry of entries) {
    let turn = turns.at(-1);
    if (turn?.id !== entry.turn.id) { turn = { id: entry.turn.id, status: entry.turn.status, items: [] }; turns.push(turn); }
    turn.items.push(entry.compact);
  }
  const result = { ...view, turns, hasEarlier: start > 0 || !view.historyComplete,
    before: start < all.length ? all[start]?.key ?? null : null,
    windowStart: start, totalItems: all.length };
  const revision = createHash('sha256').update(JSON.stringify(result)).digest('base64url').slice(0, 24);
  if (!command.before && command.since === revision) return { id: view.id, revision, unchanged: true };
  return { ...result, revision };
}
