#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openPrivateAppendFile,
  securePrivateDirectory,
  securePrivateFile,
} from '../lib/private-paths.mjs';

const CHECK_INTERVAL_MS = 5_000;
const STOP_GRACE_MS = 5_000;
const SESSION_ID_PATTERN = /^[a-f0-9-]{16,64}$/;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const nextBin = join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const buildId = join(projectRoot, '.next', 'BUILD_ID');
const dataDir = join(homedir(), '.wechat-dashboard');
const logDir = join(dataDir, 'logs');
const leasePath = join(dataDir, 'session-lease.json');
const statePath = join(dataDir, 'session-service.json');
const args = parseArgs(process.argv.slice(2));
const sessionId = args['session-id'];
const port = Number(args.port ?? '3000');

if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) abort('Invalid session ID.');
if (!Number.isInteger(port) || port < 1024 || port > 65535) abort('Invalid local port.');
if (!existsSync(nextBin) || !existsSync(buildId)) abort('Production build is unavailable.');

secureDirectories();
const lease = readLease();
if (!lease || lease.session_id !== sessionId || lease.project_root !== projectRoot) {
  abort('The on-demand session lease is missing or invalid.');
}

const stdoutFd = openPrivateAppendFile(join(logDir, 'session.out.log'));
const stderrFd = openPrivateAppendFile(join(logDir, 'session.err.log'));
const server = spawn(
  process.execPath,
  [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(port)],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      WECHAT_DASHBOARD_PROJECT_ROOT: projectRoot,
    },
    stdio: ['ignore', stdoutFd, stderrFd],
  },
);
closeSync(stdoutFd);
closeSync(stderrFd);

writePrivateJsonAtomic(statePath, {
  version: 1,
  session_id: sessionId,
  project_root: projectRoot,
  supervisor_pid: process.pid,
  server_pid: server.pid,
  port,
  started_at: Date.now(),
});

let stopping = false;
let forceTimer;

const interval = setInterval(() => {
  const current = readLease();
  if (
    !current ||
    current.session_id !== sessionId ||
    current.project_root !== projectRoot ||
    !Number.isFinite(current.expires_at) ||
    current.expires_at <= Date.now()
  ) {
    void stop('lease_expired');
  }
}, CHECK_INTERVAL_MS);
interval.unref();

process.on('SIGTERM', () => void stop('requested'));
process.on('SIGINT', () => void stop('requested'));
server.once('exit', () => {
  cleanupOwnedFiles();
  process.exit(0);
});
server.once('error', () => void stop('server_error'));

async function stop(reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  if (server.exitCode === null && !server.killed) {
    server.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (server.exitCode === null) server.kill('SIGKILL');
    }, STOP_GRACE_MS);
    forceTimer.unref();
  }
  cleanupOwnedFiles();
  if (server.exitCode !== null) process.exit(reason === 'server_error' ? 1 : 0);
}

function secureDirectories() {
  securePrivateDirectory(dataDir, { create: true });
  securePrivateDirectory(logDir, { create: true });
}

function readLease() {
  try {
    if (!securePrivateFile(leasePath, { allowMissing: true })) return null;
    return JSON.parse(readFileSync(leasePath, 'utf8'));
  } catch {
    return null;
  }
}

function cleanupOwnedFiles() {
  removeIfOwned(statePath);
  removeIfOwned(leasePath);
}

function removeIfOwned(path) {
  try {
    if (!securePrivateFile(path, { allowMissing: true })) return;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.session_id === sessionId && value.project_root === projectRoot) unlinkSync(path);
  } catch {
    // Missing, malformed, or replaced files are intentionally left untouched.
  }
}

function writePrivateJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  securePrivateFile(temporary);
  renameSync(temporary, path);
  securePrivateFile(path);
}

function parseArgs(raw) {
  const parsed = {};
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index];
    const value = raw[index + 1];
    if (key?.startsWith('--') && value !== undefined) parsed[key.slice(2)] = value;
  }
  return parsed;
}

function abort(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
