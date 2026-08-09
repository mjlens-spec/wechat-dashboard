import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig } from './config';

const WECHAT_ACCOUNTS_ROOT = join(
  /*turbopackIgnore: true*/ homedir(),
  'Library',
  'Containers',
  'com.tencent.xinWeChat',
  'Data',
  'Documents',
  'xwechat_files',
);

export interface ActiveWeChatAccount {
  accountDirectory: string;
  databaseRoot: string;
  modifiedAt: number;
}

export class WeChatAccountChangedError extends Error {
  readonly code = 'WECHAT_ACCOUNT_CHANGED';

  constructor() {
    super('检测到微信账号目录发生变化，已暂停同步以避免混合账号数据');
    this.name = 'WeChatAccountChangedError';
  }
}

export function detectActiveWeChatAccount(): ActiveWeChatAccount | null {
  let entries;
  try {
    entries = readdirSync(WECHAT_ACCOUNTS_ROOT, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: ActiveWeChatAccount[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes('/') || entry.name.includes('..')) continue;
    const databaseRoot = join(WECHAT_ACCOUNTS_ROOT, entry.name, 'db_storage');
    const sessionDir = join(databaseRoot, 'session');
    const timestamps: number[] = [];
    for (const filename of ['session.db-wal', 'session.db']) {
      try {
        timestamps.push(statSync(join(sessionDir, filename)).mtimeMs);
      } catch {
        // A WAL is optional and an incomplete account directory is ignored below.
      }
    }
    if (timestamps.length === 0) continue;
    candidates.push({
      accountDirectory: entry.name,
      databaseRoot,
      modifiedAt: Math.max(...timestamps),
    });
  }

  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return candidates[0] ?? null;
}

export function pinActiveWeChatAccount(): ActiveWeChatAccount {
  const active = detectActiveWeChatAccount();
  if (!active) throw new WeChatAccountChangedError();
  writeConfig({ accountDirectory: active.accountDirectory });
  return active;
}

export function assertPinnedWeChatAccount(): ActiveWeChatAccount {
  const active = detectActiveWeChatAccount();
  const pinned = readConfig().accountDirectory;
  if (!active || !pinned || active.accountDirectory !== pinned) {
    throw new WeChatAccountChangedError();
  }
  return active;
}
