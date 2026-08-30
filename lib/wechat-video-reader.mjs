import Database from 'better-sqlite3';
import { createDecipheriv, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import {
  readWeChatReaderConfig,
  resolveWeChatMessageResourceMd5s,
} from './wechat-image-reader.mjs';

const PAGE_SIZE = 4096;
const SQLCIPHER_RESERVE_BYTES = 80;
const SQLCIPHER_SALT_BYTES = 16;
const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const MAX_HARDLINK_DB_BYTES = 64 * 1024 * 1024;
const MAX_HARDLINK_WAL_BYTES = 128 * 1024 * 1024;
const MAX_HARDLINK_ROWS = 100_000;
const MAX_PRIVATE_JSON_BYTES = 4 * 1024 * 1024;
const RESOURCE_MD5 = /^[0-9a-f]{32}$/i;
const VIDEO_FILENAME = /^[0-9a-f]{32}\.(?:mp4|mov)$/i;
const MONTH_DIRECTORY = /^\d{4}-\d{2}$/;

export function extractWeChatVideoFromCache({
  chat,
  localId,
  createTime,
  outputPath,
  maxBytes,
  wxCliDir,
  dbDir,
}) {
  if (
    typeof chat !== 'string' ||
    chat.length === 0 ||
    !Number.isSafeInteger(localId) ||
    !Number.isSafeInteger(createTime) ||
    createTime <= 0 ||
    typeof outputPath !== 'string' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new WeChatVideoFailure('MEDIA_REFERENCE_INVALID');
  }

  const reader = readWeChatReaderConfig({ wxCliDir, dbDir });
  const resourceMd5s = resolveWeChatMessageResourceMd5s({
    cliRoot: reader.cliRoot,
    chat,
    localId,
    createTime,
    localType: 43,
  });
  if (resourceMd5s.length === 0) {
    throw new WeChatVideoFailure('WECHAT_VIDEO_REFERENCE_NOT_FOUND');
  }

  const databaseRoot = realpathOwnedDirectory(reader.dbDir);
  const accountRoot = realpathOwnedDirectory(dirname(databaseRoot));
  const videoRoot = realpathOwnedDirectory(join(accountRoot, 'msg', 'video'));
  const keyPath = join(reader.cliRoot, 'all_keys.json');
  const keyMap = readPrivateJson(keyPath, reader.cliRoot, 'WECHAT_VIDEO_INDEX_KEY_UNAVAILABLE');
  const keyHex = keyMap?.['hardlink/hardlink.db']?.enc_key;
  if (typeof keyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new WeChatVideoFailure('WECHAT_VIDEO_INDEX_KEY_UNAVAILABLE');
  }

  const hardlinkRoot = realpathOwnedDirectory(join(databaseRoot, 'hardlink'));
  const databasePath = join(hardlinkRoot, 'hardlink.db');
  const walPath = `${databasePath}-wal`;
  const key = Buffer.from(keyHex, 'hex');
  const temporaryIndexPath = join(
    dirname(resolve(outputPath)),
    `.wechat-video-index-${randomUUID()}.db`,
  );
  let index;
  try {
    const encryptedDatabase = readBoundedOwnedFile(
      databasePath,
      hardlinkRoot,
      MAX_HARDLINK_DB_BYTES,
      'WECHAT_VIDEO_INDEX_UNAVAILABLE',
    );
    const encryptedWal = existsSync(walPath)
      ? readBoundedOwnedFile(
          walPath,
          hardlinkRoot,
          MAX_HARDLINK_WAL_BYTES,
          'WECHAT_VIDEO_INDEX_UNAVAILABLE',
        )
      : null;
    const decrypted = decryptSqlCipherDatabaseSnapshot(encryptedDatabase, encryptedWal, key);
    writePrivateExclusive(temporaryIndexPath, decrypted);
    index = new Database(temporaryIndexPath, { readonly: true, fileMustExist: true });
    const rows = index
      .prepare(
        `SELECT v.md5, v.file_name, v.file_size, v.modify_time, d.username AS directory
         FROM video_hardlink_info_v4 v
         JOIN dir2id d ON d.rowid = v.dir1
         LIMIT ?`,
      )
      .all(MAX_HARDLINK_ROWS + 1);
    if (rows.length > MAX_HARDLINK_ROWS) {
      throw new WeChatVideoFailure('WECHAT_VIDEO_INDEX_LIMIT_EXCEEDED');
    }
    const sourcePath = selectVideoSource(rows, resourceMd5s, videoRoot);
    copyValidatedVideo(sourcePath, outputPath, videoRoot, maxBytes);
    return { path: outputPath, format: 'mp4' };
  } catch (error) {
    if (error instanceof WeChatVideoFailure) throw error;
    throw new WeChatVideoFailure('WECHAT_VIDEO_INDEX_UNAVAILABLE');
  } finally {
    index?.close();
    key.fill(0);
    if (existsSync(temporaryIndexPath)) unlinkSync(temporaryIndexPath);
  }
}

export function decryptSqlCipherDatabaseSnapshot(encryptedDatabase, encryptedWal, key) {
  const source = Buffer.from(encryptedDatabase);
  if (
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    source.length === 0 ||
    source.length % PAGE_SIZE !== 0
  ) {
    throw new WeChatVideoFailure('WECHAT_VIDEO_INDEX_UNAVAILABLE');
  }
  const pages = [];
  for (let offset = 0, pageNumber = 1; offset < source.length; offset += PAGE_SIZE, pageNumber++) {
    pages.push(decryptSqlCipherPage(source.subarray(offset, offset + PAGE_SIZE), key, pageNumber === 1));
  }
  if (encryptedWal) applyEncryptedWal(pages, Buffer.from(encryptedWal), key);
  const result = Buffer.concat(pages);
  if (!result.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw new WeChatVideoFailure('WECHAT_VIDEO_INDEX_UNAVAILABLE');
  }
  return result;
}

export function selectVideoSource(rows, resourceMd5s, videoRoot) {
  const resolvedVideoRoot = realpathSync(videoRoot);
  const fingerprints = new Set(
    resourceMd5s
      .filter((value) => typeof value === 'string' && RESOURCE_MD5.test(value))
      .map((value) => value.toLowerCase()),
  );
  if (fingerprints.size === 0) {
    throw new WeChatVideoFailure('WECHAT_VIDEO_REFERENCE_NOT_FOUND');
  }

  const matches = new Set();
  for (const row of rows) {
    const fileName = String(row?.file_name ?? '');
    const directory = String(row?.directory ?? '');
    if (!VIDEO_FILENAME.test(fileName) || !MONTH_DIRECTORY.test(directory)) continue;
    const fileStem = basename(fileName, extname(fileName)).toLowerCase();
    const indexedMd5 = String(row?.md5 ?? '').toLowerCase();
    if (!fingerprints.has(fileStem) && !fingerprints.has(indexedMd5)) continue;
    const candidate = join(resolvedVideoRoot, directory, fileName);
    if (!existsSync(candidate)) continue;
    const linked = lstatSync(candidate);
    if (!linked.isFile() || linked.isSymbolicLink()) continue;
    const resolved = realpathSync(candidate);
    assertWithin(resolved, resolvedVideoRoot);
    matches.add(resolved);
  }
  if (matches.size === 0) throw new WeChatVideoFailure('MEDIA_SOURCE_NOT_FOUND');
  if (matches.size !== 1) throw new WeChatVideoFailure('WECHAT_VIDEO_SOURCE_AMBIGUOUS');
  return [...matches][0];
}

function decryptSqlCipherPage(page, key, firstPage) {
  if (page.length !== PAGE_SIZE) throw new WeChatVideoFailure('WECHAT_VIDEO_INDEX_UNAVAILABLE');
  const ivOffset = PAGE_SIZE - SQLCIPHER_RESERVE_BYTES;
  const iv = page.subarray(ivOffset, ivOffset + 16);
  const start = firstPage ? SQLCIPHER_SALT_BYTES : 0;
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let decrypted;
  try {
    decrypted = Buffer.concat([
      decipher.update(page.subarray(start, PAGE_SIZE - SQLCIPHER_RESERVE_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new WeChatVideoFailure('WECHAT_VIDEO_INDEX_UNAVAILABLE');
  }
  const output = Buffer.alloc(PAGE_SIZE);
  if (firstPage) SQLITE_HEADER.copy(output);
  decrypted.copy(output, start);
  return output;
}

function applyEncryptedWal(pages, wal, key) {
  if (wal.length <= WAL_HEADER_BYTES) return;
  const magic = wal.readUInt32BE(0);
  if ((magic !== 0x377f0682 && magic !== 0x377f0683) || wal.readUInt32BE(8) !== PAGE_SIZE) {
    return;
  }
  const frameBytes = WAL_FRAME_HEADER_BYTES + PAGE_SIZE;
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  const frames = [];
  let committedFrames = 0;
  let committedPageCount = pages.length;
  for (
    let offset = WAL_HEADER_BYTES;
    offset + frameBytes <= wal.length;
    offset += frameBytes
  ) {
    const pageNumber = wal.readUInt32BE(offset);
    if (
      pageNumber === 0 ||
      pageNumber > 1_000_000 ||
      wal.readUInt32BE(offset + 8) !== salt1 ||
      wal.readUInt32BE(offset + 12) !== salt2
    ) {
      break;
    }
    const pageCount = wal.readUInt32BE(offset + 4);
    frames.push({ offset, pageNumber });
    if (pageCount > 0 && pageCount <= 1_000_000) {
      committedFrames = frames.length;
      committedPageCount = pageCount;
    }
  }
  if (committedFrames === 0) return;
  for (const { offset, pageNumber } of frames.slice(0, committedFrames)) {
    while (pages.length < pageNumber) pages.push(Buffer.alloc(PAGE_SIZE));
    const encryptedPage = wal.subarray(
      offset + WAL_FRAME_HEADER_BYTES,
      offset + WAL_FRAME_HEADER_BYTES + PAGE_SIZE,
    );
    pages[pageNumber - 1] = decryptSqlCipherPage(encryptedPage, key, false);
  }
  while (pages.length < committedPageCount) pages.push(Buffer.alloc(PAGE_SIZE));
  pages.length = committedPageCount;
}

function copyValidatedVideo(sourcePath, outputPath, videoRoot, maxBytes) {
  const sourceLinked = lstatSync(sourcePath);
  if (
    !sourceLinked.isFile() ||
    sourceLinked.isSymbolicLink() ||
    sourceLinked.uid !== process.getuid()
  ) {
    throw new WeChatVideoFailure('MEDIA_PATH_INVALID');
  }
  const resolvedSource = realpathSync(sourcePath);
  assertWithin(resolvedSource, videoRoot);
  const source = openSync(resolvedSource, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination;
  try {
    const stat = fstatSync(source);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size <= 0) {
      throw new WeChatVideoFailure('MEDIA_SOURCE_NOT_FOUND');
    }
    if (stat.size > maxBytes) throw new WeChatVideoFailure('MEDIA_TOO_LARGE');
    const header = Buffer.alloc(32);
    const headerBytes = readSync(source, header, 0, header.length, 0);
    if (!isSupportedMp4(header.subarray(0, headerBytes))) {
      throw new WeChatVideoFailure('MEDIA_TYPE_UNSUPPORTED');
    }
    destination = openSync(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const chunk = Buffer.alloc(256 * 1024);
    let position = 0;
    while (position < stat.size) {
      const count = readSync(source, chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (count <= 0) throw new WeChatVideoFailure('MEDIA_SOURCE_NOT_FOUND');
      let written = 0;
      while (written < count) {
        written += writeSync(destination, chunk, written, count - written);
      }
      position += count;
    }
    fchmodSync(destination, 0o600);
  } catch (error) {
    if (destination !== undefined) closeSync(destination);
    destination = undefined;
    if (existsSync(outputPath)) unlinkSync(outputPath);
    throw error;
  } finally {
    closeSync(source);
    if (destination !== undefined) closeSync(destination);
  }
}

function isSupportedMp4(header) {
  if (header.length < 12 || header.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
  return /^(?:iso.|mp4.|avc1|M4V |qt  |dash|MSNV|3g..)$/.test(
    header.subarray(8, 12).toString('ascii'),
  );
}

function readPrivateJson(path, root, errorCode) {
  const resolved = resolve(path);
  assertWithin(resolved, resolve(root));
  let descriptor;
  try {
    descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size <= 0 ||
      stat.size > MAX_PRIVATE_JSON_BYTES
    ) {
      throw new WeChatVideoFailure(errorCode);
    }
    return JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch {
    throw new WeChatVideoFailure(errorCode);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readBoundedOwnedFile(path, root, maxBytes, errorCode) {
  const linked = lstatSync(path);
  if (!linked.isFile() || linked.isSymbolicLink() || linked.uid !== process.getuid()) {
    throw new WeChatVideoFailure(errorCode);
  }
  const resolved = realpathSync(path);
  assertWithin(resolved, root);
  const descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.size <= 0 ||
      stat.size > maxBytes
    ) {
      throw new WeChatVideoFailure(errorCode);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateExclusive(path, bytes) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

function realpathOwnedDirectory(path) {
  const linked = lstatSync(path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || linked.uid !== process.getuid()) {
    throw new WeChatVideoFailure('MEDIA_PATH_INVALID');
  }
  const resolved = realpathSync(path);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw new WeChatVideoFailure('MEDIA_PATH_INVALID');
  }
  return resolved;
}

function assertWithin(path, root) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) {
    throw new WeChatVideoFailure('MEDIA_PATH_INVALID');
  }
}

export class WeChatVideoFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
