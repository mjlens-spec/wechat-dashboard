import Database from 'better-sqlite3';
import { createDecipheriv, createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);
const V1_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]);
const V1_AES_KEY = Buffer.from('cfcd208495d565ef', 'ascii');
const HEADER_SIZE = 15;
const CACHE_FILE = /^[0-9a-f]{32}\.db$/i;
const RESOURCE_MD5 = /^[0-9a-f]{32}$/i;
const MAX_PRIVATE_JSON_BYTES = 4 * 1024 * 1024;
const imageKeyCache = new Map();

export function extractWeChatImageFromCache({
  chat,
  localId,
  createTime,
  outputPath,
  maxBytes,
  wxCliDir = join(homedir(), '.wx-cli'),
  dbDir,
  kvcommDir,
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
    throw new WeChatImageFailure('MEDIA_REFERENCE_INVALID');
  }

  const { cliRoot, dbDir: configuredDbDir } = readWeChatReaderConfig({ wxCliDir, dbDir });

  const resourceMd5s = resolveWeChatMessageResourceMd5s({
    cliRoot,
    chat,
    localId,
    createTime,
    localType: 3,
  });
  if (resourceMd5s.length === 0) {
    throw new WeChatImageFailure('WECHAT_IMAGE_REFERENCE_NOT_FOUND');
  }

  const accountRoot = realpathDirectory(dirname(configuredDbDir));
  const attachRoot = realpathDirectory(join(accountRoot, 'msg', 'attach'));
  const chatHash = md5Hex(chat);
  const matchingResources = resourceMd5s
    .map((resourceMd5) => ({
      resourceMd5,
      variants: findImageVariants(attachRoot, chatHash, resourceMd5, createTime),
    }))
    .filter((entry) => entry.variants.length > 0);
  if (matchingResources.length === 0) {
    throw new WeChatImageFailure('MEDIA_SOURCE_NOT_FOUND');
  }
  if (matchingResources.length !== 1) {
    throw new WeChatImageFailure('WECHAT_IMAGE_SOURCE_AMBIGUOUS');
  }

  let sawOversized = false;
  let sawV2WithoutKey = false;
  for (const sourcePath of matchingResources[0].variants) {
    let source;
    try {
      source = readSafeSourceFile(sourcePath, attachRoot, maxBytes + 4096);
    } catch (error) {
      if (error instanceof WeChatImageFailure && error.code === 'MEDIA_TOO_LARGE') {
        sawOversized = true;
      }
      continue;
    }
    if (source.length > maxBytes + 4096) {
      sawOversized = true;
      continue;
    }
    let decoded;
    try {
      decoded = decodeImageDat(source, {
        accountRoot,
        kvcommDir,
      });
    } catch (error) {
      if (error instanceof WeChatImageFailure && error.code === 'WECHAT_IMAGE_KEY_UNAVAILABLE') {
        sawV2WithoutKey = true;
      }
      continue;
    }
    const format = detectDecodedImageFormat(decoded);
    if (!['jpg', 'png', 'gif', 'webp'].includes(format)) continue;
    if (decoded.length > maxBytes) {
      sawOversized = true;
      continue;
    }
    writePrivateFile(outputPath, decoded);
    return { path: outputPath, format };
  }

  if (sawV2WithoutKey) throw new WeChatImageFailure('WECHAT_IMAGE_KEY_UNAVAILABLE');
  if (sawOversized) throw new WeChatImageFailure('MEDIA_TOO_LARGE');
  throw new WeChatImageFailure('WECHAT_IMAGE_DECODE_UNSUPPORTED');
}

export function extractResourceMd5s(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  const marker = Buffer.from([0x12, 0x22, 0x0a, 0x20]);
  const markerIndex = bytes.indexOf(marker);
  if (markerIndex >= 0 && markerIndex + marker.length + 32 <= bytes.length) {
    const candidate = bytes.subarray(markerIndex + marker.length, markerIndex + marker.length + 32);
    const text = candidate.toString('ascii');
    if (RESOURCE_MD5.test(text)) return [text.toLowerCase()];
  }

  const matches = bytes.toString('ascii').match(/[0-9a-f]{32}/gi) ?? [];
  return [...new Set(matches.map((item) => item.toLowerCase()))];
}

export function readWeChatReaderConfig({
  wxCliDir = join(homedir(), '.wx-cli'),
  dbDir,
} = {}) {
  const cliRoot = resolve(wxCliDir);
  assertPrivateDirectory(cliRoot);
  const configuredDbDir = resolve(dbDir ?? readWxConfig(cliRoot).db_dir ?? '');
  if (!configuredDbDir || basename(configuredDbDir) !== 'db_storage') {
    throw new WeChatImageFailure('WECHAT_READER_CONFIG_UNAVAILABLE');
  }
  return { cliRoot, dbDir: configuredDbDir };
}

export function resolveWeChatMessageResourceMd5s({
  cliRoot,
  chat,
  localId,
  createTime,
  localType,
}) {
  if (
    typeof chat !== 'string' ||
    !Number.isSafeInteger(localId) ||
    !Number.isSafeInteger(createTime) ||
    !Number.isSafeInteger(localType)
  ) {
    throw new WeChatImageFailure('MEDIA_REFERENCE_INVALID');
  }
  return resourceMd5sForMessage({ cliRoot, chat, localId, createTime, localType });
}

export function decodeWeChatImageDat(source, material) {
  return decodeImageDat(Buffer.from(source), material);
}

function readWxConfig(cliRoot) {
  const configPath = join(cliRoot, 'config.json');
  const value = readPrivateJsonFile(configPath, cliRoot);
  return value && typeof value === 'object' ? value : {};
}

function resourceMd5sForMessage({ cliRoot, chat, localId, createTime, localType }) {
  const cacheRoot = realpathDirectory(join(cliRoot, 'cache'));
  const metadataPath = join(cacheRoot, '_mtimes.json');
  const metadata = readPrivateJsonFile(metadataPath, cacheRoot);

  const table = `Msg_${md5Hex(chat)}`;
  const results = new Set();
  const messageShards = Object.keys(metadata ?? {})
    .filter((name) => /^message\/message_\d+\.db$/.test(name))
    .sort()
    .slice(0, 64);
  for (const relativeName of messageShards) {
    const cachePath = metadata?.[relativeName]?.path;
    if (typeof cachePath !== 'string') continue;
    const configuredPath = resolve(cachePath);
    if (!CACHE_FILE.test(basename(configuredPath))) continue;
    let resolvedPath;
    try {
      if (lstatSync(configuredPath).isSymbolicLink()) continue;
      resolvedPath = realpathSync(configuredPath);
    } catch {
      continue;
    }
    if (dirname(resolvedPath) !== cacheRoot) continue;
    assertPrivateFile(resolvedPath, cacheRoot);
    let database;
    try {
      database = new Database(resolvedPath, { readonly: true, fileMustExist: true });
      const exists = database
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) continue;
      const row = database
        .prepare(
          `SELECT packed_info_data
           FROM [${table}]
           WHERE local_id = ?
             AND create_time = ?
             AND (local_type & 4294967295) = ?
           ORDER BY rowid DESC
           LIMIT 1`,
        )
        .get(localId, createTime, localType);
      for (const resourceMd5 of extractResourceMd5s(row?.packed_info_data)) {
        results.add(resourceMd5);
      }
    } catch {
      // A stale shard must not prevent another current shard from resolving the message.
    } finally {
      database?.close();
    }
  }
  return [...results];
}

function findImageVariants(attachRoot, chatHash, resourceMd5, createTime) {
  if (!RESOURCE_MD5.test(resourceMd5)) return [];
  const chatDirectory = join(attachRoot, chatHash);
  if (!existsSync(chatDirectory)) return [];
  const resolvedChatDirectory = realpathDirectory(chatDirectory);
  assertWithin(resolvedChatDirectory, attachRoot);
  const monthOrder = orderedMonths(resolvedChatDirectory, createTime);
  const result = [];
  for (const month of monthOrder) {
    const imageDirectory = join(resolvedChatDirectory, month, 'Img');
    if (!existsSync(imageDirectory)) continue;
    for (const suffix of ['', '_h', '_t']) {
      const candidate = join(imageDirectory, `${resourceMd5}${suffix}.dat`);
      if (existsSync(candidate)) result.push(candidate);
    }
  }
  return result;
}

function orderedMonths(chatDirectory, createTime) {
  const date = new Date(createTime * 1000);
  const preferred = [-1, 0, 1].map((offset) => {
    const current = new Date(date.getFullYear(), date.getMonth() + offset, 1);
    return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
  });
  const all = readdirSync(chatDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  return [...new Set([...preferred, ...all])];
}

function decodeImageDat(source, { accountRoot, kvcommDir, aesKey, xorKey } = {}) {
  if (source.length === 0) throw new WeChatImageFailure('MEDIA_SOURCE_NOT_FOUND');
  if (detectDecodedImageFormat(source)) return source;

  const isV2 = source.subarray(0, V2_MAGIC.length).equals(V2_MAGIC);
  const isV1 = source.subarray(0, V1_MAGIC.length).equals(V1_MAGIC);
  if (isV2 || isV1) {
    let material;
    if (isV1) {
      material = { aesKey: V1_AES_KEY, xorKey: xorKey ?? deriveSingleXorKey(accountRoot, kvcommDir) };
    } else if (aesKey && Number.isInteger(xorKey)) {
      material = { aesKey: Buffer.from(aesKey), xorKey };
    } else {
      material = deriveV2ImageKey(source, accountRoot, kvcommDir);
    }
    return decodeAesImage(source, material);
  }
  return decodeLegacyXor(source);
}

function deriveV2ImageKey(source, accountRoot, kvcommDir) {
  if (!accountRoot) throw new WeChatImageFailure('WECHAT_IMAGE_KEY_UNAVAILABLE');
  const resolvedAccountRoot = resolve(accountRoot);
  const cacheKey = `${resolvedAccountRoot}\u0000${kvcommDir ?? ''}`;
  const cached = imageKeyCache.get(cacheKey);
  if (cached && validTemplateKey(source, cached.aesKey)) return cached;

  const codes = readKvcommCodes(resolvedAccountRoot, kvcommDir);
  const accountName = basename(resolvedAccountRoot);
  const wxids = [...new Set([normalizeAccountName(accountName), accountName])];
  for (const wxid of wxids) {
    for (const code of codes) {
      const keyText = md5Hex(`${code}${wxid}`).slice(0, 16);
      const material = { aesKey: Buffer.from(keyText, 'ascii'), xorKey: code & 0xff };
      if (validTemplateKey(source, material.aesKey)) {
        imageKeyCache.set(cacheKey, material);
        return material;
      }
    }
  }
  throw new WeChatImageFailure('WECHAT_IMAGE_KEY_UNAVAILABLE');
}

function deriveSingleXorKey(accountRoot, kvcommDir) {
  const codes = readKvcommCodes(resolve(accountRoot), kvcommDir);
  if (codes.length !== 1) throw new WeChatImageFailure('WECHAT_IMAGE_KEY_UNAVAILABLE');
  return codes[0] & 0xff;
}

function readKvcommCodes(accountRoot, override) {
  const documentsRoot = dirname(dirname(accountRoot));
  const directory = resolve(override ?? join(documentsRoot, 'app_data', 'net', 'kvcomm'));
  if (!existsSync(directory)) throw new WeChatImageFailure('WECHAT_IMAGE_KEY_UNAVAILABLE');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WeChatImageFailure('WECHAT_IMAGE_KEY_UNAVAILABLE');
  }
  const codes = readdirSync(directory)
    .map((name) => /^key_(\d+)_/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter(Number.isSafeInteger);
  return [...new Set(codes)].slice(0, 256);
}

function validTemplateKey(source, aesKey) {
  if (source.length < HEADER_SIZE + 16 || aesKey.length !== 16) return false;
  try {
    return Boolean(detectDecodedImageFormat(decryptAesBlock(aesKey, source.subarray(15, 31))));
  } catch {
    return false;
  }
}

function decodeAesImage(source, { aesKey, xorKey }) {
  if (source.length < HEADER_SIZE || aesKey.length !== 16 || !Number.isInteger(xorKey)) {
    throw new WeChatImageFailure('WECHAT_IMAGE_DECODE_UNSUPPORTED');
  }
  const aesSize = source.readUInt32LE(6);
  const xorSize = source.readUInt32LE(10);
  const alignedAesSize = aesSize + (16 - (aesSize % 16));
  const aesEnd = HEADER_SIZE + alignedAesSize;
  const rawEnd = source.length - xorSize;
  if (aesEnd > rawEnd || rawEnd < HEADER_SIZE) {
    throw new WeChatImageFailure('WECHAT_IMAGE_DECODE_UNSUPPORTED');
  }

  let decrypted;
  try {
    const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
    decipher.setAutoPadding(true);
    decrypted = Buffer.concat([
      decipher.update(source.subarray(HEADER_SIZE, aesEnd)),
      decipher.final(),
    ]);
  } catch {
    throw new WeChatImageFailure('WECHAT_IMAGE_DECODE_UNSUPPORTED');
  }
  const tail = Buffer.from(source.subarray(rawEnd));
  for (let index = 0; index < tail.length; index++) tail[index] ^= xorKey;
  const output = Buffer.concat([decrypted, source.subarray(aesEnd, rawEnd), tail]);
  if (!detectDecodedImageFormat(output)) {
    throw new WeChatImageFailure('WECHAT_IMAGE_DECODE_UNSUPPORTED');
  }
  return output;
}

function decryptAesBlock(key, block) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(block), decipher.final()]);
}

function decodeLegacyXor(source) {
  for (const signature of [
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from('GIF8'),
    Buffer.from('RIFF'),
    Buffer.from([0xff, 0xd8, 0xff]),
  ]) {
    if (source.length < signature.length) continue;
    const key = source[0] ^ signature[0];
    if (!signature.every((byte, index) => (source[index] ^ key) === byte)) continue;
    const output = Buffer.allocUnsafe(source.length);
    for (let index = 0; index < source.length; index++) output[index] = source[index] ^ key;
    if (detectDecodedImageFormat(output)) return output;
  }
  throw new WeChatImageFailure('WECHAT_IMAGE_DECODE_UNSUPPORTED');
}

function detectDecodedImageFormat(value) {
  const bytes = Buffer.from(value);
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'wxgf') return 'hevc';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString('ascii') === 'PNG') {
    return 'png';
  }
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0]))) {
    return 'tif';
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString('ascii') === 'BM') return 'bmp';
  return null;
}

function readSafeSourceFile(sourcePath, attachRoot, maxBytes) {
  const linked = lstatSync(sourcePath);
  if (!linked.isFile() || linked.isSymbolicLink() || linked.uid !== process.getuid()) {
    throw new WeChatImageFailure('MEDIA_PATH_INVALID');
  }
  const resolved = realpathSync(sourcePath);
  assertWithin(resolved, attachRoot);
  const descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== process.getuid() || opened.size <= 0) {
      throw new WeChatImageFailure('MEDIA_SOURCE_NOT_FOUND');
    }
    if (opened.size > maxBytes) throw new WeChatImageFailure('MEDIA_TOO_LARGE');
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateFile(path, bytes) {
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

function assertPrivateDirectory(path) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new WeChatImageFailure('WECHAT_IMAGE_CACHE_UNAVAILABLE');
  }
}

function assertPrivateFile(path, root) {
  const resolved = resolve(path);
  assertWithin(resolved, resolve(root));
  const stat = lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new WeChatImageFailure('WECHAT_IMAGE_CACHE_UNAVAILABLE');
  }
}

function readPrivateJsonFile(path, root) {
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
      throw new WeChatImageFailure('WECHAT_IMAGE_CACHE_UNAVAILABLE');
    }
    return JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch {
    throw new WeChatImageFailure('WECHAT_IMAGE_CACHE_UNAVAILABLE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function realpathDirectory(path) {
  const linked = lstatSync(path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || linked.uid !== process.getuid()) {
    throw new WeChatImageFailure('MEDIA_PATH_INVALID');
  }
  const resolved = realpathSync(path);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw new WeChatImageFailure('MEDIA_PATH_INVALID');
  }
  return resolved;
}

function assertWithin(path, root) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) {
    throw new WeChatImageFailure('MEDIA_PATH_INVALID');
  }
}

function normalizeAccountName(value) {
  if (value.startsWith('wxid_')) return `wxid_${value.slice(5).split('_')[0]}`;
  return /_[0-9a-f]{4}$/i.test(value) ? value.slice(0, -5) : value;
}

function md5Hex(value) {
  return createHash('md5').update(value).digest('hex');
}

export class WeChatImageFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
