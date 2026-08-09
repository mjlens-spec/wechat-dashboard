#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const configured = (process.env.WECHAT_DASHBOARD_WX_BIN || '').trim();
const wrapper = configured || join(process.cwd(), 'node_modules', '.bin', 'wx');
if (configured && !isAbsolute(configured)) {
  throw new Error('WECHAT_DASHBOARD_WX_BIN must be an absolute path');
}
if (!existsSync(wrapper)) throw new Error(`wx executable not found: ${wrapper}`);

let binary = wrapper;
if (!configured) {
  try {
    const wxPackageJson = join(
      process.cwd(),
      'node_modules',
      '@jackwener',
      'wx-cli',
      'package.json',
    );
    binary = join(
      dirname(realpathSync(wxPackageJson)),
      '..',
      'wx-cli-darwin-arm64',
      'bin',
      'wx',
    );
    if (!existsSync(binary)) binary = wrapper;
  } catch {
    binary = wrapper;
  }
}

const version = execFileSync(wrapper, ['--version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
const bytes = readFileSync(binary);
console.log(
  JSON.stringify({
    version,
    binary,
    size: statSync(binary).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }),
);
