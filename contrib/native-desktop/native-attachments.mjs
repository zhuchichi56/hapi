import { createReadStream, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_COMMAND_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 512 * 1024;
export const CHUNK_STALE_MS = 60 * 60 * 1000;
export const MAX_ATTACHMENTS = 4;
const ATTACHMENT_ROOT = join(homedir(), '.local/state/native-desktop-bridge/attachments');
const ZIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const activeChunks = new Set();
const LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_EOCD = Buffer.from([0x50, 0x4b, 0x06, 0x06]);
const ZIP64_LOCATOR = Buffer.from([0x50, 0x4b, 0x06, 0x07]);
const EOCD_TAIL_BYTES = 65557;

export function zipDirectory(root = ATTACHMENT_ROOT) {
  return join(root, 'zips');
}

function attachmentError(message, status) {
  const error = Error(message);
  error.status = status;
  return error;
}

export function safeZipName(raw) {
  if (typeof raw !== 'string') throw attachmentError('附件文件名无效', 400);
  const name = raw.normalize('NFC').trim();
  if (!name || name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(name)) throw attachmentError('附件文件名无效', 400);
  if (!/\.zip$/i.test(name) || name.toLowerCase() === '.zip') throw attachmentError('仅支持 .zip 附件', 400);
  return name;
}

export function validateZipSignatureParts(start, size, tail) {
  if (!Buffer.isBuffer(start) || !Buffer.isBuffer(tail) || size < 22 || start.length < 4) return false;
  const eocd = tail.indexOf(EOCD);
  const zip64Record = tail.indexOf(ZIP64_EOCD);
  const zip64Locator = tail.indexOf(ZIP64_LOCATOR);
  const zip64 = zip64Record >= 0 && zip64Locator > zip64Record;
  if (start.equals(LOCAL_HEADER)) return eocd >= 0 || zip64;
  if (start.equals(EOCD)) return eocd >= 0;
  if (start.equals(ZIP64_EOCD)) return zip64Record === 0 && zip64;
  if (start.equals(ZIP64_LOCATOR)) return zip64;
  return false;
}

export function validateZipSignature(bytes) {
  if (!Buffer.isBuffer(bytes)) return false;
  return validateZipSignatureParts(bytes.subarray(0, 4), bytes.length, bytes.subarray(Math.max(0, bytes.length - EOCD_TAIL_BYTES)));
}

export function formatAttachmentSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function zipAttachmentText({ name, size, path }) {
  return `[ZIP 附件] ${name}\n大小：${formatAttachmentSize(size)}\n本机路径：${path}`;
}

export function validateAttachmentIds(ids) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) throw attachmentError('每条消息最多附加 4 个 ZIP 文件', 400);
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !ZIP_ID.test(id) || seen.has(id)) throw attachmentError('附件标识无效', 400);
    seen.add(id);
  }
  return ids;
}

// Streams directly to a private temporary file, enforcing the limit before a
// byte beyond MAX_ATTACHMENT_BYTES can be accepted. A failed or aborted request
// never leaves a partial file or metadata behind.
export async function receiveZipUpload(stream, rawName, root = ATTACHMENT_ROOT) {
  const name = safeZipName(rawName);
  const directory = zipDirectory(root);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const id = randomUUID();
  const temporary = join(directory, `${id}.part`);
  const target = join(directory, `${id}.zip`);
  let handle, closed = false, committed = false, size = 0;
  let start = Buffer.alloc(0), tail = Buffer.alloc(0);
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.chmod(0o600);
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!bytes.length) continue;
      size += bytes.length;
      if (size > MAX_ATTACHMENT_BYTES) throw attachmentError('单个 ZIP 附件不能超过 20 MiB', 413);
      if (start.length < 4) start = Buffer.concat([start, bytes.subarray(0, 4 - start.length)]);
      const combined = Buffer.concat([tail, bytes]);
      tail = combined.length > EOCD_TAIL_BYTES ? combined.subarray(combined.length - EOCD_TAIL_BYTES) : combined;
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw attachmentError('附件写入失败，请重试', 500);
        offset += bytesWritten;
      }
    }
    if (!size) throw attachmentError('ZIP 文件为空', 400);
    if (!validateZipSignatureParts(start, size, tail)) throw attachmentError('ZIP 文件格式无效', 400);
    await handle.sync();
    await handle.close();
    closed = true;
    await fs.rename(temporary, target);
    const metadata = { id, name, size, createdAt: new Date().toISOString() };
    const metadataTemporary = join(directory, `${id}.json.part`);
    try {
      await fs.writeFile(metadataTemporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      await fs.chmod(metadataTemporary, 0o600).catch(() => {});
      await fs.rename(metadataTemporary, join(directory, `${id}.json`));
    } catch {
      await fs.unlink(target).catch(() => {});
      await fs.unlink(metadataTemporary).catch(() => {});
      throw attachmentError('附件保存失败，请重试', 500);
    }
    committed = true;
    return { id, name, size, path: target, canonicalText: zipAttachmentText({ name, size, path: target }) };
  } finally {
    if (handle && !closed) await handle.close().catch(() => {});
    if (!committed) await fs.unlink(temporary).catch(() => {});
  }
}

// Sequential private chunks keep each public request small. Finalization reuses
// the same ZIP validation and atomic storage as direct uploads.
export async function receiveZipChunk(stream, rawName, options, root = ATTACHMENT_ROOT) {
  const name = safeZipName(rawName);
  const total = Number(options.total), offset = Number(options.offset);
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_ATTACHMENT_BYTES)
    throw attachmentError('单个 ZIP 附件不能超过 20 MiB', total > MAX_ATTACHMENT_BYTES ? 413 : 400);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= total) throw attachmentError('附件分块位置无效', 400);
  const suppliedId = options.uploadId;
  if (suppliedId !== undefined && (typeof suppliedId !== 'string' || !ZIP_ID.test(suppliedId))) throw attachmentError('附件上传标识无效', 400);
  if (!suppliedId && offset !== 0) throw attachmentError('附件必须从第一块开始上传', 400);
  const directory = zipDirectory(root);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  if (!suppliedId) {
    for (const entry of await fs.readdir(directory)) {
      if (!entry.endsWith('.chunk.json') || !ZIP_ID.test(entry.slice(0, -11))) continue;
      const staleId = entry.slice(0, -11);
      if (activeChunks.has(join(directory, staleId))) continue;
      const path = join(directory, entry);
      const stat = await fs.stat(path).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > CHUNK_STALE_MS) {
        await fs.unlink(join(directory, staleId + '.chunk')).catch(() => {});
        await fs.unlink(path).catch(() => {});
      }
    }
  }
  const uploadId = suppliedId ?? randomUUID(), key = join(directory, uploadId);
  if (activeChunks.has(key)) throw attachmentError('附件正在上传，请稍后重试', 400);
  activeChunks.add(key);
  const partial = key + '.chunk', metadata = key + '.chunk.json';
  let handle, validated = false;
  try {
    if (suppliedId) {
      const state = await fs.readFile(metadata, 'utf8').then(JSON.parse).catch(() => null);
      const stat = await fs.stat(partial).catch(() => null);
      if (!state || state.name !== name || state.total !== total || state.offset !== offset || !stat?.isFile() || stat.size !== offset)
        throw attachmentError('附件分块顺序无效，请重新上传', 400);
    }
    validated = true;
    handle = await fs.open(partial, suppliedId ? 'a' : 'wx', 0o600);
    await handle.chmod(0o600);
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_CHUNK_BYTES || offset + size > total) throw attachmentError('附件分块过大', 413);
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written);
        if (!result.bytesWritten) throw attachmentError('附件写入失败，请重试', 500);
        written += result.bytesWritten;
      }
    }
    if (!size) throw attachmentError('附件分块为空', 400);
    await handle.close(); handle = null;
    const next = offset + size;
    if (next === total) {
      const result = await receiveZipUpload(createReadStream(partial), name, root);
      await fs.unlink(partial);
      await fs.unlink(metadata).catch(() => {});
      return { ...result, complete: true };
    }
    await fs.writeFile(metadata, JSON.stringify({ name, total, offset: next }), { mode: 0o600 });
    return { uploadId, offset: next, complete: false };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (validated) {
      await fs.unlink(partial).catch(() => {});
      await fs.unlink(metadata).catch(() => {});
    }
    throw error;
  } finally { activeChunks.delete(key); }
}

export async function resolveZipAttachments(ids, root = ATTACHMENT_ROOT) {
  const list = validateAttachmentIds(ids);
  const directory = zipDirectory(root);
  return Promise.all(list.map(async id => {
    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(join(directory, `${id}.json`), 'utf8'));
    } catch {
      throw attachmentError('附件不存在或已过期，请重新上传', 400);
    }
    if (metadata?.id !== id || typeof metadata.name !== 'string'
      || !Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > MAX_ATTACHMENT_BYTES)
      throw attachmentError('附件不存在或已过期，请重新上传', 400);
    const name = safeZipName(metadata.name);
    const path = join(directory, `${id}.zip`);
    const stat = await fs.stat(path).catch(() => null);
    if (!stat?.isFile() || stat.size !== metadata.size) throw attachmentError('附件不存在或已过期，请重新上传', 400);
    return { id, name, size: metadata.size, path, canonicalText: zipAttachmentText({ name, size: metadata.size, path }) };
  }));
}

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
export function attachmentText(text, paths = [], zips = []) {
  return [text, ...paths.map((path,index) => `![图片 ${index + 1}](<${path}>)`), ...zips.map(zip => zip.canonicalText ?? zipAttachmentText(zip))].filter(Boolean).join('\n\n');
}
