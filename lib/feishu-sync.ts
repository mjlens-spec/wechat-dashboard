import {
  getAppStateNumber,
  setAppState,
  upsertPlatformConversations,
  type ConversationType,
  type PlatformConversationInput,
} from './conversations';
import {
  feishuChats,
  feishuErrorCode,
  feishuMessages,
} from './feishu';
import { resolveFeishuSyncCompletion } from './feishu-sync-policy.mjs';
import {
  bulkUpsertExternalMessages,
  recordConversationSync,
  type ExternalMessage,
} from './messages-store';

const METADATA_INTERVAL_MS = 6 * 60 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;

export interface FeishuSyncResult {
  conversationsSeen: number;
  conversationsSynced: number;
  messagesSeen: number;
  messagesInserted: number;
  truncated: boolean;
  errorCode: string | null;
}

export async function syncFeishu(): Promise<FeishuSyncResult> {
  const result: FeishuSyncResult = {
    conversationsSeen: 0,
    conversationsSynced: 0,
    messagesSeen: 0,
    messagesInserted: 0,
    truncated: false,
    errorCode: null,
  };
  try {
    const now = Date.now();
    const metadataAt = getAppStateNumber('feishu_metadata_at') ?? 0;
    if (now - metadataAt >= METADATA_INTERVAL_MS) {
      const chats = await feishuChats();
      upsertPlatformConversations(
        'feishu',
        chats.items.map((chat) => ({
          sourceId: chat.chat_id,
          name: chat.name?.trim() || '飞书会话',
          chatType: normalizeChatType(chat.chat_mode),
        })),
      );
      result.conversationsSeen = chats.items.length;
      result.truncated ||= chats.hasMore;
      if (!chats.hasMore) setAppState('feishu_metadata_at', String(now));
    }

    const lastSuccess = getAppStateNumber('feishu_last_success_at');
    const startMs = Math.max(startOfTodayMs(), (lastSuccess ?? startOfTodayMs()) - OVERLAP_MS);
    const page = await feishuMessages(feishuIso(startMs), feishuIso(now));
    result.messagesSeen = page.items.length;
    result.truncated ||= page.hasMore;

    const latestByChat = new Map<string, PlatformConversationInput>();
    const grouped = new Map<string, ExternalMessage[]>();
    for (const message of page.items) {
      const timestamp = normalizeTimestamp(message.create_time);
      if (!timestamp) continue;
      const sourceId = message.chat_id;
      const conversationId = `feishu:${sourceId}`;
      const sender = senderName(message.sender);
      const content = readableContent(message.content ?? '');
      const chatType = normalizeChatType(message.chat_type);
      const previous = latestByChat.get(sourceId);
      if (!previous || timestamp >= (previous.lastActivity ?? 0)) {
        latestByChat.set(sourceId, {
          sourceId,
          name: message.chat_name?.trim() || partnerName(message.chat_partner) || '',
          chatType,
          summary: message.deleted ? '[消息已撤回]' : content,
          lastSender: sender,
          lastMessageType: message.msg_type ?? '',
          lastTime: localTime(timestamp),
          lastActivity: timestamp,
        });
      }
      const rows = grouped.get(conversationId) ?? [];
      rows.push({
        sourceMessageId: message.message_id,
        sender,
        content,
        time: localTime(timestamp),
        timestamp,
        type: message.msg_type ?? '',
        edited: Boolean(message.updated),
        deleted: Boolean(message.deleted),
        sourceUpdatedAt: normalizeTimestamp(message.update_time),
      });
      grouped.set(conversationId, rows);
    }

    upsertPlatformConversations('feishu', Array.from(latestByChat.values()));
    result.conversationsSeen = Math.max(result.conversationsSeen, latestByChat.size);
    const coverageSince = Math.floor(startMs / 1000);
    const coverageUntil = Math.floor(now / 1000);
    for (const [conversationId, messages] of grouped) {
      const inserted = bulkUpsertExternalMessages(conversationId, messages);
      result.messagesInserted += inserted.inserted;
      result.conversationsSynced++;
      recordConversationSync(conversationId, {
        status: page.hasMore ? 'partial' : 'ok',
        coverageSince,
        coverageUntil,
        truncated: page.hasMore,
      });
    }
    const completion = resolveFeishuSyncCompletion({
      truncated: result.truncated,
      attemptedAt: now,
      previousSuccessAt: lastSuccess,
    });
    if (!completion.complete) {
      result.errorCode = completion.errorCode ?? 'FEISHU_RESULT_TRUNCATED';
      setAppState('feishu_last_error', result.errorCode);
    } else {
      setAppState('feishu_last_success_at', String(completion.lastSuccessAt));
      setAppState('feishu_last_error', '');
    }
    return result;
  } catch (error) {
    const errorCode = feishuErrorCode(error);
    setAppState('feishu_last_error', errorCode);
    return { ...result, errorCode };
  }
}

function normalizeChatType(value: string | undefined): ConversationType {
  return value === 'p2p' ? 'private' : 'group';
}

function normalizeTimestamp(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : null;
}

function senderName(value: unknown): string {
  const record = asRecord(value);
  return typeof record.name === 'string' ? record.name : '';
}

function partnerName(value: unknown): string {
  const record = asRecord(value);
  return typeof record.name === 'string' ? record.name : '';
}

function readableContent(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const fragments: string[] = [];
    collectText(parsed, fragments, 0);
    const readable = Array.from(new Set(fragments.map((item) => item.trim()).filter(Boolean))).join(' ');
    return readable || trimmed;
  } catch {
    return trimmed;
  }
}

function collectText(value: unknown, output: string[], depth: number) {
  if (depth > 6 || output.join('').length > 200_000) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1);
    return;
  }
  const record = asRecord(value);
  for (const [key, item] of Object.entries(record)) {
    if (['open_id', 'user_id', 'tenant_key', 'url', 'token'].includes(key)) continue;
    collectText(item, output, depth + 1);
  }
}

function localTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function startOfTodayMs(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function feishuIso(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(
    Math.floor(absoluteOffset / 60),
  )}:${pad(absoluteOffset % 60)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
