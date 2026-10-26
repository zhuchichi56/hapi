import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_COMMAND_BYTES = 8 * 1024 * 1024;
export function validateImages(images) {
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.length > 4) throw Error('每条消息最多附加 4 张图片');
  return images.map(image => {
    if (typeof image?.data !== 'string' || image.data.length > 1398200) throw Error('图片过大，请重新选择');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.data);
    if (!match || match[2].length % 4) throw Error('图片格式无效');
    const bytes = Buffer.from(match[2], 'base64');
    const format = match[1];
    const valid = format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : format === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
    if (!valid || bytes.length > 1024 * 1024) throw Error('图片内容无效');
    return { bytes, extension: format === 'jpeg' ? 'jpg' : format };
  });
}
export async function storeImages(images, root = join(homedir(), '.local/state/native-desktop-bridge/attachments')) {
  const decoded = validateImages(images);
  if (!decoded.length) return [];
  await fs.mkdir(root, {recursive:true,mode:0o700});
  return Promise.all(decoded.map(async ({bytes,extension}) => {
    const path = join(root, createHash('sha256').update(bytes).digest('hex') + '.' + extension);
    try { await fs.writeFile(path, bytes, {flag:'wx',mode:0o600}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return path;
  }));
}
export function attachmentText(text, paths = []) {
  return [text, ...paths.map((path,index) => `![图片 ${index + 1}](<${path}>)`)].filter(Boolean).join('\n\n');
}
