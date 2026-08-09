#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LABEL = 'com.mjlens.wechat-dashboard';
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

if (!process.argv.includes('--uninstall')) {
  process.stderr.write(
    'Persistent installation is disabled. Use $wechat-dashboard or pnpm session:start.\n',
  );
  process.exit(2);
}

if (process.platform !== 'darwin') {
  process.stderr.write('This cleanup command supports macOS only.\n');
  process.exit(1);
}

const domain = `gui/${process.getuid()}`;
try {
  execFileSync('/bin/launchctl', ['bootout', `${domain}/${LABEL}`], {
    stdio: 'ignore',
  });
} catch {
  // The legacy persistent service was already stopped or absent.
}
if (existsSync(plistPath)) unlinkSync(plistPath);

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'uninstalled',
      summary: 'The legacy persistent WeChat Dashboard service is absent.',
      next_actions: ['Use $wechat-dashboard to start an on-demand session.'],
      artifacts: [],
    },
    null,
    2,
  )}\n`,
);
