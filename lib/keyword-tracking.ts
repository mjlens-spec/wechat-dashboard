import { decryptSensitiveText } from './crypto-store';
import { db } from './db';
import { dateList } from './range';
import { listPriorityKeywords, type KeywordSource } from './conversation-priorities';
import type { Platform } from './conversations';

const MAX_SCANNED_MESSAGES = 10_000;
const MAX_VISIBLE_MATCHES = 160;
const MAX_MATCHES_PER_CONVERSATION = 8;
const MAX_EXCERPT_LENGTH = 800;

type EncryptedKeywordMessage = {
  chatroom_id: string;
  message_id: string;
  platform: Platform;
  chat_type: 'group' | 'private';
  name_cipher: string;
  sender_cipher: string;
  content_cipher: string;
  time: string;
  timestamp: number;
  date: string;
};

export type KeywordMatch = {
  message_id: string;
  sender: string;
  content: string;
  time: string;
  timestamp: number;
  date: string;
  matched_in: 'name' | 'message' | 'both';
};

export type KeywordConversation = {
  id: string;
  name: string;
  platform: Platform;
  chat_type: 'group' | 'private';
  match_count: number;
  latest_at: number;
  matches: KeywordMatch[];
};

export function keywordInsight(keywordId: string, since: string, until: string) {
  const keyword = listPriorityKeywords().find((entry) => entry.id === keywordId);
  if (!keyword) return null;

  const rows = db()
    .prepare(
      `SELECT
         m.chatroom_id, m.message_id, m.sender_cipher, m.content_cipher,
         m.time, m.timestamp, m.date,
         c.platform, c.chat_type, c.name_cipher
       FROM messages m
       JOIN conversations c ON c.id = m.chatroom_id
       WHERE m.date >= @since
         AND m.date <= @until
         AND m.deleted = 0
         AND (@source = 'all' OR c.platform = @source)
       ORDER BY m.timestamp DESC
       LIMIT @limit`,
    )
    .all({
      since,
      until,
      source: keyword.source,
      limit: MAX_SCANNED_MESSAGES,
    }) as EncryptedKeywordMessage[];

  const needle = normalizeText(keyword.keyword);
  const names = new Map<string, string>();
  const conversations = new Map<string, KeywordConversation>();
  const daily = new Map<string, { date: string; wechat: number; feishu: number; total: number }>();
  let totalMatches = 0;
  let visibleMatches = 0;
  let wechatMatches = 0;
  let feishuMatches = 0;

  for (const row of rows) {
    let name = names.get(row.chatroom_id);
    if (name === undefined) {
      name = decryptOrPlaceholder(
        row.name_cipher,
        `conversation:name:${row.chatroom_id}`,
      );
      names.set(row.chatroom_id, name);
    }

    const content = decryptOrNull(
      row.content_cipher,
      `message:content:${row.chatroom_id}:${row.message_id}`,
    );
    if (content === null) continue;
    const nameMatched = normalizeText(name).includes(needle);
    const messageMatched = normalizeText(content).includes(needle);
    if (!nameMatched && !messageMatched) continue;

    totalMatches += 1;
    if (row.platform === 'wechat') wechatMatches += 1;
    else feishuMatches += 1;
    const day = daily.get(row.date) ?? {
      date: row.date,
      wechat: 0,
      feishu: 0,
      total: 0,
    };
    day[row.platform] += 1;
    day.total += 1;
    daily.set(row.date, day);

    const conversation = conversations.get(row.chatroom_id) ?? {
      id: row.chatroom_id,
      name,
      platform: row.platform,
      chat_type: row.chat_type,
      match_count: 0,
      latest_at: row.timestamp,
      matches: [],
    };
    conversation.match_count += 1;
    conversation.latest_at = Math.max(conversation.latest_at, row.timestamp);

    if (
      visibleMatches < MAX_VISIBLE_MATCHES &&
      conversation.matches.length < MAX_MATCHES_PER_CONVERSATION
    ) {
      const sender = decryptOrPlaceholder(
        row.sender_cipher,
        `message:sender:${row.chatroom_id}:${row.message_id}`,
      );
      conversation.matches.push({
        message_id: row.message_id,
        sender,
        content: content.slice(0, MAX_EXCERPT_LENGTH),
        time: row.time,
        timestamp: row.timestamp,
        date: row.date,
        matched_in:
          nameMatched && messageMatched ? 'both' : nameMatched ? 'name' : 'message',
      });
      visibleMatches += 1;
    }
    conversations.set(row.chatroom_id, conversation);
  }

  const trend = dateList(since, until).map(
    (date) => daily.get(date) ?? { date, wechat: 0, feishu: 0, total: 0 },
  );
  const conversationList = Array.from(conversations.values()).sort(
    (left, right) =>
      right.match_count - left.match_count || right.latest_at - left.latest_at,
  );

  return {
    keyword,
    window: { since, until, days: trend.length },
    counts: {
      matches: totalMatches,
      conversations: conversationList.length,
      wechat: wechatMatches,
      feishu: feishuMatches,
    },
    trend,
    conversations: conversationList,
    message_scan: {
      scanned: rows.length,
      truncated: rows.length >= MAX_SCANNED_MESSAGES,
      visible_matches: visibleMatches,
      result_truncated: totalMatches > visibleMatches,
    },
  };
}

export function keywordSourceLabel(source: KeywordSource) {
  return source === 'wechat' ? '微信' : source === 'feishu' ? '飞书' : '微信 + 飞书';
}

function normalizeText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function decryptOrNull(ciphertext: string, context: string): string | null {
  try {
    return decryptSensitiveText(ciphertext, context);
  } catch {
    return null;
  }
}

function decryptOrPlaceholder(ciphertext: string, context: string): string {
  return decryptOrNull(ciphertext, context) ?? '[本机数据无法解密]';
}
