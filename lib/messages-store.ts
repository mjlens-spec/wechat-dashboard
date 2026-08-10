import { createHash } from 'node:crypto';
import { encryptSensitiveText } from './crypto-store';
import { db, secureDatabaseFiles } from './db';
import type { WxMessage } from './wx-types';

const SYSTEM_TYPES = new Set(['系统', 'system']);
const REVOKE_RE = /撤回了一条消息|recalled a message/i;
const MAX_CONTENT_LENGTH = 2_000_000;

export interface MessageInsertResult {
  seen: number;
  inserted: number;
  linkedToHistory: number;
  skipped: number;
}

export interface ExternalMessage {
  sourceMessageId: string;
  sender: string;
  content: string;
  time: string;
  timestamp: number;
  type: string;
  edited?: boolean;
  deleted?: boolean;
  sourceUpdatedAt?: number | null;
}

export interface ConversationSyncState {
  chatroom_id: string;
  last_synced_at: number;
  last_message_timestamp: number;
  coverage_since: number | null;
  coverage_until: number | null;
  backfill_since: number | null;
  backfill_offset: number;
  backfill_complete: number;
  total_messages: number;
  status: 'ok' | 'partial' | 'failed' | 'unsupported' | 'unknown';
  last_error: string | null;
  failed_chunks: number;
  total_chunks: number;
  truncated: number;
}

export function dateOfMessage(message: WxMessage): string {
  if (message.time && message.time.length >= 10) return message.time.slice(0, 10);
  if (message.timestamp) {
    const date = new Date(message.timestamp * 1000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`;
  }
  return 'unknown';
}

export function bulkInsertMessages(
  conversationId: string,
  messages: WxMessage[],
): MessageInsertResult {
  const result: MessageInsertResult = {
    seen: messages.length,
    inserted: 0,
    linkedToHistory: 0,
    skipped: 0,
  };
  if (messages.length === 0) return result;

  const findByLocalId = db().prepare(
    'SELECT message_id FROM messages WHERE chatroom_id = ? AND local_id = ?',
  );
  const findUnlinkedFingerprint = db().prepare(
    `SELECT message_id
     FROM messages
     WHERE chatroom_id = ? AND fingerprint = ? AND local_id IS NULL
     ORDER BY rowid ASC
     LIMIT 1`,
  );
  const linkLocalId = db().prepare(
    'UPDATE messages SET local_id = ? WHERE chatroom_id = ? AND message_id = ?',
  );
  const insert = db().prepare(`
    INSERT OR IGNORE INTO messages (
      chatroom_id, message_id, local_id, fingerprint,
      sender_cipher, content_cipher, time, timestamp, type, date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db().transaction((rows: WxMessage[]) => {
    for (const raw of rows) {
      const message = normalizeMessage(raw);
      if (!message) {
        result.skipped++;
        continue;
      }
      if (SYSTEM_TYPES.has(message.type) && REVOKE_RE.test(message.content)) {
        result.skipped++;
        continue;
      }

      const fingerprint = messageFingerprint(conversationId, message);
      const localId = normalizeLocalId(message.local_id);
      if (localId !== null) {
        if (findByLocalId.get(conversationId, localId)) continue;
        const unlinked = findUnlinkedFingerprint.get(conversationId, fingerprint) as
          | { message_id: string }
          | undefined;
        if (unlinked) {
          linkLocalId.run(localId, conversationId, unlinked.message_id);
          result.linkedToHistory++;
          continue;
        }
      }

      const messageId = localId === null ? `n:${fingerprint}` : `l:${localId}`;
      const inserted = insert.run(
        conversationId,
        messageId,
        localId,
        fingerprint,
        encryptSensitiveText(
          message.sender,
          `message:sender:${conversationId}:${messageId}`,
        ),
        encryptSensitiveText(
          message.content,
          `message:content:${conversationId}:${messageId}`,
        ),
        message.time,
        message.timestamp,
        message.type,
        dateOfMessage(message),
      );
      result.inserted += inserted.changes;
    }
  })(messages);

  secureDatabaseFiles();
  return result;
}

export function bulkUpsertExternalMessages(
  conversationId: string,
  messages: ExternalMessage[],
): MessageInsertResult {
  const result: MessageInsertResult = {
    seen: messages.length,
    inserted: 0,
    linkedToHistory: 0,
    skipped: 0,
  };
  if (messages.length === 0) return result;

  const upsert = db().prepare(`
    INSERT INTO messages (
      chatroom_id, message_id, source_message_id, local_id, fingerprint,
      sender_cipher, content_cipher, time, timestamp, type, date,
      edited, deleted, source_updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chatroom_id, message_id) DO UPDATE SET
      sender_cipher = excluded.sender_cipher,
      content_cipher = excluded.content_cipher,
      time = excluded.time,
      timestamp = excluded.timestamp,
      type = excluded.type,
      date = excluded.date,
      edited = excluded.edited,
      deleted = excluded.deleted,
      source_updated_at = excluded.source_updated_at
  `);

  db().transaction((rows: ExternalMessage[]) => {
    for (const raw of rows) {
      const sourceMessageId = raw.sourceMessageId.trim().slice(0, 512);
      const timestamp = Math.trunc(Number(raw.timestamp));
      if (!sourceMessageId || !Number.isFinite(timestamp) || timestamp <= 0) {
        result.skipped++;
        continue;
      }
      const sender = typeof raw.sender === 'string' ? raw.sender.slice(0, 2_048) : '';
      const originalContent = typeof raw.content === 'string' ? raw.content : '';
      if (originalContent.length > MAX_CONTENT_LENGTH) {
        result.skipped++;
        continue;
      }
      const content = raw.deleted ? '[消息已撤回]' : originalContent;
      const type = typeof raw.type === 'string' ? raw.type.slice(0, 64) : '';
      const time = typeof raw.time === 'string' ? raw.time.slice(0, 64) : '';
      const messageId = `x:${createHash('sha256').update(sourceMessageId).digest('hex')}`;
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([conversationId, sourceMessageId]), 'utf8')
        .digest('hex');
      const existing = db()
        .prepare(
          'SELECT 1 AS found FROM messages WHERE chatroom_id = ? AND source_message_id = ?',
        )
        .get(conversationId, sourceMessageId) as { found: number } | undefined;
      upsert.run(
        conversationId,
        messageId,
        sourceMessageId,
        fingerprint,
        encryptSensitiveText(sender, `message:sender:${conversationId}:${messageId}`),
        encryptSensitiveText(content, `message:content:${conversationId}:${messageId}`),
        time,
        timestamp,
        type,
        dateOfTimestamp(timestamp),
        Number(Boolean(raw.edited)),
        Number(Boolean(raw.deleted)),
        raw.sourceUpdatedAt ?? null,
      );
      if (!existing) result.inserted++;
    }
  })(messages);

  secureDatabaseFiles();
  return result;
}

export function getConversationSyncState(
  conversationId: string,
): ConversationSyncState | null {
  return (
    (db()
      .prepare('SELECT * FROM sync_state WHERE chatroom_id = ?')
      .get(conversationId) as ConversationSyncState | undefined) ?? null
  );
}

export function recordConversationSync(
  conversationId: string,
  patch: {
    status: ConversationSyncState['status'];
    lastError?: string | null;
    failedChunk?: boolean;
    totalChunks?: number;
    truncated?: boolean;
    coverageSince?: number | null;
    coverageUntil?: number | null;
    backfillSince?: number | null;
    backfillOffset?: number;
    backfillComplete?: boolean;
  },
) {
  const current = getConversationSyncState(conversationId);
  const coverageSince = mergeEarlierCoverage(current?.coverage_since ?? null, patch.coverageSince);
  const coverageUntil = Math.max(
    current?.coverage_until ?? 0,
    patch.coverageUntil ?? 0,
  ) || null;
  const summary = db()
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(MAX(timestamp), 0) AS latest
       FROM messages
       WHERE chatroom_id = ?`,
    )
    .get(conversationId) as { total: number; latest: number };

  db()
    .prepare(
      `INSERT INTO sync_state (
         chatroom_id, last_synced_at, last_message_timestamp,
         coverage_since, coverage_until, backfill_since,
         backfill_offset, backfill_complete, total_messages,
         status, last_error, failed_chunks, total_chunks, truncated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chatroom_id) DO UPDATE SET
         last_synced_at = excluded.last_synced_at,
         last_message_timestamp = excluded.last_message_timestamp,
         coverage_since = excluded.coverage_since,
         coverage_until = excluded.coverage_until,
         backfill_since = excluded.backfill_since,
         backfill_offset = excluded.backfill_offset,
         backfill_complete = excluded.backfill_complete,
         total_messages = excluded.total_messages,
         status = excluded.status,
         last_error = excluded.last_error,
         failed_chunks = excluded.failed_chunks,
         total_chunks = excluded.total_chunks,
         truncated = excluded.truncated`,
    )
    .run(
      conversationId,
      Date.now(),
      summary.latest,
      coverageSince,
      coverageUntil,
      patch.backfillSince === undefined
        ? (current?.backfill_since ?? null)
        : patch.backfillSince,
      patch.backfillOffset ?? current?.backfill_offset ?? 0,
      patch.backfillComplete === undefined
        ? (current?.backfill_complete ?? 0)
        : Number(patch.backfillComplete),
      summary.total,
      patch.status,
      patch.lastError ?? null,
      (current?.failed_chunks ?? 0) + Number(Boolean(patch.failedChunk)),
      (current?.total_chunks ?? 0) + (patch.totalChunks ?? 1),
      Number(Boolean(patch.truncated)),
    );
  secureDatabaseFiles();
}

export function latestMessageTimestamp(conversationId: string): number {
  const row = db()
    .prepare(
      'SELECT COALESCE(MAX(timestamp), 0) AS timestamp FROM messages WHERE chatroom_id = ?',
    )
    .get(conversationId) as { timestamp: number };
  return row.timestamp;
}

function normalizeMessage(message: WxMessage): WxMessage | null {
  const timestamp = Number(message.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const content = typeof message.content === 'string' ? message.content : '';
  if (content.length > MAX_CONTENT_LENGTH) return null;
  return {
    local_id: normalizeLocalId(message.local_id) ?? undefined,
    sender: typeof message.sender === 'string' ? message.sender.slice(0, 2_048) : '',
    content,
    time: typeof message.time === 'string' ? message.time.slice(0, 64) : '',
    timestamp: Math.trunc(timestamp),
    type: typeof message.type === 'string' ? message.type.slice(0, 64) : '',
  };
}

function normalizeLocalId(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function dateOfTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function messageFingerprint(conversationId: string, message: WxMessage): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        conversationId,
        message.sender,
        message.content,
        message.time,
        message.timestamp,
        message.type,
      ]),
      'utf8',
    )
    .digest('hex');
}

function mergeEarlierCoverage(
  current: number | null,
  incoming: number | null | undefined,
): number | null {
  if (incoming === undefined || incoming === null) return current;
  if (current === null) return incoming;
  return Math.min(current, incoming);
}
