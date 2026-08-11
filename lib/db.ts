import Database from 'better-sqlite3';
import { join } from 'node:path';
import { DATA_DIR, secureDataDirectory } from './config';
import { createPrivateFile, securePrivateFile } from './private-paths.mjs';

export const DB_PATH = join(/*turbopackIgnore: true*/ DATA_DIR, 'dashboard.db');
const SCHEMA_VERSION = 6;

let database: Database.Database | null = null;

export function db(): Database.Database {
  if (database) return database;
  secureDataDirectory();
  for (const path of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    securePrivateFile(path, { allowMissing: true });
  }
  if (!securePrivateFile(DB_PATH, { allowMissing: true })) createPrivateFile(DB_PATH);
  database = new Database(DB_PATH);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('secure_delete = ON');
  database.pragma('temp_store = MEMORY');
  migrate(database);
  secureDatabaseFiles();
  return database;
}

export function secureDatabaseFiles() {
  secureDataDirectory();
  for (const path of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    securePrivateFile(path, { allowMissing: true });
  }
}

function migrate(target: Database.Database) {
  rejectPlaintextLegacyDatabase(target);
  createCurrentSchema(target);
  migratePlatformSchema(target);
  target.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function migratePlatformSchema(target: Database.Database) {
  const addColumn = (table: string, column: string, definition: string) => {
    const columns = target.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((entry) => entry.name === column)) {
      target.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  addColumn(
    'conversations',
    'platform',
    "TEXT NOT NULL DEFAULT 'wechat' CHECK (platform IN ('wechat', 'feishu'))",
  );
  addColumn('conversations', 'source_id', "TEXT NOT NULL DEFAULT ''");
  target.exec(`
    UPDATE conversations SET source_id = id WHERE source_id = '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_platform_source
      ON conversations(platform, source_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_platform_type_activity
      ON conversations(platform, chat_type, last_activity DESC);
  `);

  addColumn('messages', 'source_message_id', 'TEXT');
  addColumn('messages', 'edited', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('messages', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('messages', 'source_updated_at', 'INTEGER');
  target.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_id
      ON messages(chatroom_id, source_message_id)
      WHERE source_message_id IS NOT NULL;
  `);

  addColumn('analysis_jobs', 'reasoning_effort', 'TEXT');
  addColumn(
    'group_summaries',
    'reasoning_effort',
    "TEXT NOT NULL DEFAULT 'unknown'",
  );
  addColumn(
    'attention_alerts',
    'reasoning_effort',
    "TEXT NOT NULL DEFAULT 'unknown'",
  );
  addColumn(
    'priority_keywords',
    'platform_scope',
    "TEXT NOT NULL DEFAULT 'all' CHECK (platform_scope IN ('wechat', 'feishu', 'all'))",
  );
}

function rejectPlaintextLegacyDatabase(target: Database.Database) {
  const exists = target
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
    .get() as { found: number } | undefined;
  if (!exists) return;

  const columns = target.prepare('PRAGMA table_info(conversations)').all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === 'name_cipher')) return;

  const conversationCount = (
    target.prepare('SELECT COUNT(*) AS total FROM conversations').get() as { total: number }
  ).total;
  const hasMessages = target
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { found: number } | undefined;
  const messageCount = hasMessages
    ? (target.prepare('SELECT COUNT(*) AS total FROM messages').get() as { total: number }).total
    : 0;

  if (conversationCount > 0 || messageCount > 0) {
    throw new Error(
      '检测到旧版明文 Dashboard 数据库。请先备份并迁移，系统已拒绝继续写入。',
    );
  }

  target.exec(`
    DROP TABLE IF EXISTS daily_stats;
    DROP TABLE IF EXISTS sync_state;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS conversations;
    DROP TABLE IF EXISTS sync_runs;
  `);
}

function createCurrentSchema(target: Database.Database) {
  target.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'wechat'
        CHECK (platform IN ('wechat', 'feishu')),
      source_id TEXT NOT NULL DEFAULT '',
      name_cipher TEXT NOT NULL,
      chat_type TEXT NOT NULL CHECK (chat_type IN ('group', 'private')),
      summary_cipher TEXT NOT NULL DEFAULT '',
      last_sender_cipher TEXT NOT NULL DEFAULT '',
      last_msg_type TEXT NOT NULL DEFAULT '',
      last_time TEXT NOT NULL DEFAULT '',
      last_activity INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 0,
      discovered_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_type_activity
      ON conversations(chat_type, last_activity DESC);

    CREATE TABLE IF NOT EXISTS messages (
      chatroom_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      source_message_id TEXT,
      local_id INTEGER,
      fingerprint TEXT NOT NULL,
      sender_cipher TEXT NOT NULL,
      content_cipher TEXT NOT NULL,
      time TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      edited INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      source_updated_at INTEGER,
      PRIMARY KEY (chatroom_id, message_id),
      FOREIGN KEY (chatroom_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id
      ON messages(chatroom_id, local_id)
      WHERE local_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_fingerprint
      ON messages(chatroom_id, fingerprint);
    CREATE INDEX IF NOT EXISTS idx_messages_chatroom_date
      ON messages(chatroom_id, date);
    CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);

    CREATE TABLE IF NOT EXISTS conversation_preferences (
      chatroom_id TEXT PRIMARY KEY,
      starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (chatroom_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_preferences_starred
      ON conversation_preferences(starred, updated_at DESC);

    CREATE TABLE IF NOT EXISTS priority_keywords (
      id TEXT PRIMARY KEY,
      keyword_cipher TEXT NOT NULL,
      platform_scope TEXT NOT NULL DEFAULT 'all'
        CHECK (platform_scope IN ('wechat', 'feishu', 'all')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      chatroom_id TEXT PRIMARY KEY,
      last_synced_at INTEGER NOT NULL,
      last_message_timestamp INTEGER NOT NULL DEFAULT 0,
      coverage_since INTEGER,
      coverage_until INTEGER,
      backfill_since INTEGER,
      backfill_offset INTEGER NOT NULL DEFAULT 0,
      backfill_complete INTEGER NOT NULL DEFAULT 0,
      total_messages INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      failed_chunks INTEGER NOT NULL DEFAULT 0,
      total_chunks INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (chatroom_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'queued',
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      conversations_seen INTEGER NOT NULL DEFAULT 0,
      conversations_total INTEGER NOT NULL DEFAULT 0,
      conversations_synced INTEGER NOT NULL DEFAULT 0,
      conversations_skipped INTEGER NOT NULL DEFAULT 0,
      failed_conversations INTEGER NOT NULL DEFAULT 0,
      messages_seen INTEGER NOT NULL DEFAULT 0,
      messages_inserted INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      error_code TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at
      ON sync_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS sync_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      run_id INTEGER NOT NULL UNIQUE,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES sync_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analysis_jobs (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('scheduled', 'summaries', 'alerts')),
      day TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'imported', 'expired', 'failed')),
      requested_outputs TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      group_count INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      imported_at INTEGER,
      analysis_model TEXT,
      reasoning_effort TEXT,
      error_code TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_jobs_created_at
      ON analysis_jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status_expires
      ON analysis_jobs(status, expires_at);

    CREATE TABLE IF NOT EXISTS analysis_job_evidence (
      job_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      chatroom_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (job_id, evidence_id),
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (chatroom_id, message_id)
        REFERENCES messages(chatroom_id, message_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_job_evidence_message
      ON analysis_job_evidence(chatroom_id, message_id);

    CREATE TABLE IF NOT EXISTS group_summaries (
      day TEXT NOT NULL,
      chatroom_id TEXT NOT NULL,
      overview_cipher TEXT NOT NULL,
      highlights_cipher TEXT NOT NULL,
      decisions_cipher TEXT NOT NULL,
      action_items_cipher TEXT NOT NULL,
      risks_cipher TEXT NOT NULL,
      evidence_ids TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      analysis_model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL DEFAULT 'unknown',
      generated_at INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      PRIMARY KEY (day, chatroom_id),
      FOREIGN KEY (chatroom_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_group_summaries_day_generated
      ON group_summaries(day, generated_at DESC);

    CREATE TABLE IF NOT EXISTS attention_alerts (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      chatroom_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN (
          'mention', 'customer_emotion', 'urgent',
          'no_response', 'conflict', 'no_solution'
        )
      ),
      severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      title_cipher TEXT NOT NULL,
      detail_cipher TEXT NOT NULL,
      suggested_action_cipher TEXT NOT NULL,
      evidence_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'handled', 'dismissed')),
      analysis_model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL DEFAULT 'unknown',
      first_detected_at INTEGER NOT NULL,
      last_detected_at INTEGER NOT NULL,
      handled_at INTEGER,
      job_id TEXT NOT NULL,
      FOREIGN KEY (chatroom_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_attention_alerts_day_status_severity
      ON attention_alerts(day, status, severity, last_detected_at DESC);

    CREATE TABLE IF NOT EXISTS business_opportunities (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      chatroom_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN (
          'new_demand', 'budget_signal', 'collaboration',
          'upsell', 'referral', 'renewal'
        )
      ),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      title_cipher TEXT NOT NULL,
      detail_cipher TEXT NOT NULL,
      business_value_cipher TEXT NOT NULL,
      suggested_action_cipher TEXT NOT NULL,
      owner_cipher TEXT NOT NULL DEFAULT '',
      due_cipher TEXT NOT NULL DEFAULT '',
      evidence_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'following', 'converted', 'dismissed')),
      analysis_model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL DEFAULT 'unknown',
      first_detected_at INTEGER NOT NULL,
      last_detected_at INTEGER NOT NULL,
      handled_at INTEGER,
      job_id TEXT NOT NULL,
      FOREIGN KEY (chatroom_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_business_opportunities_day_status
      ON business_opportunities(day, status, confidence DESC, last_detected_at DESC);
  `);
}
