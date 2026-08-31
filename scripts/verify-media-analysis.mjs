#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEDIA_POLICY,
  detectMediaType,
  extractFeishuResourceKeys,
  prepareMediaArtifacts,
} from '../lib/media-analysis.mjs';
import { extractWeChatImageFromCache } from '../lib/wechat-image-reader.mjs';
import {
  decryptSqlCipherDatabaseSnapshot,
  selectVideoSource,
} from '../lib/wechat-video-reader.mjs';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
const privateDir = mkdtempSync(join(tmpdir(), 'wechat-dashboard-media-test-'));

try {
  const imagePath = join(privateDir, 'media-999.jpg');
  writeFileSync(imagePath, jpeg, { mode: 0o600 });
  assert.deepEqual(detectMediaType(imagePath), {
    kind: 'image',
    mimeType: 'image/jpeg',
    extension: '.jpg',
  });
  const mp4Path = join(privateDir, 'video-sample.mp4');
  writeFileSync(mp4Path, Buffer.from('000000186674797069736f6d00000000', 'hex'), {
    mode: 0o600,
  });
  assert.equal(detectMediaType(mp4Path)?.kind, 'video');
  const heicPath = join(privateDir, 'image-sample.heic');
  writeFileSync(heicPath, Buffer.from('00000018667479706865696300000000', 'hex'), {
    mode: 0o600,
  });
  assert.equal(detectMediaType(heicPath), null, 'HEIC must not be treated as MP4 video');

  assert.deepEqual(
    extractFeishuResourceKeys('img_v3_alpha123 file_beta456 img_v3_alpha123'),
    { image: ['img_v3_alpha123'], file: ['file_beta456'] },
  );

  const disabled = sampleContext(false, [sampleMessage('wechat', 'image')]);
  prepareMediaArtifacts(disabled, privateDir, {
    execFileSync() {
      throw new Error('disabled media must not execute a reader');
    },
  });
  assert.equal(disabled.media_processing.enabled, false);
  assert.equal(disabled.conversations[0].messages[0].media_request, undefined);

  const ready = sampleContext(true, [sampleMessage('wechat', 'image')]);
  const fakeExec = (_binary, args) => {
    if (args[0] === 'attachments') {
      return JSON.stringify({
        attachments: [
          { local_id: 42, timestamp: 1_777_555_555, attachment_id: 'wrong-time-id' },
          { local_id: 42, timestamp: 1_777_555_556, attachment_id: 'opaque-attachment-id' },
        ],
      });
    }
    throw new Error('unexpected command');
  };
  prepareMediaArtifacts(ready, privateDir, {
    execFileSync: fakeExec,
    wxBinary: '/test/wx',
    wechatImageReader({ createTime, outputPath }) {
      assert.equal(createTime, 1_777_555_556, 'image lookup must use the exact message timestamp');
      writeFileSync(outputPath, jpeg, { mode: 0o600 });
    },
  });
  const media = ready.conversations[0].messages[0].media;
  assert.equal(media.status, 'ready');
  assert.equal(media.artifacts[0].role, 'image');
  assert.match(media.artifacts[0].path, /media-001\.jpg$/);

  const videoReady = sampleContext(true, [sampleMessage('wechat', 'video')]);
  prepareMediaArtifacts(videoReady, privateDir, {
    ffmpegBinary: '/test/ffmpeg',
    ffprobeBinary: '/test/ffprobe',
    wechatVideoReader({ createTime, outputPath }) {
      assert.equal(createTime, 1_777_555_556, 'video lookup must use the exact message timestamp');
      writeFileSync(outputPath, mp4Fixture(), { mode: 0o600 });
    },
    execFileSync(binary, args) {
      if (binary === '/test/ffprobe') return JSON.stringify({ format: { duration: '12' } });
      if (binary === '/test/ffmpeg') {
        writeFileSync(args.at(-1), jpeg, { mode: 0o600 });
        return '';
      }
      throw new Error('unexpected video command');
    },
  });
  const videoMedia = videoReady.conversations[0].messages[0].media;
  assert.equal(videoReady.media_processing.wechat_video_reader, 'local_hardlink_index');
  assert.equal(videoMedia.status, 'ready');
  assert.equal(videoMedia.analysis_scope, 'sampled_frames_without_audio');
  assert.equal(videoMedia.artifacts.length, MEDIA_POLICY.maxFramesPerVideo);
  assert.ok(videoMedia.artifacts.every((artifact) => artifact.role === 'video_frame'));

  for (const [duration, expectedCode] of [
    ['invalid', 'VIDEO_DURATION_UNAVAILABLE'],
    [String(MEDIA_POLICY.maxVideoDurationSeconds + 1), 'VIDEO_TOO_LONG'],
  ]) {
    const rejectedVideo = sampleContext(true, [sampleMessage('wechat', 'video')]);
    prepareMediaArtifacts(rejectedVideo, privateDir, {
      ffmpegBinary: '/test/ffmpeg',
      ffprobeBinary: '/test/ffprobe',
      wechatVideoReader({ outputPath }) {
        writeFileSync(outputPath, mp4Fixture(), { mode: 0o600 });
      },
      execFileSync(binary) {
        if (binary === '/test/ffprobe') return JSON.stringify({ format: { duration } });
        throw new Error('ffmpeg must not run for a rejected video');
      },
    });
    assert.equal(
      rejectedVideo.conversations[0].messages[0].media.reason_code,
      expectedCode,
    );
  }

  const videoMissing = sampleContext(true, [sampleMessage('wechat', 'video')]);
  prepareMediaArtifacts(videoMissing, privateDir, {
    wechatVideoReader() {
      const failure = new Error('video source missing');
      failure.code = 'MEDIA_SOURCE_NOT_FOUND';
      throw failure;
    },
  });
  assert.equal(videoMissing.conversations[0].messages[0].media.reason_code, 'MEDIA_SOURCE_NOT_FOUND');

  const keyFailure = sampleContext(true, [sampleMessage('wechat', 'image')]);
  prepareMediaArtifacts(keyFailure, privateDir, {
    wxBinary: '/test/wx',
    execFileSync(_binary, args) {
      if (args[0] === 'attachments') {
        return JSON.stringify({
          attachments: [
            { local_id: 42, timestamp: 1_777_555_556, attachment_id: 'opaque-attachment-id' },
          ],
        });
      }
      const failure = new Error('reader failed');
      failure.stderr = '无法解密 message_resource.db';
      throw failure;
    },
    wechatImageReader() {
      const failure = new Error('local mapping unavailable');
      failure.code = 'WECHAT_IMAGE_CACHE_UNAVAILABLE';
      throw failure;
    },
  });
  assert.equal(
    keyFailure.conversations[0].messages[0].media.reason_code,
    'WECHAT_IMAGE_CACHE_UNAVAILABLE',
  );

  verifyLocalWeChatV2Image(privateDir);
  verifyVideoIndexPrimitives(privateDir);

  const many = Array.from({ length: MEDIA_POLICY.maxAssetsPerJob + 2 }, () =>
    sampleMessage('wechat', 'video'),
  );
  const bounded = sampleContext(true, many);
  prepareMediaArtifacts(bounded, privateDir, {
    wechatVideoReader() {
      const failure = new Error('bounded fixture');
      failure.code = 'MEDIA_SOURCE_NOT_FOUND';
      throw failure;
    },
  });
  assert.equal(bounded.media_processing.skipped, 2);
  assert.equal(bounded.media_processing.unavailable, MEDIA_POLICY.maxAssetsPerJob);

  console.log('[PASS] media analysis policy is bounded, opt-in, and evidence-safe');
} finally {
  rmSync(privateDir, { recursive: true, force: true });
}

function sampleContext(enabled, messages) {
  return {
    media_processing: { enabled },
    conversations: [{ messages }],
  };
}

function sampleMessage(platform, kind) {
  return {
    content: platform === 'feishu' ? 'img_v3_alpha123 file_beta456' : kind,
    media_request: {
      kind,
      platform,
      conversation_id: platform === 'wechat' ? 'test@chatroom' : 'feishu:test',
      source_message_id: platform === 'feishu' ? 'om_test' : null,
      local_id: platform === 'wechat' ? 42 : null,
      date: '2026-08-30',
      timestamp: 1_777_555_556,
    },
  };
}

function verifyLocalWeChatV2Image(root) {
  const wxCliDir = join(root, 'fake-wx-cli');
  const cacheDir = join(wxCliDir, 'cache');
  const documentsDir = join(root, 'Documents');
  const accountName = 'testaccount_a1b2';
  const accountRoot = join(documentsDir, 'xwechat_files', accountName);
  const dbDir = join(accountRoot, 'db_storage');
  const kvcommDir = join(documentsDir, 'app_data', 'net', 'kvcomm');
  const chat = 'safe-fixture@chatroom';
  const chatHash = md5(chat);
  const table = `Msg_${chatHash}`;
  const localId = 77;
  const createTime = 1_777_555_556;
  const resourceMd5 = '00112233445566778899aabbccddeeff';
  const cacheName = `${md5('message/message_0.db')}.db`;
  const cachePath = join(cacheDir, cacheName);
  const imageDir = join(accountRoot, 'msg', 'attach', chatHash, '2026-05', 'Img');

  for (const directory of [wxCliDir, cacheDir, dbDir, kvcommDir, imageDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  writeFileSync(
    join(wxCliDir, 'config.json'),
    `${JSON.stringify({ db_dir: dbDir })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(cacheDir, '_mtimes.json'),
    `${JSON.stringify({ 'message/message_0.db': { path: cachePath } })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(kvcommDir, 'key_42_fixture.statistic'), '', { mode: 0o600 });

  const database = new Database(cachePath);
  database.exec(
    `CREATE TABLE [${table}] (
      local_id INTEGER,
      local_type INTEGER,
      create_time INTEGER,
      packed_info_data BLOB
    )`,
  );
  const packedInfo = Buffer.concat([
    Buffer.from([0x12, 0x22, 0x0a, 0x20]),
    Buffer.from(resourceMd5, 'ascii'),
  ]);
  database
    .prepare(`INSERT INTO [${table}] VALUES (?, ?, ?, ?)`)
    .run(localId, 3, createTime, packedInfo);
  database.close();
  chmodSync(cachePath, 0o600);
  const checkDatabase = new Database(cachePath, { readonly: true });
  assert.equal(
    checkDatabase
      .prepare(
        `SELECT COUNT(*) AS count FROM [${table}] WHERE local_id = ? AND create_time = ? AND (local_type & 4294967295) = 3`,
      )
      .get(localId, createTime).count,
    1,
  );
  checkDatabase.close();

  const plaintext = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from('safe fixture image bytes'),
    Buffer.from([0xff, 0xd9]),
  ]);
  const keyText = md5(`42testaccount`).slice(0, 16);
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(keyText, 'ascii'), null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.alloc(15);
  Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]).copy(header);
  header.writeUInt32LE(plaintext.length, 6);
  header.writeUInt32LE(0, 10);
  writeFileSync(
    join(imageDir, `${resourceMd5}_t.dat`),
    Buffer.concat([header, encrypted]),
    { mode: 0o600 },
  );

  const outputPath = join(root, 'local-v2-output.download');
  const result = extractWeChatImageFromCache({
    chat,
    localId,
    createTime,
    outputPath,
    maxBytes: 1024 * 1024,
    wxCliDir,
    dbDir,
    kvcommDir,
  });
  assert.equal(result.format, 'jpg');
  assert.equal(detectMediaType(outputPath)?.mimeType, 'image/jpeg');
}

function verifyVideoIndexPrimitives(root) {
  const key = Buffer.alloc(32, 0x2a);
  const plain = Buffer.alloc(4096, 0x11);
  Buffer.from('SQLite format 3\0', 'binary').copy(plain);
  const encrypted = encryptSqlCipherFirstPage(plain, key);
  const decrypted = decryptSqlCipherDatabaseSnapshot(encrypted, null, key);
  assert.deepEqual(decrypted.subarray(0, 4016), plain.subarray(0, 4016));

  const committedPage = Buffer.alloc(4096, 0x22);
  const trailingPage = Buffer.alloc(4096, 0x33);
  const wal = walFixture([
    { pageNumber: 2, pageCount: 2, encryptedPage: encryptSqlCipherPage(committedPage, key) },
    { pageNumber: 3, pageCount: 0, encryptedPage: encryptSqlCipherPage(trailingPage, key) },
  ]);
  const committed = decryptSqlCipherDatabaseSnapshot(encrypted, wal, key);
  assert.equal(committed.length, 8192, 'uncommitted WAL frames must not enter the snapshot');
  assert.deepEqual(committed.subarray(4096, 8112), committedPage.subarray(0, 4016));

  const videoRoot = join(root, 'video-index-fixture');
  const month = '2026-08';
  const resourceMd5 = 'fedcba98765432100123456789abcdef';
  mkdirSync(join(videoRoot, month), { recursive: true, mode: 0o700 });
  const videoPath = join(videoRoot, month, `${resourceMd5}.mp4`);
  writeFileSync(videoPath, mp4Fixture(), { mode: 0o600 });
  const exactRow = {
    md5: resourceMd5,
    file_name: `${resourceMd5}.mp4`,
    directory: month,
  };
  const selected = selectVideoSource(
    [exactRow],
    [resourceMd5],
    videoRoot,
  );
  assert.equal(selected, realpathSync(videoPath));

  const secondName = '0123456789abcdef0123456789abcdef.mp4';
  writeFileSync(join(videoRoot, month, secondName), mp4Fixture(), { mode: 0o600 });
  assert.throws(
    () => selectVideoSource(
      [exactRow, { md5: resourceMd5, file_name: secondName, directory: month }],
      [resourceMd5],
      videoRoot,
    ),
    (error) => error?.code === 'WECHAT_VIDEO_SOURCE_AMBIGUOUS',
  );
}

function encryptSqlCipherFirstPage(plain, key) {
  const iv = Buffer.alloc(16, 0x55);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encryptedBody = Buffer.concat([
    cipher.update(plain.subarray(16, 4096 - 80)),
    cipher.final(),
  ]);
  const page = Buffer.alloc(4096);
  Buffer.alloc(16, 0x33).copy(page);
  encryptedBody.copy(page, 16);
  iv.copy(page, 4096 - 80);
  return page;
}

function encryptSqlCipherPage(plain, key) {
  const iv = Buffer.alloc(16, 0x66);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encryptedBody = Buffer.concat([
    cipher.update(plain.subarray(0, 4096 - 80)),
    cipher.final(),
  ]);
  const page = Buffer.alloc(4096);
  encryptedBody.copy(page);
  iv.copy(page, 4096 - 80);
  return page;
}

function walFixture(frames) {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x377f0682, 0);
  header.writeUInt32BE(4096, 8);
  header.writeUInt32BE(0x11223344, 16);
  header.writeUInt32BE(0x55667788, 20);
  return Buffer.concat([
    header,
    ...frames.map(({ pageNumber, pageCount, encryptedPage }) => {
      const frameHeader = Buffer.alloc(24);
      frameHeader.writeUInt32BE(pageNumber, 0);
      frameHeader.writeUInt32BE(pageCount, 4);
      frameHeader.writeUInt32BE(0x11223344, 8);
      frameHeader.writeUInt32BE(0x55667788, 12);
      return Buffer.concat([frameHeader, encryptedPage]);
    }),
  ]);
}

function mp4Fixture() {
  return Buffer.from('000000186674797069736f6d000000000000000000000000', 'hex');
}

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}
