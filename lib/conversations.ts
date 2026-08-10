import { decryptSensitiveText, encryptSensitiveText } from './crypto-store';
import { db, secureDatabaseFiles } from './db';
import { dateList } from './range';
import type { WxNewMessage, WxSession } from './wx-types';

export type ConversationType = 'group' | 'private';
export type ConversationFilter = 'all' | ConversationType;
export type Platform = 'wechat' | 'feishu';
export type PlatformFilter = 'all' | Platform;
export type SyncRunStatus = 'running' | 'ok' | 'partial' | 'failed';

const SYNC_LOCK_STALE_MS = 3 * 60 * 1000;

export interface DashboardConversation {
  id: string;
  platform: Platform;
  name: string;
  chat_type: ConversationType;
  summary: string;
  last_sender: string;
  last_time: string;
  last_activity: number;
  unread: number;
  message_count: number;
}

export interface SyncRunRow {
  id: number;
  mode: string;
  status: SyncRunStatus;
  phase: string;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
  conversations_seen: number;
  conversations_total: number;
  conversations_synced: number;
  conversations_skipped: number;
  failed_conversations: number;
  messages_seen: number;
  messages_inserted: number;
  truncated: number;
  error_code: string | null;
}

export interface SyncRunProgressPatch {
  phase?: string;
  conversationsSeen?: number;
  conversationsTotal?: number;
  conversationsSynced?: number;
  conversationsSkipped?: number;
  failedConversations?: number;
  messagesSeen?: number;
  messagesInserted?: number;
  truncated?: boolean;
  errorCode?: string | null;
}

export interface CoverageSnapshot {
  metadata: { total: number; updated_at: number | null };
  recent: { since: number; total: number; complete: number; truncated: number; unsupported: number };
  today: { since: number; total: number; complete: number; truncated: number; unsupported: number };
  history: { status: 'not_started' };
}

export function upsertConversations(sessions: WxSession[]) {
  const now = Date.now();
  const statement = db().prepare(`
    INSERT INTO conversations (
      id, platform, source_id, name_cipher, chat_type, summary_cipher, last_sender_cipher,
      last_msg_type, last_time, last_activity, unread, discovered_at, updated_at
    ) VALUES (?, 'wechat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name_cipher = excluded.name_cipher,
      chat_type = excluded.chat_type,
      summary_cipher = excluded.summary_cipher,
      last_sender_cipher = excluded.last_sender_cipher,
      last_msg_type = excluded.last_msg_type,
      last_time = excluded.last_time,
      last_activity = excluded.last_activity,
      unread = excluded.unread,
      updated_at = excluded.updated_at
  `);

  db().transaction((rows: WxSession[]) => {
    for (const session of rows) {
      const id = session.username;
      const chatType: ConversationType =
        session.chat_type === 'group' || session.is_group ? 'group' : 'private';
      statement.run(
        id,
        id,
        encryptSensitiveText(session.chat || id, `conversation:name:${id}`),
        chatType,
        encryptSensitiveText(session.summary ?? '', `conversation:summary:${id}`),
        encryptSensitiveText(
          session.last_sender ?? '',
          `conversation:last-sender:${id}`,
        ),
        session.last_msg_type ?? '',
        session.time ?? '',
        session.timestamp ?? 0,
        session.unread ?? 0,
        now,
        now,
      );
    }
  })(sessions);
  secureDatabaseFiles();
}

export interface PlatformConversationInput {
  sourceId: string;
  name?: string;
  chatType: ConversationType;
  summary?: string;
  lastSender?: string;
  lastMessageType?: string;
  lastTime?: string;
  lastActivity?: number;
  unread?: number;
}

export function upsertPlatformConversations(
  platform: Platform,
  rows: PlatformConversationInput[],
) {
  const now = Date.now();
  const existingName = db().prepare(
    'SELECT name_cipher FROM conversations WHERE id = ?',
  );
  const statement = db().prepare(`
    INSERT INTO conversations (
      id, platform, source_id, name_cipher, chat_type, summary_cipher,
      last_sender_cipher, last_msg_type, last_time, last_activity, unread,
      discovered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name_cipher = excluded.name_cipher,
      chat_type = excluded.chat_type,
      summary_cipher = CASE
        WHEN excluded.summary_cipher = '' THEN conversations.summary_cipher
        ELSE excluded.summary_cipher
      END,
      last_sender_cipher = CASE
        WHEN excluded.last_sender_cipher = '' THEN conversations.last_sender_cipher
        ELSE excluded.last_sender_cipher
      END,
      last_msg_type = CASE
        WHEN excluded.last_msg_type = '' THEN conversations.last_msg_type
        ELSE excluded.last_msg_type
      END,
      last_time = CASE
        WHEN excluded.last_time = '' THEN conversations.last_time
        ELSE excluded.last_time
      END,
      last_activity = MAX(conversations.last_activity, excluded.last_activity),
      unread = excluded.unread,
      updated_at = excluded.updated_at
  `);
  db().transaction((items: PlatformConversationInput[]) => {
    for (const row of items) {
      const sourceId = row.sourceId.trim().slice(0, 512);
      if (!sourceId) continue;
      const id = platform === 'wechat' ? sourceId : `${platform}:${sourceId}`;
      const prior = existingName.get(id) as { name_cipher: string } | undefined;
      const name = row.name?.trim();
      const nameCipher = name
        ? encryptSensitiveText(name, `conversation:name:${id}`)
        : (prior?.name_cipher ??
          encryptSensitiveText(
            platform === 'feishu' ? '飞书会话' : sourceId,
            `conversation:name:${id}`,
          ));
      statement.run(
        id,
        platform,
        sourceId,
        nameCipher,
        row.chatType,
        encryptSensitiveText(row.summary ?? '', `conversation:summary:${id}`),
        encryptSensitiveText(row.lastSender ?? '', `conversation:last-sender:${id}`),
        row.lastMessageType ?? '',
        row.lastTime ?? '',
        row.lastActivity ?? 0,
        row.unread ?? 0,
        now,
        now,
      );
    }
  })(rows);
  secureDatabaseFiles();
}

export function upsertConversationsFromNewMessages(messages: WxNewMessage[]) {
  const latest = new Map<string, WxNewMessage>();
  for (const message of messages) {
    if (!message?.username) continue;
    const current = latest.get(message.username);
    if (!current || (message.timestamp ?? 0) >= (current.timestamp ?? 0)) {
      latest.set(message.username, message);
    }
  }
  upsertConversations(
    Array.from(latest.values()).map((message) => ({
      username: message.username,
      chat: message.chat || message.username,
      chat_type: message.chat_type,
      is_group: message.is_group,
      last_msg_type: message.type,
      last_sender: message.sender,
      summary: message.content,
      time: message.time,
      timestamp: message.timestamp,
      unread: 0,
    })),
  );
}

export function getLatestSyncRun(): SyncRunRow | null {
  return getSyncRunByQuery('ORDER BY id DESC LIMIT 1');
}

export function getSyncRun(id: number): SyncRunRow | null {
  return getSyncRunByQuery('WHERE id = @id', { id });
}

export function getLatestSuccessfulSyncRun(): SyncRunRow | null {
  return getSyncRunByQuery("WHERE status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1");
}

export function beginSyncRun(mode: string): { runId: number; started: boolean } {
  const now = Date.now();
  const transaction = db().transaction(() => {
    const lock = db()
      .prepare(
        `SELECT l.run_id, l.heartbeat_at, r.status
         FROM sync_lock l
         JOIN sync_runs r ON r.id = l.run_id
         WHERE l.id = 1`,
      )
      .get() as
      | { run_id: number; heartbeat_at: number; status: SyncRunStatus }
      | undefined;

    if (lock && lock.status === 'running' && now - lock.heartbeat_at <= SYNC_LOCK_STALE_MS) {
      return { runId: lock.run_id, started: false };
    }

    if (lock) {
      db()
        .prepare(
          `UPDATE sync_runs
           SET status = 'failed', phase = 'interrupted', completed_at = ?, updated_at = ?,
               error_code = 'SYNC_INTERRUPTED'
           WHERE id = ? AND status = 'running'`,
        )
        .run(now, now, lock.run_id);
      db().prepare('DELETE FROM sync_lock WHERE id = 1').run();
    }

    const inserted = db()
      .prepare(
        `INSERT INTO sync_runs (mode, status, phase, started_at, updated_at)
         VALUES (?, 'running', 'queued', ?, ?)`,
      )
      .run(mode, now, now);
    const runId = Number(inserted.lastInsertRowid);
    db()
      .prepare(
        'INSERT INTO sync_lock (id, run_id, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?)',
      )
      .run(runId, now, now);
    return { runId, started: true };
  });
  const result = transaction();
  secureDatabaseFiles();
  return result;
}

export function updateSyncRun(id: number, patch: SyncRunProgressPatch) {
  const current = getSyncRun(id);
  if (!current || current.status !== 'running') return;
  const now = Date.now();
  db()
    .prepare(
      `UPDATE sync_runs SET
         phase = ?, updated_at = ?, conversations_seen = ?, conversations_total = ?,
         conversations_synced = ?, conversations_skipped = ?, failed_conversations = ?,
         messages_seen = ?, messages_inserted = ?, truncated = ?, error_code = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(
      patch.phase ?? current.phase,
      now,
      patch.conversationsSeen ?? current.conversations_seen,
      patch.conversationsTotal ?? current.conversations_total,
      patch.conversationsSynced ?? current.conversations_synced,
      patch.conversationsSkipped ?? current.conversations_skipped,
      patch.failedConversations ?? current.failed_conversations,
      patch.messagesSeen ?? current.messages_seen,
      patch.messagesInserted ?? current.messages_inserted,
      patch.truncated === undefined ? current.truncated : Number(patch.truncated),
      patch.errorCode === undefined ? current.error_code : patch.errorCode,
      id,
    );
  db().prepare('UPDATE sync_lock SET heartbeat_at = ? WHERE run_id = ?').run(now, id);
  secureDatabaseFiles();
}

export function finishSyncRun(
  id: number,
  status: Exclude<SyncRunStatus, 'running'>,
  patch: SyncRunProgressPatch = {},
) {
  updateSyncRun(id, { ...patch, phase: status === 'failed' ? 'failed' : 'complete' });
  const now = Date.now();
  db()
    .prepare(
      `UPDATE sync_runs
       SET status = ?, phase = ?, completed_at = ?, updated_at = ?, error_code = ?
       WHERE id = ?`,
    )
    .run(
      status,
      status === 'failed' ? 'failed' : 'complete',
      now,
      now,
      patch.errorCode ?? getSyncRun(id)?.error_code ?? null,
      id,
    );
  db().prepare('DELETE FROM sync_lock WHERE run_id = ?').run(id);
  secureDatabaseFiles();
}

export function syncInProgress(): boolean {
  const lock = db()
    .prepare('SELECT heartbeat_at FROM sync_lock WHERE id = 1')
    .get() as { heartbeat_at: number } | undefined;
  return Boolean(lock && Date.now() - lock.heartbeat_at <= SYNC_LOCK_STALE_MS);
}

export function setAppState(key: string, value: string) {
  db()
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
  secureDatabaseFiles();
}

export function getAppStateNumber(key: string): number | null {
  const row = db().prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? value : null;
}

export function pendingBackfillConversations(since: number, limit: number) {
  return db()
    .prepare(
      `SELECT c.id, c.last_activity,
              COALESCE(s.backfill_offset, 0) AS backfill_offset,
              s.backfill_since
       FROM conversations c
       LEFT JOIN sync_state s ON s.chatroom_id = c.id
       WHERE c.platform = 'wechat'
         AND c.last_activity >= @since
         AND COALESCE(s.status, '') != 'unsupported'
         AND (
           s.coverage_since IS NULL OR s.coverage_since > @since OR
           s.backfill_since IS NULL OR s.backfill_since != @since OR
           s.backfill_complete = 0
         )
       ORDER BY
         CASE WHEN s.backfill_offset > 0 THEN 0 ELSE 1 END,
         CASE WHEN c.chat_type = 'group' THEN 0 ELSE 1 END,
         c.last_activity DESC
       LIMIT @limit`,
    )
    .all({ since, limit }) as Array<{
    id: string;
    last_activity: number;
    backfill_offset: number;
    backfill_since: number | null;
  }>;
}

export function conversationsMissingCoverage(since: number, limit: number) {
  return db()
    .prepare(
      `SELECT c.id, c.chat_type, c.last_activity
       FROM conversations c
       LEFT JOIN sync_state s ON s.chatroom_id = c.id
       WHERE c.platform = 'wechat'
         AND c.last_activity >= @since
         AND COALESCE(s.status, '') != 'unsupported'
         AND (s.coverage_since IS NULL OR s.coverage_since > @since OR s.truncated = 1)
       ORDER BY
         CASE WHEN c.chat_type = 'group' THEN 0 ELSE 1 END,
         c.last_activity DESC
       LIMIT @limit`,
    )
    .all({ since, limit }) as Array<{
    id: string;
    chat_type: ConversationType;
    last_activity: number;
  }>;
}

export function conversationsNeedingReconcile(limit: number, recentFloor: number) {
  return db()
    .prepare(
      `SELECT c.id, c.last_activity, COALESCE(s.last_message_timestamp, 0) AS local_timestamp
       FROM conversations c
       LEFT JOIN sync_state s ON s.chatroom_id = c.id
       WHERE c.platform = 'wechat'
         AND COALESCE(s.status, '') != 'unsupported'
         AND c.last_activity > COALESCE(s.last_message_timestamp, 0)
         AND (
           COALESCE(s.last_message_timestamp, 0) > 0 OR
           c.last_activity >= @recentFloor
         )
       ORDER BY
         CASE WHEN c.chat_type = 'group' THEN 0 ELSE 1 END,
         c.last_activity DESC
       LIMIT @limit`,
    )
    .all({ limit, recentFloor }) as Array<{
    id: string;
    last_activity: number;
    local_timestamp: number;
  }>;
}

export function conversationLookup(conversationId: string): {
  name: string | null;
  chatType: ConversationType;
  platform: Platform;
} | null {
  const row = db()
    .prepare('SELECT name_cipher, chat_type, platform FROM conversations WHERE id = ?')
    .get(conversationId) as
    | { name_cipher: string; chat_type: ConversationType; platform: Platform }
    | undefined;
  if (!row) return null;
  try {
    return {
      name: decryptSensitiveText(row.name_cipher, `conversation:name:${conversationId}`),
      chatType: row.chat_type,
      platform: row.platform,
    };
  } catch {
    return { name: null, chatType: row.chat_type, platform: row.platform };
  }
}

export function coverageSnapshot(
  now = new Date(),
  platform: PlatformFilter = 'all',
): CoverageSnapshot {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const recentSince = nowSeconds - 2 * 60 * 60;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todaySince = Math.floor(today.getTime() / 1000);

  const metadata = db()
    .prepare(
      `SELECT COUNT(*) AS total, MAX(updated_at) AS updated_at
       FROM conversations
       WHERE (@platform = 'all' OR platform = @platform)`,
    )
    .get({ platform }) as { total: number; updated_at: number | null };
  return {
    metadata,
    recent: coverageBucket(recentSince, platform),
    today: coverageBucket(todaySince, platform),
    history: { status: 'not_started' },
  };
}

export function dashboardSnapshot(
  since: string,
  until: string,
  filter: ConversationFilter,
  platform: PlatformFilter = 'all',
) {
  const params = { since, until, filter, platform };

  const totals = db()
    .prepare(
      `SELECT
         COUNT(*) AS total_conversations,
         SUM(CASE WHEN c.chat_type = 'group' THEN 1 ELSE 0 END) AS total_groups,
         SUM(CASE WHEN c.chat_type = 'private' THEN 1 ELSE 0 END) AS total_private
       FROM conversations c
       WHERE (@platform = 'all' OR c.platform = @platform)
         AND (@filter = 'all' OR c.chat_type = @filter)`,
    )
    .get(params) as {
    total_conversations: number;
    total_groups: number | null;
    total_private: number | null;
  };

  const activity = db()
    .prepare(
      `SELECT
         COUNT(*) AS total_messages,
         COUNT(DISTINCT m.chatroom_id) AS active_conversations,
         COUNT(DISTINCT CASE WHEN c.chat_type = 'group' THEN m.chatroom_id END) AS active_groups,
         COUNT(DISTINCT CASE WHEN c.chat_type = 'private' THEN m.chatroom_id END) AS active_private
       FROM messages m
       JOIN conversations c ON c.id = m.chatroom_id
       WHERE m.date >= @since AND m.date <= @until
         AND (@platform = 'all' OR c.platform = @platform)
         AND (@filter = 'all' OR c.chat_type = @filter)`,
    )
    .get(params) as {
    total_messages: number;
    active_conversations: number;
    active_groups: number;
    active_private: number;
  };

  const trendRows = db()
    .prepare(
      `SELECT
         m.date AS date,
         SUM(CASE WHEN c.chat_type = 'group' THEN 1 ELSE 0 END) AS group_count,
         SUM(CASE WHEN c.chat_type = 'private' THEN 1 ELSE 0 END) AS private_count
       FROM messages m
       JOIN conversations c ON c.id = m.chatroom_id
       WHERE m.date >= @since AND m.date <= @until
         AND (@platform = 'all' OR c.platform = @platform)
         AND (@filter = 'all' OR c.chat_type = @filter)
       GROUP BY m.date
       ORDER BY m.date ASC`,
    )
    .all(params) as Array<{ date: string; group_count: number; private_count: number }>;
  const trendByDate = new Map(trendRows.map((row) => [row.date, row]));
  const trend = dateList(since, until).map((date) => ({
    date,
    groups: trendByDate.get(date)?.group_count ?? 0,
    private: trendByDate.get(date)?.private_count ?? 0,
  }));

  const encrypted = db()
    .prepare(
      `SELECT
         c.id, c.platform, c.name_cipher, c.chat_type, c.summary_cipher,
         c.last_sender_cipher, c.last_time, c.last_activity, c.unread,
         COUNT(m.message_id) AS message_count
       FROM conversations c
       LEFT JOIN messages m
         ON m.chatroom_id = c.id
        AND m.date >= @since
        AND m.date <= @until
       WHERE (@platform = 'all' OR c.platform = @platform)
         AND (@filter = 'all' OR c.chat_type = @filter)
       GROUP BY c.id
       ORDER BY
         CASE WHEN c.chat_type = 'group' THEN 0 ELSE 1 END,
         message_count DESC,
         c.last_activity DESC
       LIMIT 40`,
    )
    .all(params) as Array<{
    id: string;
    platform: Platform;
    name_cipher: string;
    chat_type: ConversationType;
    summary_cipher: string;
    last_sender_cipher: string;
    last_time: string;
    last_activity: number;
    unread: number;
    message_count: number;
  }>;

  const conversations: DashboardConversation[] = encrypted.map((row) => ({
    id: row.id,
    platform: row.platform,
    name: decryptOrPlaceholder(row.name_cipher, `conversation:name:${row.id}`),
    chat_type: row.chat_type,
    summary: decryptOrPlaceholder(row.summary_cipher, `conversation:summary:${row.id}`),
    last_sender: decryptOrPlaceholder(
      row.last_sender_cipher,
      `conversation:last-sender:${row.id}`,
    ),
    last_time: row.last_time,
    last_activity: row.last_activity,
    unread: row.unread,
    message_count: row.message_count,
  }));

  return {
    cards: {
      total_messages: activity.total_messages,
      active_conversations: activity.active_conversations,
      active_groups: activity.active_groups,
      total_groups: totals.total_groups ?? 0,
      active_private: activity.active_private,
      total_private: totals.total_private ?? 0,
      total_conversations: totals.total_conversations,
    },
    trend,
    conversations,
  };
}

function coverageBucket(since: number, platform: PlatformFilter) {
  const row = db()
    .prepare(
      `SELECT
         SUM(CASE WHEN COALESCE(s.status, '') != 'unsupported' THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN s.coverage_since <= @since AND s.truncated = 0 THEN 1 ELSE 0 END) AS complete,
         SUM(CASE WHEN s.truncated = 1 AND COALESCE(s.status, '') != 'unsupported' THEN 1 ELSE 0 END) AS truncated,
         SUM(CASE WHEN s.status = 'unsupported' THEN 1 ELSE 0 END) AS unsupported
       FROM conversations c
       LEFT JOIN sync_state s ON s.chatroom_id = c.id
       WHERE c.last_activity >= @since
         AND (@platform = 'all' OR c.platform = @platform)`,
    )
    .get({ since, platform }) as {
    total: number | null;
    complete: number | null;
    truncated: number | null;
    unsupported: number | null;
  };
  return {
    since,
    total: row.total ?? 0,
    complete: row.complete ?? 0,
    truncated: row.truncated ?? 0,
    unsupported: row.unsupported ?? 0,
  };
}

function getSyncRunByQuery(
  suffix: string,
  params: Record<string, unknown> = {},
): SyncRunRow | null {
  return (
    (db()
      .prepare(
        `SELECT id, mode, status, phase, started_at, updated_at, completed_at,
                conversations_seen, conversations_total, conversations_synced,
                conversations_skipped, failed_conversations, messages_seen,
                messages_inserted, truncated, error_code
         FROM sync_runs ${suffix}`,
      )
      .get(params) as SyncRunRow | undefined) ?? null
  );
}

function decryptOrPlaceholder(ciphertext: string, context: string): string {
  try {
    return decryptSensitiveText(ciphertext, context);
  } catch {
    return '[本机数据无法解密]';
  }
}
