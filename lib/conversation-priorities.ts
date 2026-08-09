import { randomBytes } from 'node:crypto';
import { decryptSensitiveText, encryptSensitiveText } from './crypto-store';
import { db, secureDatabaseFiles } from './db';
import {
  normalizePriorityKeyword,
  prioritizeGroupRecords,
} from './conversation-priority-policy.mjs';

const MAX_PRIORITY_KEYWORDS = 24;
const MAX_SCANNED_MESSAGES = 10_000;
const MAX_MESSAGE_CORPUS_PER_GROUP = 200_000;
const MAX_RESULTS = 80;

export type PriorityKeyword = { id: string; keyword: string };

export type PriorityGroup = {
  id: string;
  name: string;
  chat_type: 'group';
  summary: string;
  last_sender: string;
  last_time: string;
  last_activity: number;
  unread: number;
  message_count: number;
  starred: boolean;
  matched_keywords: string[];
  search_matched: boolean;
  search_match_location: 'name' | 'message' | 'combined' | null;
  priority_score: number;
};

type EncryptedGroupRow = {
  id: string;
  name_cipher: string;
  summary_cipher: string;
  last_sender_cipher: string;
  last_time: string;
  last_activity: number;
  unread: number;
  message_count: number;
  starred: number;
};

type EncryptedMessageRow = {
  chatroom_id: string;
  message_id: string;
  content_cipher: string;
};

export function prioritySettings() {
  const keywords = listPriorityKeywords();
  const starred = db()
    .prepare('SELECT chatroom_id FROM conversation_preferences WHERE starred = 1')
    .all() as Array<{ chatroom_id: string }>;
  return {
    keywords,
    starred_group_ids: starred.map((row) => row.chatroom_id),
  };
}

export function priorityWorkspace(
  since: string,
  until: string,
  search: string,
) {
  const groupRows = db()
    .prepare(
      `SELECT
         c.id, c.name_cipher, c.summary_cipher, c.last_sender_cipher,
         c.last_time, c.last_activity, c.unread,
         COUNT(m.message_id) AS message_count,
         COALESCE(p.starred, 0) AS starred
       FROM conversations c
       LEFT JOIN messages m
         ON m.chatroom_id = c.id
        AND m.date >= @since
        AND m.date <= @until
       LEFT JOIN conversation_preferences p ON p.chatroom_id = c.id
       WHERE c.chat_type = 'group'
       GROUP BY c.id
       ORDER BY c.last_activity DESC`,
    )
    .all({ since, until }) as EncryptedGroupRow[];

  const keywords = listPriorityKeywords();
  const shouldScanMessages = Boolean(search.trim() || keywords.length > 0);
  const messageRows = shouldScanMessages
    ? (db()
        .prepare(
          `SELECT m.chatroom_id, m.message_id, m.content_cipher
           FROM messages m
           JOIN conversations c ON c.id = m.chatroom_id
           WHERE c.chat_type = 'group' AND m.date >= ? AND m.date <= ?
           ORDER BY m.timestamp DESC
           LIMIT ?`,
        )
        .all(since, until, MAX_SCANNED_MESSAGES) as EncryptedMessageRow[])
    : [];

  const messageCorpus = new Map<string, string>();
  for (const row of messageRows) {
    const current = messageCorpus.get(row.chatroom_id) ?? '';
    if (current.length >= MAX_MESSAGE_CORPUS_PER_GROUP) continue;
    try {
      const content = decryptSensitiveText(
        row.content_cipher,
        `message:content:${row.chatroom_id}:${row.message_id}`,
      );
      messageCorpus.set(
        row.chatroom_id,
        `${current}\n${content}`.slice(0, MAX_MESSAGE_CORPUS_PER_GROUP),
      );
    } catch {
      // A single unreadable message must not hide the rest of the local group index.
    }
  }

  const records = groupRows.map((row) => ({
    id: row.id,
    name: decryptOrPlaceholder(row.name_cipher, `conversation:name:${row.id}`),
    chat_type: 'group' as const,
    summary: decryptOrPlaceholder(row.summary_cipher, `conversation:summary:${row.id}`),
    last_sender: decryptOrPlaceholder(
      row.last_sender_cipher,
      `conversation:last-sender:${row.id}`,
    ),
    last_time: row.last_time,
    last_activity: row.last_activity,
    unread: row.unread,
    message_count: row.message_count,
    messageText: messageCorpus.get(row.id) ?? '',
    messageCount: row.message_count,
    lastActivity: row.last_activity,
    starred: Boolean(row.starred),
  }));
  const prioritized = prioritizeGroupRecords(records, {
    priorityKeywords: keywords,
    search,
    limit: MAX_RESULTS,
  }) as Array<PriorityGroup & { messageText: string; messageCount: number; lastActivity: number }>;
  const groups: PriorityGroup[] = prioritized.map((group) => ({
    id: group.id,
    name: group.name,
    chat_type: group.chat_type,
    summary: group.summary,
    last_sender: group.last_sender,
    last_time: group.last_time,
    last_activity: group.last_activity,
    unread: group.unread,
    message_count: group.message_count,
    starred: group.starred,
    matched_keywords: group.matched_keywords,
    search_matched: group.search_matched,
    search_match_location: group.search_match_location,
    priority_score: group.priority_score,
  }));
  const allPrioritized = prioritizeGroupRecords(records, {
    priorityKeywords: keywords,
    limit: groupRows.length || 1,
  }) as Array<PriorityGroup>;

  return {
    query: search,
    keywords,
    groups,
    counts: {
      total_groups: groupRows.length,
      starred: groupRows.filter((row) => Boolean(row.starred)).length,
      keyword_matched: allPrioritized.filter((row) => row.matched_keywords.length > 0).length,
      results: groups.length,
    },
    message_scan: {
      scanned: messageRows.length,
      truncated: messageRows.length >= MAX_SCANNED_MESSAGES,
    },
  };
}

export function setConversationStarred(chatroomId: string, starred: boolean): boolean {
  const group = db()
    .prepare("SELECT 1 AS found FROM conversations WHERE id = ? AND chat_type = 'group'")
    .get(chatroomId) as { found: number } | undefined;
  if (!group) return false;
  db()
    .prepare(
      `INSERT INTO conversation_preferences (chatroom_id, starred, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chatroom_id) DO UPDATE SET
         starred = excluded.starred,
         updated_at = excluded.updated_at`,
    )
    .run(chatroomId, Number(starred), Date.now());
  secureDatabaseFiles();
  return true;
}

export function addPriorityKeyword(rawKeyword: string): PriorityKeyword {
  const keyword = normalizePriorityKeyword(rawKeyword);
  if (!keyword) throw new Error('INVALID_PRIORITY_KEYWORD');
  const current = listPriorityKeywords();
  const duplicate = current.find(
    (entry) => normalizePriorityKeyword(entry.keyword).toLocaleLowerCase('zh-CN') === keyword.toLocaleLowerCase('zh-CN'),
  );
  if (duplicate) return duplicate;
  if (current.length >= MAX_PRIORITY_KEYWORDS) throw new Error('PRIORITY_KEYWORD_LIMIT');
  const id = `kw_${randomBytes(14).toString('hex')}`;
  db()
    .prepare('INSERT INTO priority_keywords (id, keyword_cipher, created_at) VALUES (?, ?, ?)')
    .run(id, encryptSensitiveText(keyword, `priority-keyword:${id}`), Date.now());
  secureDatabaseFiles();
  return { id, keyword };
}

export function removePriorityKeyword(id: string): boolean {
  const result = db().prepare('DELETE FROM priority_keywords WHERE id = ?').run(id);
  secureDatabaseFiles();
  return result.changes > 0;
}

function listPriorityKeywords(): PriorityKeyword[] {
  const rows = db()
    .prepare('SELECT id, keyword_cipher FROM priority_keywords ORDER BY created_at ASC')
    .all() as Array<{ id: string; keyword_cipher: string }>;
  const keywords: PriorityKeyword[] = [];
  for (const row of rows) {
    try {
      keywords.push({
        id: row.id,
        keyword: decryptSensitiveText(row.keyword_cipher, `priority-keyword:${row.id}`),
      });
    } catch {
      // Ignore a corrupted preference without exposing its ciphertext to the UI.
    }
  }
  return keywords;
}

function decryptOrPlaceholder(ciphertext: string, context: string): string {
  try {
    return decryptSensitiveText(ciphertext, context);
  } catch {
    return '[本机数据无法解密]';
  }
}
