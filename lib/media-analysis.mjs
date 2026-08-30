import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { extractWeChatImageFromCache } from './wechat-image-reader.mjs';
import { extractWeChatVideoFromCache } from './wechat-video-reader.mjs';

export const MEDIA_POLICY = Object.freeze({
  maxAssetsPerJob: 8,
  maxImageBytes: 12 * 1024 * 1024,
  maxVideoBytes: 80 * 1024 * 1024,
  maxTotalSourceBytes: 200 * 1024 * 1024,
  maxVideoDurationSeconds: 15 * 60,
  maxFramesPerVideo: 6,
});

export function extractFeishuResourceKeys(content) {
  if (typeof content !== 'string') return { image: [], file: [] };
  const tokens = content.match(/(?:^|[^A-Za-z0-9_-])((?:img|file)_[A-Za-z0-9_-]{6,})/g) ?? [];
  const keys = tokens
    .map((token) => token.match(/((?:img|file)_[A-Za-z0-9_-]{6,})/)?.[1] ?? '')
    .filter(Boolean);
  return {
    image: [...new Set(keys.filter((key) => key.startsWith('img_')))],
    file: [...new Set(keys.filter((key) => key.startsWith('file_')))],
  };
}

export function detectMediaType(path) {
  const buffer = Buffer.alloc(32);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytesRead = 0;
  try {
    bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const header = buffer.subarray(0, bytesRead);
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header.subarray(1, 4).toString('ascii') === 'PNG'
  ) {
    return { kind: 'image', mimeType: 'image/png', extension: '.png' };
  }
  if (header.subarray(0, 3).toString('ascii') === 'GIF') {
    return { kind: 'image', mimeType: 'image/gif', extension: '.gif' };
  }
  if (
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { kind: 'image', mimeType: 'image/webp', extension: '.webp' };
  }
  const brand = header.subarray(8, 12).toString('ascii');
  if (
    header.length >= 12 &&
    header.subarray(4, 8).toString('ascii') === 'ftyp' &&
    /^(?:iso.|mp4.|avc1|M4V |qt  |dash|MSNV|3g..)$/.test(brand)
  ) {
    return { kind: 'video', mimeType: 'video/mp4', extension: '.mp4' };
  }
  return null;
}

export function prepareMediaArtifacts(context, privateDir, options = {}) {
  const root = resolve(privateDir);
  const execute = options.execFileSync ?? execFileSync;
  const binaries = {
    wx: options.wxBinary,
    lark: options.larkBinary,
    ffmpeg: options.ffmpegBinary ?? 'ffmpeg',
    ffprobe: options.ffprobeBinary ?? 'ffprobe',
  };
  const wechatImageReader = options.wechatImageReader ?? extractWeChatImageFromCache;
  const wechatVideoReader = options.wechatVideoReader ?? extractWeChatVideoFromCache;
  const processing = context?.media_processing;
  const requests = [];
  for (const conversation of context?.conversations ?? []) {
    for (const message of conversation?.messages ?? []) {
      if (message?.media_request) requests.push({ message, request: message.media_request });
    }
  }

  const summary = {
    enabled: processing?.enabled === true,
    scope: 'group_only',
    requested: requests.length,
    ready: 0,
    unavailable: 0,
    skipped: 0,
    audio_transcription: false,
    wechat_video_reader: 'local_hardlink_index',
    limits: {
      assets_per_job: MEDIA_POLICY.maxAssetsPerJob,
      image_bytes: MEDIA_POLICY.maxImageBytes,
      video_bytes: MEDIA_POLICY.maxVideoBytes,
      total_source_bytes: MEDIA_POLICY.maxTotalSourceBytes,
      video_duration_seconds: MEDIA_POLICY.maxVideoDurationSeconds,
      frames_per_video: MEDIA_POLICY.maxFramesPerVideo,
    },
  };
  const selected = new Set(
    requests
      .slice()
      .sort(
        (left, right) =>
          Number(right.message?.timestamp ?? 0) - Number(left.message?.timestamp ?? 0),
      )
      .slice(0, MEDIA_POLICY.maxAssetsPerJob)
      .map(({ message }) => message),
  );
  const wxAttachmentCache = new Map();
  let sequence = 0;
  let totalSourceBytes = 0;

  for (const item of requests) {
    const { message, request } = item;
    delete message.media_request;
    if (!summary.enabled) continue;
    if (!selected.has(message)) {
      message.media = unavailableMedia(request.kind, 'MEDIA_LIMIT_REACHED', 'skipped');
      summary.skipped++;
      continue;
    }
    sequence++;
    try {
      const source =
        request.platform === 'wechat'
          ? request.kind === 'image'
            ? extractWeChatImage({
                request,
                root,
                sequence,
                execute,
                wxBinary: binaries.wx,
                cache: wxAttachmentCache,
                wechatImageReader,
              })
            : extractWeChatVideo({ request, root, sequence, wechatVideoReader })
          : downloadFeishuMedia({
              request,
              content: message.content,
              root,
              sequence,
              execute,
              larkBinary: binaries.lark,
            });
      const sourceBytes = lstatSync(source.path).size;
      if (totalSourceBytes + sourceBytes > MEDIA_POLICY.maxTotalSourceBytes) {
        message.media = unavailableMedia(request.kind, 'MEDIA_JOB_BYTES_EXCEEDED', 'skipped');
        summary.skipped++;
        continue;
      }
      totalSourceBytes += sourceBytes;
      if (request.kind === 'image') {
        const artifact = imageArtifact(source.path);
        message.media = {
          kind: 'image',
          status: 'ready',
          analysis_scope: 'visual_and_ocr',
          artifacts: [artifact],
        };
      } else {
        const frames = extractVideoFrames({
          sourcePath: source.path,
          root,
          sequence,
          execute,
          ffmpegBinary: binaries.ffmpeg,
          ffprobeBinary: binaries.ffprobe,
        });
        message.media = {
          kind: 'video',
          status: 'ready',
          analysis_scope: 'sampled_frames_without_audio',
          artifacts: frames,
        };
      }
      summary.ready++;
    } catch (error) {
      const code = mediaErrorCode(error);
      message.media = unavailableMedia(request.kind, code, 'unavailable');
      summary.unavailable++;
    }
  }

  context.media_processing = summary;
  context.media_processing.source_bytes = totalSourceBytes;
  return context;
}

function extractWeChatVideo({ request, root, sequence, wechatVideoReader }) {
  if (
    !Number.isSafeInteger(request.local_id) ||
    !Number.isSafeInteger(request.timestamp) ||
    !validDate(request.date)
  ) {
    throw new MediaFailure('MEDIA_REFERENCE_INVALID');
  }
  const temporary = join(root, mediaName(sequence, 'download'));
  wechatVideoReader({
    chat: request.conversation_id,
    localId: request.local_id,
    createTime: request.timestamp,
    outputPath: temporary,
    maxBytes: MEDIA_POLICY.maxVideoBytes,
  });
  return finalizeDownloadedFile(temporary, root, sequence, 'video');
}

function extractWeChatImage({
  request,
  root,
  sequence,
  execute,
  wxBinary,
  cache,
  wechatImageReader,
}) {
  if (
    !wxBinary ||
    !Number.isSafeInteger(request.local_id) ||
    !Number.isSafeInteger(request.timestamp) ||
    !validDate(request.date)
  ) {
    throw new MediaFailure('MEDIA_REFERENCE_INVALID');
  }
  const cacheKey = `${request.conversation_id}\u0000${request.date}`;
  let attachments = cache.get(cacheKey);
  if (!attachments) {
    const payload = runJson(
      execute,
      wxBinary,
      [
        'attachments',
        request.conversation_id,
        '--kind',
        'image',
        '--since',
        request.date,
        '--until',
        request.date,
        '-n',
        '1000',
        '--json',
      ],
      { cwd: root, timeout: 90_000 },
    );
    attachments = unwrapArray(payload, ['attachments', 'items', 'data']);
    cache.set(cacheKey, attachments);
  }
  const attachment = attachments.find(
    (item) =>
      Number(item?.local_id) === request.local_id &&
      Number(item?.timestamp) === request.timestamp,
  );
  if (typeof attachment?.attachment_id !== 'string') {
    throw new MediaFailure('MEDIA_SOURCE_NOT_FOUND');
  }
  const temporary = join(root, mediaName(sequence, 'download'));
  try {
    wechatImageReader({
      chat: request.conversation_id,
      localId: request.local_id,
      createTime: request.timestamp,
      outputPath: temporary,
      maxBytes: MEDIA_POLICY.maxImageBytes,
    });
  } catch (localError) {
    if (existsSync(temporary) && isOwnedMediaPath(temporary, root)) unlinkSync(temporary);
    try {
      runJson(
        execute,
        wxBinary,
        ['extract', attachment.attachment_id, '--output', temporary, '--json'],
        { cwd: root, timeout: 90_000 },
      );
    } catch (readerError) {
      if (readerError?.code === 'WECHAT_RESOURCE_KEY_UNAVAILABLE' && localError?.code) {
        throw new MediaFailure(localError.code);
      }
      throw readerError;
    }
  }
  return finalizeDownloadedFile(temporary, root, sequence, 'image');
}

function downloadFeishuMedia({ request, content, root, sequence, execute, larkBinary }) {
  if (!larkBinary || typeof request.source_message_id !== 'string') {
    throw new MediaFailure('MEDIA_REFERENCE_INVALID');
  }
  const keys = request.resource_keys ?? extractFeishuResourceKeys(content);
  const fileKey = request.kind === 'image' ? keys.image[0] : keys.file[0];
  if (!fileKey) throw new MediaFailure('MEDIA_REFERENCE_INVALID');
  const filename = mediaName(sequence, 'download');
  const output = runJson(
    execute,
    larkBinary,
    [
      'im',
      '+messages-resources-download',
      '--as',
      'user',
      '--message-id',
      request.source_message_id,
      '--file-key',
      fileKey,
      '--type',
      request.kind === 'image' ? 'image' : 'file',
      '--output',
      filename,
      '--format',
      'json',
    ],
    { cwd: root, timeout: 120_000 },
  );
  if (output?.identity !== 'user') throw new MediaFailure('FEISHU_IDENTITY_INVALID');
  const candidates = readdirSync(root)
    .filter((name) => name === filename || name.startsWith(`${filename}.`))
    .map((name) => join(root, name));
  if (candidates.length !== 1) throw new MediaFailure('MEDIA_SOURCE_NOT_FOUND');
  return finalizeDownloadedFile(candidates[0], root, sequence, request.kind);
}

function finalizeDownloadedFile(path, root, sequence, expectedKind) {
  const maxBytes =
    expectedKind === 'image' ? MEDIA_POLICY.maxImageBytes : MEDIA_POLICY.maxVideoBytes;
  assertRegularOwnedFile(path, root, maxBytes);
  const detected = detectMediaType(path);
  if (!detected || detected.kind !== expectedKind) throw new MediaFailure('MEDIA_TYPE_UNSUPPORTED');
  const finalPath = join(root, mediaName(sequence, detected.extension.slice(1)));
  if (resolve(path) !== resolve(finalPath)) renameSync(path, finalPath);
  assertRegularOwnedFile(finalPath, root, maxBytes);
  return { path: finalPath, detected };
}

function imageArtifact(path) {
  const detected = detectMediaType(path);
  if (!detected || detected.kind !== 'image') throw new MediaFailure('MEDIA_TYPE_UNSUPPORTED');
  const stat = lstatSync(path);
  return {
    role: 'image',
    path,
    mime_type: detected.mimeType,
    size_bytes: stat.size,
  };
}

function extractVideoFrames({
  sourcePath,
  root,
  sequence,
  execute,
  ffmpegBinary,
  ffprobeBinary,
}) {
  const probe = runJson(
    execute,
    ffprobeBinary,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', sourcePath],
    { cwd: root, timeout: 30_000 },
  );
  const duration = Number(probe?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MediaFailure('VIDEO_DURATION_UNAVAILABLE');
  }
  if (duration > MEDIA_POLICY.maxVideoDurationSeconds) {
    throw new MediaFailure('VIDEO_TOO_LONG');
  }
  const times = representativeTimes(duration);
  const frames = [];
  for (let index = 0; index < times.length; index++) {
    const framePath = join(root, `frame-${String(sequence).padStart(3, '0')}-${String(index + 1).padStart(2, '0')}.jpg`);
    execute(
      ffmpegBinary,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        times[index].toFixed(3),
        '-i',
        sourcePath,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-vf',
        'scale=1280:-2:force_original_aspect_ratio=decrease',
        framePath,
      ],
      { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    assertRegularOwnedFile(framePath, root, MEDIA_POLICY.maxImageBytes);
    const detected = detectMediaType(framePath);
    if (detected?.mimeType !== 'image/jpeg') throw new MediaFailure('FRAME_EXTRACTION_FAILED');
    frames.push({
      role: 'video_frame',
      path: framePath,
      mime_type: 'image/jpeg',
      size_bytes: lstatSync(framePath).size,
      frame_at_seconds: times[index],
    });
  }
  if (frames.length === 0) throw new MediaFailure('FRAME_EXTRACTION_FAILED');
  return frames;
}

function representativeTimes(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const raw = duration < 2
    ? [0]
    : [Math.min(0.5, duration / 4), duration * 0.2, duration * 0.4, duration * 0.6, duration * 0.8, duration * 0.95];
  return [...new Set(raw.map((value) => Math.max(0, Math.min(duration - 0.05, value)).toFixed(3)))]
    .slice(0, MEDIA_POLICY.maxFramesPerVideo)
    .map(Number);
}

function runJson(execute, binary, args, options) {
  try {
    const stdout = execute(binary, args, {
      ...options,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error instanceof MediaFailure) throw error;
    throw new MediaFailure(commandErrorCode(error));
  }
}

function commandErrorCode(error) {
  const record = error && typeof error === 'object' ? error : {};
  const diagnostic = `${record.stdout ?? ''}\n${record.stderr ?? ''}`;
  if (/message_resource\.db|无法解密/i.test(diagnostic)) {
    return 'WECHAT_RESOURCE_KEY_UNAVAILABLE';
  }
  if (/keychain|get failed|token.*(?:expired|invalid)/i.test(diagnostic)) {
    return 'FEISHU_AUTH_NOT_READY';
  }
  return 'MEDIA_COMMAND_FAILED';
}

function assertRegularOwnedFile(path, root, maxBytes) {
  const resolved = resolve(path);
  if (!isOwnedMediaPath(resolved, root) || !existsSync(resolved)) {
    throw new MediaFailure('MEDIA_PATH_INVALID');
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new MediaFailure('MEDIA_PATH_INVALID');
  const descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size <= 0) throw new MediaFailure('MEDIA_SOURCE_NOT_FOUND');
    if (opened.size > maxBytes) throw new MediaFailure('MEDIA_TOO_LARGE');
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

function isOwnedMediaPath(path, root) {
  const resolved = resolve(path);
  return dirname(resolved) === root && /^(?:media-\d{3}|frame-\d{3}-\d{2})\.[a-z0-9]+$/i.test(basename(resolved));
}

function mediaName(sequence, extension) {
  return `media-${String(sequence).padStart(3, '0')}.${extension}`;
}

function unavailableMedia(kind, reasonCode, status) {
  return {
    kind,
    status,
    reason_code: reasonCode,
    artifacts: [],
  };
}

function mediaErrorCode(error) {
  if (error instanceof MediaFailure) return error.code;
  const code = error && typeof error === 'object' ? error.code : null;
  return typeof code === 'string' && /^(?:MEDIA|VIDEO|FRAME|WECHAT|FEISHU)_[A-Z0-9_]+$/.test(code)
    ? code
    : 'MEDIA_PROCESSING_FAILED';
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function unwrapArray(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

class MediaFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
