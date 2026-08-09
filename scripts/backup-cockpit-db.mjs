#!/usr/bin/env node

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPrivateFile,
  securePrivateDirectory,
  securePrivateFile,
} from '../lib/private-paths.mjs';

const dataDir = join(homedir(), '.wechat-dashboard');
const source = join(dataDir, 'dashboard.db');
const backupDir = join(dataDir, 'backups');

try {
  securePrivateDirectory(dataDir);
} catch (error) {
  if (!String(error).includes('is missing')) throw error;
  console.error(`Private data directory not found: ${dataDir}`);
  process.exit(1);
}

if (!securePrivateFile(source, { allowMissing: true })) {
  console.error(`dashboard.db not found: ${source}`);
  process.exit(1);
}
for (const path of [`${source}-wal`, `${source}-shm`]) {
  securePrivateFile(path, { allowMissing: true });
}

securePrivateDirectory(backupDir, { create: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupId = randomUUID();
const staging = join(backupDir, `.dashboard-${backupId}.tmp`);
const target = join(backupDir, `dashboard-${stamp}-${backupId}.db`);

const db = new Database(source, { readonly: true, fileMustExist: true });

try {
  createPrivateFile(staging);
  await db.backup(staging);
  securePrivateFile(staging);
  renameSync(staging, target);
  securePrivateFile(target);
  console.log(target);
} catch (err) {
  try {
    unlinkSync(staging);
  } catch {
    // The staging file may already have been renamed or never created.
  }
  console.error(err);
  process.exitCode = 1;
} finally {
  db.close();
}
