#!/usr/bin/env node

import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const roots = [join(homedir(), '.wx-cli'), join(homedir(), '.wechat-dashboard')];

for (const root of roots) harden(root);
console.log('Local reader and Dashboard permissions are restricted to the current user.');

function harden(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to follow symbolic link: ${path}`);
  }
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) harden(join(path, entry));
    return;
  }
  if (stat.isFile() || stat.isSocket()) chmodSync(path, 0o600);
}
