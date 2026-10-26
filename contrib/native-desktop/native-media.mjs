import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const cache = new Map();
export function imageReferences(text) {
  return [...String(text ?? '').matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g)].map(match => match[1] ?? match[2]);
}
export async function readNativeImage(detail, source) {
  if (typeof source !== 'string' || !isAbsolute(source) || !imageReferences(detail?.item?.text).includes(source)) throw Error('图片必须来自这条原始消息');
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) throw Error('本机图片已不存在');
  if (stat.size > 16 * 1024 * 1024) throw Error('图片过大，请在桌面查看');
  const key = `${source}:${stat.mtimeMs}:${stat.size}`;
  if (cache.has(key)) return cache.get(key);
  const handle = await fs.open(source, 'r');
  const magic = Buffer.alloc(12);
  try { await handle.read(magic, 0, 12, 0); } finally { await handle.close(); }
  if (!(magic.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || magic[0] === 255 && magic[1] === 216 && magic[2] === 255 || magic.toString('ascii',0,3) === 'GIF' || magic.toString('ascii',0,4) === 'RIFF' && magic.toString('ascii',8,12) === 'WEBP')) throw Error('暂不支持此图片格式');
  const directory = await fs.mkdtemp(join(tmpdir(), 'native-image-'));
  try {
    const target = join(directory, 'preview.jpg');
    await execute('/usr/bin/sips', ['-Z', '480', '-s', 'format', 'jpeg', '-s', 'formatOptions', '65', source, '--out', target], {timeout: 10000, maxBuffer: 16384});
    const data = await fs.readFile(target);
    if (data.length > 400000) throw Error('图片预览过大');
    const result = { image: { src: `data:image/jpeg;base64,${data.toString('base64')}` } };
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  } catch { throw Error('图片预览暂不可用，请在桌面查看'); }
  finally { await fs.rm(directory, {recursive:true,force:true}); }
}
