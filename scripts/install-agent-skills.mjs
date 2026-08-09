#!/usr/bin/env node

import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = realpathSync(join(projectRoot, 'skills', 'wechat-dashboard'));
const checkOnly = process.argv.includes('--check');
const codexOnly = process.argv.includes('--codex-only');
const claudeOnly = process.argv.includes('--claude-only');

if (codexOnly && claudeOnly) {
  throw new Error('Choose either --codex-only or --claude-only, not both.');
}

const targets = [
  ...(!claudeOnly
    ? [{ host: 'codex', path: join(homedir(), '.codex', 'skills', 'wechat-dashboard') }]
    : []),
  ...(!codexOnly
    ? [{ host: 'claude-code', path: join(homedir(), '.claude', 'skills', 'wechat-dashboard') }]
    : []),
];

const installations = targets.map((target) => installOrCheck(target.host, target.path));
const ok = installations.every((installation) => installation.status !== 'missing');

process.stdout.write(
  `${JSON.stringify(
    {
      status: ok ? (checkOnly ? 'verified' : 'installed') : 'missing',
      source,
      installations,
    },
    null,
    2,
  )}\n`,
);
if (!ok) process.exitCode = 1;

function installOrCheck(host, targetPath) {
  const existing = safeLstat(targetPath);
  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink Skill path: ${targetPath}`);
    }
    const linked = resolve(dirname(targetPath), readlinkSync(targetPath));
    if (realpathSync(linked) !== source) {
      throw new Error(`Refusing to replace Skill symlink with a different target: ${targetPath}`);
    }
    return { host, path: targetPath, status: 'verified' };
  }

  if (checkOnly) return { host, path: targetPath, status: 'missing' };
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  symlinkSync(source, targetPath, 'dir');
  return { host, path: targetPath, status: 'created' };
}

function safeLstat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
