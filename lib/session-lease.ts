import {
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DATA_DIR, secureDataDirectory } from './config';
import { securePrivateFile } from './private-paths.mjs';
import { isActiveManagedLease } from './session-lease-policy.mjs';

const VIEWER_LEASE_MS = 3 * 60 * 1000;
const leasePath = join(/*turbopackIgnore: true*/ DATA_DIR, 'session-lease.json');
const statePath = join(/*turbopackIgnore: true*/ DATA_DIR, 'session-service.json');

type SessionLease = {
  version: 1;
  session_id: string;
  project_root: string;
  created_at: number;
  skill_expires_at: number;
  expires_at: number;
  last_skill_heartbeat_at: number;
  last_viewer_heartbeat_at: number | null;
};

type SessionState = {
  version: 1;
  session_id: string;
  project_root: string;
};

export function heartbeatViewerSession(now = Date.now()) {
  secureDataDirectory();
  const lease = readJson<SessionLease>(leasePath);
  const state = readJson<SessionState>(statePath);
  const projectRoot = resolve(
    /*turbopackIgnore: true*/ process.env.WECHAT_DASHBOARD_PROJECT_ROOT || process.cwd(),
  );
  if (!lease || !state || !isActiveManagedLease(lease, state, projectRoot, now)) {
    return { managed: false as const, expires_at: null };
  }

  const updated: SessionLease = {
    ...lease,
    expires_at: Math.min(lease.skill_expires_at, now + VIEWER_LEASE_MS),
    last_viewer_heartbeat_at: now,
  };
  writePrivateJsonAtomic(leasePath, updated);
  return { managed: true as const, expires_at: updated.expires_at };
}

function readJson<T>(path: string): T | null {
  try {
    if (!securePrivateFile(path, { allowMissing: true })) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writePrivateJsonAtomic(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  securePrivateFile(temporary);
  renameSync(temporary, path);
  securePrivateFile(path);
}
