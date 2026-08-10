#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPrivateFile,
  securePrivateDirectory,
  securePrivateFile,
} from '../lib/private-paths.mjs';
import { readerCacheIsPrivate } from '../lib/reader-security.mjs';

verifyDataRootSymlinkRejected();
verifyPrivateFileSymlinkRejected();
verifyDatabaseSidecarSymlinkRejected();
verifyBackupStagingSymlinkRejected();
verifyReaderCacheAccepted();
verifyReaderCacheSymlinkRejected();
verifyReaderCachePermissionsRejected();

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'verified',
      summary: 'Private Dashboard paths reject symbolic links.',
      checks: {
        data_root_symlink_rejected: true,
        private_file_symlink_rejected: true,
        database_sidecar_symlink_rejected: true,
        backup_staging_symlink_rejected: true,
        reader_cache_private_path_accepted: true,
        reader_cache_symlink_rejected: true,
        reader_cache_permissions_rejected: true,
      },
    },
    null,
    2,
  )}\n`,
);

function verifyDataRootSymlinkRejected() {
  withPrivateHome((home) => {
    const target = join(home, 'linked-data');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(home, '.wechat-dashboard'));
    assert.throws(
      () => securePrivateDirectory(join(home, '.wechat-dashboard')),
      /must not be a symlink or another file type/,
    );
  });
}

function verifyPrivateFileSymlinkRejected() {
  withPrivateHome((home) => {
    const dataDir = join(home, '.wechat-dashboard');
    mkdirSync(dataDir, { mode: 0o700 });
    const target = join(home, 'linked-file');
    writeFileSync(target, 'not-a-database', { mode: 0o600 });
    const databasePath = join(dataDir, 'dashboard.db');
    symlinkSync(target, databasePath);
    assert.throws(
      () => securePrivateFile(databasePath, { allowMissing: true }),
      /must not be a symlink or another file type/,
    );
  });
}

function verifyDatabaseSidecarSymlinkRejected() {
  withPrivateHome((home) => {
    const dataDir = join(home, '.wechat-dashboard');
    mkdirSync(dataDir, { mode: 0o700 });
    const target = join(home, 'linked-sidecar');
    writeFileSync(target, 'not-a-sidecar', { mode: 0o600 });
    const sidecarPath = join(dataDir, 'dashboard.db-wal');
    symlinkSync(target, sidecarPath);
    assert.throws(
      () => securePrivateFile(sidecarPath, { allowMissing: true }),
      /must not be a symlink or another file type/,
    );
  });
}

function verifyBackupStagingSymlinkRejected() {
  withPrivateHome((home) => {
    const target = join(home, 'linked-backup-target');
    writeFileSync(target, 'must-not-change', { mode: 0o600 });
    const stagingPath = join(home, 'backup-stage');
    symlinkSync(target, stagingPath);
    assert.throws(() => createPrivateFile(stagingPath), (error) => error?.code === 'EEXIST');
  });
}

function verifyReaderCacheAccepted() {
  withPrivateHome((home) => {
    createReaderCache(home);
    assert.equal(readerCacheIsPrivate(home), true);
  });
}

function verifyReaderCacheSymlinkRejected() {
  withPrivateHome((home) => {
    const wxRoot = join(home, '.wx-cli');
    mkdirSync(wxRoot, { mode: 0o700 });
    const linkedCache = join(home, 'linked-cache');
    mkdirSync(linkedCache, { mode: 0o700 });
    symlinkSync(linkedCache, join(wxRoot, 'cache'));
    writeFileSync(join(wxRoot, 'all_keys.json'), '{}\n', { mode: 0o600 });
    assert.equal(readerCacheIsPrivate(home), false);
  });
}

function verifyReaderCachePermissionsRejected() {
  withPrivateHome((home) => {
    createReaderCache(home);
    chmodSync(join(home, '.wx-cli', 'all_keys.json'), 0o644);
    assert.equal(readerCacheIsPrivate(home), false);
  });
}

function createReaderCache(home) {
  const wxRoot = join(home, '.wx-cli');
  mkdirSync(wxRoot, { mode: 0o700 });
  mkdirSync(join(wxRoot, 'cache'), { mode: 0o700 });
  writeFileSync(join(wxRoot, 'all_keys.json'), '{}\n', { mode: 0o600 });
}

function withPrivateHome(callback) {
  const home = mkdtempSync(join(tmpdir(), 'wechat-dashboard-paths-'));
  try {
    callback(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
