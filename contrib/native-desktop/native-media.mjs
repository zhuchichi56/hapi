import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const cache = new Map();
const pending = new Map();
const imageDestination = String.raw`(?:<([^>]+)>|&amp;lt;([\s\S]*?)&amp;gt;|&lt;([\s\S]*?)&gt;|\\<([\s\S]*?)\\>|([^\s)]+))`;
const imageReference = new RegExp(String.raw`!\[[^\]]*\]\(\s*${imageDestination}(?:\s+["'][^)]*["'])?\s*\)`, 'g');

function normalizedImageReference(value) {
  let source = value;
  for (let i = 0; i < 2 && /^%3c[\s\S]*%3e$/i.test(source); i++) {
    try { source = decodeURIComponent(source); } catch { break; }
  }
  return source.replace(/^&amp;lt;([\s\S]+)&amp;gt;$/, '<$1>')
    .replace(/^&lt;([\s\S]+)&gt;$/, '<$1>')
    .replace(/^\\<([\s\S]+)\\>$/, '<$1>')
    .replace(/^<([\s\S]+)>$/, '$1')
    .replace(/\\([<>])/g, '$1');
}
export function imageReferences(text) {
  return [...String(text ?? '').matchAll(imageReference)].map(match => normalizedImageReference(match.slice(1).find(Boolean)));
}
export async function readNativeImage(detail, source, size = 'preview') {
  if (!['preview', 'large'].includes(size)) throw Error('Invalid image size');
  if (typeof source !== 'string' || !isAbsolute(source)) throw Error('图片必须来自这条原始消息');
  const references = [...imageReferences(detail?.item?.text), ...(detail?.item?.images ?? [])]
    .filter(reference => typeof reference === 'string' && isAbsolute(reference));
  // Markdown URL-normalizes Unicode destinations before rendering <img>. Match
  // only an original reference (literal or encoded), then read that exact path.
  // Never decode arbitrary requested paths into additional filesystem access.
  // Prefer a literal reference across the whole message when two filenames are
  // each other's encoded spelling. Markdown also preserves existing %XX escapes.
  const original = references.find(reference => reference === source) ?? references.find(reference => {
    try {
      const encoded = encodeURI(reference);
      return encoded === source || encoded.replace(/%25([\da-f]{2})/gi, '%$1') === source;
    } catch { return false; }
  });
  if (!original) throw Error('图片必须来自这条原始消息');
  source = original;
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) throw Error('本机图片已不存在');
  if (stat.size > 16 * 1024 * 1024) throw Error('图片过大，请在桌面查看');
  const key = `${source}:${stat.mtimeMs}:${stat.size}:${size}`;
  if (cache.has(key)) return cache.get(key);
  if (pending.has(key)) return pending.get(key);
  const job = convertImage(source, stat, size).then(result => {
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  }).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}
async function convertImage(source, stat, size) {
  const handle = await fs.open(source, 'r');
  const magic = Buffer.alloc(12);
  try { await handle.read(magic, 0, 12, 0); } finally { await handle.close(); }
  if (!(magic.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || magic[0] === 255 && magic[1] === 216 && magic[2] === 255 || magic.toString('ascii',0,3) === 'GIF' || magic.toString('ascii',0,4) === 'RIFF' && magic.toString('ascii',8,12) === 'WEBP')) throw Error('暂不支持此图片格式');
  const directory = await fs.mkdtemp(join(tmpdir(), 'native-image-'));
  try {
    const maxEdge = size === 'large' ? 1600 : 320;
    const { stdout } = await execute('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', source], {timeout: 10000, maxBuffer: 16384});
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
    if (!(width > 0 && height > 0)) throw Error('Invalid image dimensions');
    const fits = Math.max(width, height) <= maxEdge;
    // Keep an already-small compressed image; never upscale or recompress it larger.
    const originalMime = magic[0] === 255 ? 'image/jpeg' : magic[0] === 137 ? 'image/png' : null;
    if (fits && originalMime && stat.size <= (size === 'large' ? 640000 : 30000)) {
      const data = await fs.readFile(source);
      return {image: {src: `data:${originalMime};base64,${data.toString('base64')}`}};
    }
    const target = join(directory, 'preview.jpg');
    await execute('/usr/bin/sips', [...(fits ? [] : ['-Z', String(maxEdge)]), '-s', 'format', 'jpeg', '-s', 'formatOptions', size === 'large' ? '80' : '60', source, '--out', target], {timeout: 10000, maxBuffer: 16384});
    const data = await fs.readFile(target);
    if (data.length > (size === 'large' ? 2400000 : 400000)) throw Error('图片预览过大');
    const result = { image: { src: `data:image/jpeg;base64,${data.toString('base64')}` } };
    return result;
  } catch { throw Error('图片预览暂不可用，请在桌面查看'); }
  finally { await fs.rm(directory, {recursive:true,force:true}); }
}
