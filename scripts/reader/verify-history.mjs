#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const wxBinary = process.argv[2] || 'wx';

function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'sessions', 'messages', 'items']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return null;
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

try {
  const sessionResult = await run(wxBinary, ['sessions', '-n', '50', '--json'], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const sessions = unwrap(JSON.parse(sessionResult.stdout));
  if (!Array.isArray(sessions)) throw new Error('session list unavailable');

  const untilDate = new Date();
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - 6);
  let verified = null;

  for (const session of sessions.slice(0, 12)) {
    if (!session?.username || !['group', 'private'].includes(session.chat_type)) continue;
    try {
      const historyResult = await run(
        wxBinary,
        [
          'history',
          session.username,
          '--since',
          localDate(sinceDate),
          '--until',
          localDate(untilDate),
          '-n',
          '100',
          '--json',
        ],
        { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      );
      const messages = unwrap(JSON.parse(historyResult.stdout));
      if (!Array.isArray(messages)) continue;
      verified = {
        conversation_type: session.chat_type,
        message_count: messages.length,
        newest_timestamp: messages.reduce(
          (latest, message) => Math.max(latest, Number(message?.timestamp) || 0),
          0,
        ),
      };
      if (messages.length > 0) break;
    } catch {
      // Try another recent conversation without exposing its identifier.
    }
  }

  if (!verified) throw new Error('no readable recent conversation found');
  console.log(JSON.stringify(verified));
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown reader error';
  console.error(`History verification failed: ${message}`);
  process.exit(1);
}
