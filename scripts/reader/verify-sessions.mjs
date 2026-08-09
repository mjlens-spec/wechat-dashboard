#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const wxBinary = process.argv[2] || 'wx';

try {
  const { stdout } = await run(wxBinary, ['sessions', '-n', '1000', '--json'], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const payload = JSON.parse(stdout);
  const sessions = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.sessions)
        ? payload.sessions
        : null;
  if (!sessions) {
    const keys = payload && typeof payload === 'object' ? Object.keys(payload).join(',') : 'none';
    throw new Error(`sessions array missing; top-level keys: ${keys}`);
  }
  const result = {
    total: sessions.length,
    groups: sessions.filter((session) => session?.is_group === true).length,
    private: sessions.filter((session) => session?.chat_type === 'private').length,
    newest_timestamp: sessions.reduce(
      (latest, session) => Math.max(latest, Number(session?.timestamp) || 0),
      0,
    ),
  };
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown reader error';
  console.error(`Reader verification failed: ${message}`);
  process.exit(1);
}
