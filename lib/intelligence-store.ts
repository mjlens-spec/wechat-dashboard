import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readConfig } from './config';
import { decryptSensitiveText, encryptSensitiveText } from './crypto-store';
import { db, secureDatabaseFiles } from './db';
import {
  classifyMessageSignals,
  classifyWorkGroup,
  type SignalName,
} from './intelligence-rules';

export const SUMMARY_INTERVAL_MS = 30 * 60 * 1000;
export const ANALYSIS_JOB_TTL_MS = 30 * 60 * 1000;

const MAX_GROUPS = 80;
const MAX_MESSAGES_PER_GROUP = 160;
const MAX_MESSAGES_TOTAL = 800;
const MAX_MESSAGE_CONTENT = 1_200;

export type AnalysisMode = 'scheduled' | 'summaries' | 'alerts' | 'opportunities';
export type AttentionCategory =
  | 'mention'
  | 'customer_emotion'
  | 'urgent'
  | 'no_response'
  | 'conflict'
  | 'no_solution';
export type AttentionSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AttentionStatus = 'open' | 'handled' | 'dismissed';
export type OpportunityCategory =
  | 'new_demand'
  | 'budget_signal'
  | 'collaboration'
  | 'upsell'
  | 'referral'
  | 'renewal';
export type OpportunityStatus = 'new' | 'following' | 'converted' | 'dismissed';

const ShortText = z.string().trim().min(1).max(600);
const SummarySchema = z.object({
  group_id: z.string().trim().min(1).max(512),
  overview: z.string().trim().min(1).max(2_400),
  highlights: z.array(ShortText).max(12).default([]),
  decisions: z.array(ShortText).max(10).default([]),
  action_items: z
    .array(
      z.object({
        text: ShortText,
        owner: z.string().trim().max(120).nullable().default(null),
        due: z.string().trim().max(120).nullable().default(null),
        status: z.enum(['open', 'done', 'unknown']).default('unknown'),
      }),
    )
    .max(15)
    .default([]),
  risks: z.array(ShortText).max(10).default([]),
  evidence_ids: z.array(z.string().trim().min(3).max(80)).min(1).max(40),
});
const AlertSchema = z.object({
  group_id: z.string().trim().min(1).max(512),
  category: z.enum([
    'mention',
    'customer_emotion',
    'urgent',
    'no_response',
    'conflict',
    'no_solution',
  ]),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  confidence: z.number().min(0).max(1),
  title: z.string().trim().min(1).max(180),
  detail: z.string().trim().min(1).max(1_200),
  suggested_action: z.string().trim().min(1).max(600),
  evidence_ids: z.array(z.string().trim().min(3).max(80)).min(1).max(15),
});
const OpportunitySchema = z.object({
  group_id: z.string().trim().min(1).max(512),
  category: z.enum([
    'new_demand',
    'budget_signal',
    'collaboration',
    'upsell',
    'referral',
    'renewal',
  ]),
  confidence: z.number().min(0).max(1),
  title: z.string().trim().min(1).max(180),
  detail: z.string().trim().min(1).max(1_200),
  business_value: z.string().trim().min(1).max(600),
  suggested_action: z.string().trim().min(1).max(600),
  owner: z.string().trim().max(120).nullable().default(null),
  due: z.string().trim().max(120).nullable().default(null),
  evidence_ids: z.array(z.string().trim().min(3).max(80)).min(1).max(15),
});
const AnalysisPayloadSchema = z.object({
  model: z.literal('gpt-5.6-terra'),
  reasoning_effort: z.literal('high'),
  summaries: z.array(SummarySchema).max(MAX_GROUPS).default([]),
  alerts: z.array(AlertSchema).max(120).default([]),
  opportunities: z.array(OpportunitySchema).max(120).default([]),
});
const ImportSchema = z.object({
  job_id: z.string().uuid(),
  job_token: z.string().min(32).max(200),
  analysis: AnalysisPayloadSchema,
});

interface EncryptedGroupRow {
  id: string;
  platform: 'wechat' | 'feishu';
  chat_type: 'group' | 'private';
  name_cipher: string;
  message_count: number;
  last_activity: number;
}

interface EncryptedMessageRow {
  chatroom_id: string;
  message_id: string;
  sender_cipher: string;
  content_cipher: string;
  time: string;
  timestamp: number;
  type: string;
}

interface ContextMessage {
  evidence_id: string;
  sender: string;
  content: string;
  time: string;
  timestamp: number;
  type: string;
  signals: SignalName[];
  candidate_reasons: string[];
}

interface ContextGroup {
  id: string;
  platform: 'wechat' | 'feishu';
  chat_type: 'group' | 'private';
  name: string;
  total_message_count: number;
  context_message_count: number;
  context_truncated: boolean;
  likely_work_group: boolean;
  work_score: number;
  work_group_reasons: string[];
  messages: ContextMessage[];
}

export function createAnalysisExport(
  mode: AnalysisMode,
  now = new Date(),
) {
  expireOldJobs(now.getTime());
  const day = localDay(now);
  const groups = collectContextGroups(day);
  const lastSummaryAt = latestSummaryTimestamp(day);
  const summaryDue = !lastSummaryAt || now.getTime() - lastSummaryAt >= SUMMARY_INTERVAL_MS;
  const requestedOutputs = requestedOutputsFor(mode, summaryDue);

  if (groups.length === 0) {
    return {
      status: 'no_work' as const,
      summary: '今天尚无可供分析的本地群聊消息。',
      next_actions: ['等待下一次 30 分钟增量同步'],
      artifacts: [],
      context: null,
    };
  }

  const jobId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const createdAt = now.getTime();
  const evidenceRows = groups.flatMap((group) =>
    group.messages.map((message) => ({
      evidenceId: message.evidence_id,
      groupId: group.id,
      messageId: messageIdFromEvidence(day, group.id, message.evidence_id),
    })),
  );
  const messageLookup = collectMessageLookup(day, groups);
  const resolvedEvidence = evidenceRows.map((row) => ({
    ...row,
    messageId: messageLookup.get(`${row.groupId}\u0000${row.evidenceId}`) ?? row.messageId,
  }));
  const inputDigest = digest(
    JSON.stringify({ day, requestedOutputs, groups, profile: readConfig().myNicknames }),
  );

  db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO analysis_jobs (
           id, token_hash, mode, day, requested_outputs, input_digest,
           group_count, message_count, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        digest(token),
        mode === 'opportunities' ? 'scheduled' : mode,
        day,
        JSON.stringify(requestedOutputs),
        inputDigest,
        groups.length,
        groups.reduce((sum, group) => sum + group.messages.length, 0),
        createdAt,
        createdAt + ANALYSIS_JOB_TTL_MS,
      );
    const insertEvidence = db().prepare(
      `INSERT INTO analysis_job_evidence
       (job_id, evidence_id, chatroom_id, message_id) VALUES (?, ?, ?, ?)`,
    );
    for (const evidence of resolvedEvidence) {
      insertEvidence.run(jobId, evidence.evidenceId, evidence.groupId, evidence.messageId);
    }
  })();
  secureDatabaseFiles();

  const config = readConfig();
  return {
    status: 'ready' as const,
    summary: `已准备 ${groups.length} 个会话、${resolvedEvidence.length} 条消息的受限分析上下文。`,
    next_actions: ['使用 Terra High 生成结构化结果', '校验证据 ID 后导回 Dashboard'],
    artifacts: [],
    context: {
      schema_version: 2,
      job: {
        id: jobId,
        token,
        mode,
        day,
        created_at: new Date(createdAt).toISOString(),
        expires_at: new Date(createdAt + ANALYSIS_JOB_TTL_MS).toISOString(),
        requested_outputs: requestedOutputs,
      },
      profile: {
        my_names: config.myNicknames,
        mention_rule:
          config.myNicknames.length > 0
            ? '只有消息明确 @ 到 my_names 中的名字，才可生成 mention 提示。'
            : 'my_names 为空，本次禁止生成 mention 提示；请先在本机设置中填写本人昵称。',
      },
      generation_rules: analysisRules(),
      last_summary_generated_at: lastSummaryAt
        ? new Date(lastSummaryAt).toISOString()
        : null,
      conversations: groups,
    },
  };
}

export function importAnalysisResult(raw: unknown, now = Date.now()) {
  const parsed = ImportSchema.parse(raw);
  const job = db()
    .prepare('SELECT * FROM analysis_jobs WHERE id = ?')
    .get(parsed.job_id) as
    | {
        id: string;
        token_hash: string;
        day: string;
        status: 'pending' | 'imported' | 'expired' | 'failed';
        expires_at: number;
        requested_outputs: string;
      }
    | undefined;
  if (!job) throw new AnalysisImportError('ANALYSIS_JOB_NOT_FOUND', '分析任务不存在。');
  if (job.status !== 'pending') {
    throw new AnalysisImportError('ANALYSIS_JOB_CLOSED', '分析任务已经导入或失效。');
  }
  if (job.expires_at < now) {
    markJobExpired(job.id);
    throw new AnalysisImportError('ANALYSIS_JOB_EXPIRED', '分析任务已过期，请重新导出上下文。');
  }
  if (digest(parsed.job_token) !== job.token_hash) {
    throw new AnalysisImportError('ANALYSIS_TOKEN_INVALID', '分析任务令牌无效。');
  }

  const requested = new Set(JSON.parse(job.requested_outputs) as string[]);
  if (!requested.has('summaries') && parsed.analysis.summaries.length > 0) {
    throw new AnalysisImportError('UNREQUESTED_OUTPUT', '本任务没有请求群聊汇总。');
  }
  if (!requested.has('alerts') && parsed.analysis.alerts.length > 0) {
    throw new AnalysisImportError('UNREQUESTED_OUTPUT', '本任务没有请求重点关注提示。');
  }
  if (!requested.has('opportunities') && parsed.analysis.opportunities.length > 0) {
    throw new AnalysisImportError('UNREQUESTED_OUTPUT', '本任务没有请求潜在商机提示。');
  }

  const evidence = evidenceForJob(job.id);
  validateAnalysisEvidence(parsed.analysis, evidence);

  let summaryCount = 0;
  let alertCount = 0;
  let opportunityCount = 0;
  db().transaction(() => {
    for (const summary of parsed.analysis.summaries) {
      const messageCount = summary.evidence_ids.length;
      upsertGroupSummary(
        job.day,
        job.id,
        parsed.analysis.model,
        parsed.analysis.reasoning_effort,
        summary,
        messageCount,
        now,
      );
      summaryCount++;
    }
    for (const alert of parsed.analysis.alerts) {
      upsertAttentionAlert(
        job.day,
        job.id,
        parsed.analysis.model,
        parsed.analysis.reasoning_effort,
        alert,
        now,
      );
      alertCount++;
    }
    for (const opportunity of parsed.analysis.opportunities) {
      upsertBusinessOpportunity(
        job.day,
        job.id,
        parsed.analysis.model,
        parsed.analysis.reasoning_effort,
        opportunity,
        now,
      );
      opportunityCount++;
    }
    db()
      .prepare(
        `UPDATE analysis_jobs
         SET status = 'imported', imported_at = ?, analysis_model = ?, reasoning_effort = ?
         WHERE id = ?`,
      )
      .run(now, parsed.analysis.model, parsed.analysis.reasoning_effort, job.id);
  })();
  secureDatabaseFiles();
  return {
    status: 'imported' as const,
    summary: `已写入 ${summaryCount} 个会话汇总、${alertCount} 条重点关注提示和 ${opportunityCount} 条潜在商机。`,
    next_actions: ['在 Dashboard 中查看会话汇总、重点关注提示与潜在商机'],
    artifacts: [],
    imported: { summaries: summaryCount, alerts: alertCount, opportunities: opportunityCount },
  };
}

export function summaryDashboard(day = localDay(new Date())) {
  const rows = db()
    .prepare(
      `SELECT s.*, c.name_cipher, c.platform, c.chat_type
       FROM group_summaries s
       JOIN conversations c ON c.id = s.chatroom_id
       WHERE s.day = ?
       ORDER BY s.generated_at DESC, s.chatroom_id`,
    )
    .all(day) as Array<{
    day: string;
    chatroom_id: string;
    name_cipher: string;
    platform: 'wechat' | 'feishu';
    chat_type: 'group' | 'private';
    overview_cipher: string;
    highlights_cipher: string;
    decisions_cipher: string;
    action_items_cipher: string;
    risks_cipher: string;
    evidence_ids: string;
    message_count: number;
    analysis_model: string;
    reasoning_effort: string;
    generated_at: number;
  }>;
  const summaries = rows.map((row) => ({
    day: row.day,
    group_id: row.chatroom_id,
    group_name: decryptOrPlaceholder(
      row.name_cipher,
      `conversation:name:${row.chatroom_id}`,
    ),
    platform: row.platform,
    chat_type: row.chat_type,
    overview: decryptOrPlaceholder(
      row.overview_cipher,
      summaryContext(row.day, row.chatroom_id, 'overview'),
    ),
    highlights: decryptJson<string[]>(
      row.highlights_cipher,
      summaryContext(row.day, row.chatroom_id, 'highlights'),
      [],
    ),
    decisions: decryptJson<string[]>(
      row.decisions_cipher,
      summaryContext(row.day, row.chatroom_id, 'decisions'),
      [],
    ),
    action_items: decryptJson<Array<{ text: string; owner: string | null; due: string | null; status: string }>>(
      row.action_items_cipher,
      summaryContext(row.day, row.chatroom_id, 'action-items'),
      [],
    ),
    risks: decryptJson<string[]>(
      row.risks_cipher,
      summaryContext(row.day, row.chatroom_id, 'risks'),
      [],
    ),
    evidence_count: safeJsonArray(row.evidence_ids).length,
    message_count: row.message_count,
    analysis_model: row.analysis_model,
    reasoning_effort: row.reasoning_effort,
    generated_at: row.generated_at,
  }));
  const lastGeneratedAt = rows.reduce(
    (latest, row) => Math.max(latest, row.generated_at),
    0,
  );
  return {
    ok: true,
    day,
    summaries,
    last_generated_at: lastGeneratedAt || null,
    next_due_at: lastGeneratedAt ? lastGeneratedAt + SUMMARY_INTERVAL_MS : Date.now(),
    intelligence: intelligenceStatus(),
  };
}

export function attentionDashboard(day = localDay(new Date())) {
  const rows = db()
    .prepare(
      `SELECT a.*, c.name_cipher, c.platform, c.chat_type
       FROM attention_alerts a
       JOIN conversations c ON c.id = a.chatroom_id
       WHERE a.day = ?
       ORDER BY
         CASE a.status WHEN 'open' THEN 0 WHEN 'handled' THEN 1 ELSE 2 END,
         CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         a.last_detected_at DESC`,
    )
    .all(day) as Array<{
    id: string;
    day: string;
    chatroom_id: string;
    name_cipher: string;
    platform: 'wechat' | 'feishu';
    chat_type: 'group' | 'private';
    category: AttentionCategory;
    severity: AttentionSeverity;
    confidence: number;
    title_cipher: string;
    detail_cipher: string;
    suggested_action_cipher: string;
    evidence_ids: string;
    status: AttentionStatus;
    analysis_model: string;
    reasoning_effort: string;
    first_detected_at: number;
    last_detected_at: number;
    handled_at: number | null;
  }>;
  const alerts = rows.map((row) => ({
    id: row.id,
    day: row.day,
    group_id: row.chatroom_id,
    group_name: decryptOrPlaceholder(
      row.name_cipher,
      `conversation:name:${row.chatroom_id}`,
    ),
    platform: row.platform,
    chat_type: row.chat_type,
    category: row.category,
    severity: row.severity,
    confidence: row.confidence,
    title: decryptOrPlaceholder(row.title_cipher, alertContext(row.id, 'title')),
    detail: decryptOrPlaceholder(row.detail_cipher, alertContext(row.id, 'detail')),
    suggested_action: decryptOrPlaceholder(
      row.suggested_action_cipher,
      alertContext(row.id, 'suggested-action'),
    ),
    evidence_count: safeJsonArray(row.evidence_ids).length,
    status: row.status,
    analysis_model: row.analysis_model,
    reasoning_effort: row.reasoning_effort,
    first_detected_at: row.first_detected_at,
    last_detected_at: row.last_detected_at,
    handled_at: row.handled_at,
  }));
  return {
    ok: true,
    day,
    alerts,
    counts: {
      open: alerts.filter((alert) => alert.status === 'open').length,
      critical: alerts.filter(
        (alert) => alert.status === 'open' && alert.severity === 'critical',
      ).length,
      high: alerts.filter(
        (alert) => alert.status === 'open' && alert.severity === 'high',
      ).length,
      mentions: alerts.filter(
        (alert) => alert.status === 'open' && alert.category === 'mention',
      ).length,
    },
    intelligence: intelligenceStatus(),
  };
}

export function updateAttentionStatus(id: string, status: AttentionStatus) {
  const now = Date.now();
  const result = db()
    .prepare(
      `UPDATE attention_alerts
       SET status = ?, handled_at = ?
       WHERE id = ?`,
    )
    .run(status, status === 'open' ? null : now, id);
  secureDatabaseFiles();
  return result.changes > 0;
}

export function opportunitiesDashboard(day = localDay(new Date())) {
  const rows = db()
    .prepare(
      `SELECT o.*, c.name_cipher, c.platform, c.chat_type
       FROM business_opportunities o
       JOIN conversations c ON c.id = o.chatroom_id
       WHERE o.day = ?
       ORDER BY
         CASE o.status WHEN 'new' THEN 0 WHEN 'following' THEN 1 WHEN 'converted' THEN 2 ELSE 3 END,
         o.confidence DESC, o.last_detected_at DESC`,
    )
    .all(day) as Array<{
    id: string;
    chatroom_id: string;
    name_cipher: string;
    platform: 'wechat' | 'feishu';
    chat_type: 'group' | 'private';
    category: OpportunityCategory;
    confidence: number;
    title_cipher: string;
    detail_cipher: string;
    business_value_cipher: string;
    suggested_action_cipher: string;
    owner_cipher: string;
    due_cipher: string;
    evidence_ids: string;
    status: OpportunityStatus;
    analysis_model: string;
    reasoning_effort: string;
    first_detected_at: number;
    last_detected_at: number;
    handled_at: number | null;
  }>;
  const opportunities = rows.map((row) => ({
    id: row.id,
    conversation_id: row.chatroom_id,
    conversation_name: decryptOrPlaceholder(
      row.name_cipher,
      `conversation:name:${row.chatroom_id}`,
    ),
    platform: row.platform,
    chat_type: row.chat_type,
    category: row.category,
    confidence: row.confidence,
    title: decryptOrPlaceholder(row.title_cipher, opportunityContext(row.id, 'title')),
    detail: decryptOrPlaceholder(row.detail_cipher, opportunityContext(row.id, 'detail')),
    business_value: decryptOrPlaceholder(
      row.business_value_cipher,
      opportunityContext(row.id, 'business-value'),
    ),
    suggested_action: decryptOrPlaceholder(
      row.suggested_action_cipher,
      opportunityContext(row.id, 'suggested-action'),
    ),
    owner: decryptOrPlaceholder(row.owner_cipher, opportunityContext(row.id, 'owner')),
    due: decryptOrPlaceholder(row.due_cipher, opportunityContext(row.id, 'due')),
    evidence_count: safeJsonArray(row.evidence_ids).length,
    status: row.status,
    analysis_model: row.analysis_model,
    reasoning_effort: row.reasoning_effort,
    first_detected_at: row.first_detected_at,
    last_detected_at: row.last_detected_at,
    handled_at: row.handled_at,
  }));
  return {
    ok: true,
    day,
    opportunities,
    counts: {
      new: opportunities.filter((item) => item.status === 'new').length,
      following: opportunities.filter((item) => item.status === 'following').length,
      converted: opportunities.filter((item) => item.status === 'converted').length,
      wechat: opportunities.filter((item) => item.platform === 'wechat').length,
      feishu: opportunities.filter((item) => item.platform === 'feishu').length,
    },
    intelligence: intelligenceStatus(),
  };
}

export function updateOpportunityStatus(id: string, status: OpportunityStatus) {
  const result = db()
    .prepare(
      `UPDATE business_opportunities
       SET status = ?, handled_at = ?
       WHERE id = ?`,
    )
    .run(status, status === 'new' ? null : Date.now(), id);
  secureDatabaseFiles();
  return result.changes > 0;
}

export function intelligenceStatus() {
  const latest = db()
    .prepare(
      `SELECT id, mode, status, requested_outputs, created_at, expires_at,
              imported_at, analysis_model, reasoning_effort, group_count,
              message_count, error_code
       FROM analysis_jobs ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as
    | {
        id: string;
        mode: AnalysisMode;
        status: string;
        requested_outputs: string;
        created_at: number;
        expires_at: number;
        imported_at: number | null;
        analysis_model: string | null;
        reasoning_effort: string | null;
        group_count: number;
        message_count: number;
        error_code: string | null;
      }
    | undefined;
  const lastImported = db()
    .prepare(
      `SELECT analysis_model, reasoning_effort, imported_at
       FROM analysis_jobs
       WHERE status = 'imported' AND analysis_model IS NOT NULL
       ORDER BY imported_at DESC LIMIT 1`,
    )
    .get() as
    | { analysis_model: string; reasoning_effort: string | null; imported_at: number }
    | undefined;
  return latest
    ? {
        ...latest,
        requested_outputs: safeJsonArray(latest.requested_outputs),
        display_model: latest.analysis_model ?? lastImported?.analysis_model ?? null,
        display_reasoning:
          latest.reasoning_effort ?? lastImported?.reasoning_effort ?? null,
        last_imported_at: lastImported?.imported_at ?? null,
      }
    : null;
}

export class AnalysisImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AnalysisImportError';
  }
}

function collectContextGroups(day: string): ContextGroup[] {
  const config = readConfig();
  const groupRows = db()
    .prepare(
      `SELECT c.id, c.platform, c.chat_type, c.name_cipher, c.last_activity,
              COUNT(m.message_id) AS message_count
       FROM conversations c
       JOIN messages m ON m.chatroom_id = c.id AND m.date = ?
       WHERE m.deleted = 0
         AND (
           c.chat_type = 'group' OR
           (c.platform = 'wechat' AND c.chat_type = 'private' AND ? = 1) OR
           (c.platform = 'feishu' AND c.chat_type = 'private' AND ? = 1)
         )
       GROUP BY c.id
       ORDER BY c.platform, CASE WHEN c.chat_type = 'group' THEN 0 ELSE 1 END,
                c.last_activity DESC
       LIMIT ?`,
    )
    .all(
      day,
      Number(config.analyzeWeChatPrivate),
      Number(config.analyzeFeishuPrivate),
      MAX_GROUPS,
    ) as EncryptedGroupRow[];
  const myNames = config.myNicknames;
  let remaining = MAX_MESSAGES_TOTAL;
  const groups: ContextGroup[] = [];
  for (const groupRow of groupRows) {
    if (remaining <= 0) break;
    const limit = Math.min(MAX_MESSAGES_PER_GROUP, remaining);
    const rows = db()
      .prepare(
        `SELECT chatroom_id, message_id, sender_cipher, content_cipher,
                time, timestamp, type
         FROM messages
         WHERE chatroom_id = ? AND date = ? AND deleted = 0
         ORDER BY timestamp DESC, message_id DESC
         LIMIT ?`,
      )
      .all(groupRow.id, day, limit) as EncryptedMessageRow[];
    const messages = rows
      .reverse()
      .map((row) => decryptContextMessage(row, myNames))
      .filter((row): row is ContextMessage => Boolean(row));
    if (messages.length === 0) continue;
    const name = decryptOrPlaceholder(
      groupRow.name_cipher,
      `conversation:name:${groupRow.id}`,
    );
    const work = classifyWorkGroup(
      name,
      messages.map((message) => message.content),
    );
    groups.push({
      id: groupRow.id,
      platform: groupRow.platform,
      chat_type: groupRow.chat_type,
      name,
      total_message_count: groupRow.message_count,
      context_message_count: messages.length,
      context_truncated: groupRow.message_count > messages.length,
      likely_work_group: work.likely_work_group,
      work_score: work.work_score,
      work_group_reasons: work.reasons,
      messages,
    });
    remaining -= messages.length;
  }
  return groups;
}

function decryptContextMessage(
  row: EncryptedMessageRow,
  myNames: string[],
): ContextMessage | null {
  try {
    const sender = decryptSensitiveText(
      row.sender_cipher,
      `message:sender:${row.chatroom_id}:${row.message_id}`,
    );
    const content = decryptSensitiveText(
      row.content_cipher,
      `message:content:${row.chatroom_id}:${row.message_id}`,
    ).slice(0, MAX_MESSAGE_CONTENT);
    const classification = classifyMessageSignals(content, myNames);
    return {
      evidence_id: evidenceId(row.chatroom_id, row.message_id),
      sender,
      content,
      time: row.time,
      timestamp: row.timestamp,
      type: row.type,
      ...classification,
    };
  } catch {
    return null;
  }
}

function collectMessageLookup(day: string, groups: ContextGroup[]) {
  const lookup = new Map<string, string>();
  for (const group of groups) {
    const rows = db()
      .prepare('SELECT message_id FROM messages WHERE chatroom_id = ? AND date = ?')
      .all(group.id, day) as Array<{ message_id: string }>;
    for (const row of rows) {
      lookup.set(`${group.id}\u0000${evidenceId(group.id, row.message_id)}`, row.message_id);
    }
  }
  return lookup;
}

function messageIdFromEvidence(_day: string, _groupId: string, evidence: string) {
  return evidence;
}

function requestedOutputsFor(mode: AnalysisMode, summaryDue: boolean) {
  if (mode === 'summaries') return ['summaries'] as const;
  if (mode === 'alerts') return ['alerts'] as const;
  if (mode === 'opportunities') return ['opportunities'] as const;
  return summaryDue
    ? (['summaries', 'alerts', 'opportunities'] as const)
    : (['alerts', 'opportunities'] as const);
}

function analysisRules() {
  return {
    model_preference: {
      required_model: 'gpt-5.6-terra',
      required_reasoning: 'high',
      policy: '只接受 Terra High 结果；模型或推理强度不一致时拒绝导入。',
    },
    separation:
      '每个群必须独立分析、独立生成一条 summary；禁止把多个群合并成总汇总。',
    evidence:
      '每条结论都必须引用当前上下文内的 evidence_id；没有证据时不得生成。',
    alerts: {
      mention: '只识别明确 @ 到 profile.my_names 的重点信息。',
      customer_emotion: '客户或外部合作方出现明显情绪爆发、激烈措辞或强烈不满。',
      urgent: '有明确时间压力、业务事故、客户投诉或需要立即行动的问题。',
      no_response: '一个明确问题或请求在合理时间内仍无人回应；结合消息时间判断。',
      conflict: '群内出现相互指责、对立升级或协作冲突。',
      no_solution: '问题持续被讨论，但没有负责人、行动项或可执行解决方案。',
    },
    opportunities: {
      new_demand: '出现明确的新需求、项目意向或待解决业务问题。',
      budget_signal: '出现预算、采购、报价、合同或付款意向信号。',
      collaboration: '出现品牌、渠道、内容、资源或联合项目合作机会。',
      upsell: '现有合作范围存在可验证的增购、升级或扩展空间。',
      referral: '出现转介绍、引荐决策人或连接新客户的机会。',
      renewal: '出现续约、延长合作或复购信号。',
    },
    precision:
      '优先准确，避免把普通抱怨、闲聊、已明确解决的问题升级为重点提示。',
    work_groups:
      'customer_emotion、no_response、conflict、no_solution 主要面向工作群；规则评分只是线索，需结合语义判断。',
    language: '输出简洁、自然的简体中文。',
  };
}

function evidenceForJob(jobId: string) {
  const rows = db()
    .prepare(
      'SELECT evidence_id, chatroom_id FROM analysis_job_evidence WHERE job_id = ?',
    )
    .all(jobId) as Array<{ evidence_id: string; chatroom_id: string }>;
  return new Map(rows.map((row) => [row.evidence_id, row.chatroom_id]));
}

function validateAnalysisEvidence(
  analysis: z.infer<typeof AnalysisPayloadSchema>,
  evidence: Map<string, string>,
) {
  const validate = (groupId: string, ids: string[]) => {
    for (const id of ids) {
      if (evidence.get(id) !== groupId) {
        throw new AnalysisImportError(
          'INVALID_EVIDENCE',
          `证据 ${id} 不属于当前任务中的指定群聊。`,
        );
      }
    }
  };
  const summaryGroups = new Set<string>();
  for (const summary of analysis.summaries) {
    if (summaryGroups.has(summary.group_id)) {
      throw new AnalysisImportError('DUPLICATE_GROUP_SUMMARY', '同一个群只能导入一条汇总。');
    }
    summaryGroups.add(summary.group_id);
    validate(summary.group_id, summary.evidence_ids);
  }
  for (const alert of analysis.alerts) validate(alert.group_id, alert.evidence_ids);
  for (const opportunity of analysis.opportunities) {
    validate(opportunity.group_id, opportunity.evidence_ids);
  }
}

function upsertGroupSummary(
  day: string,
  jobId: string,
  model: string,
  reasoningEffort: string,
  summary: z.infer<typeof SummarySchema>,
  messageCount: number,
  now: number,
) {
  const context = (field: string) => summaryContext(day, summary.group_id, field);
  db()
    .prepare(
      `INSERT INTO group_summaries (
         day, chatroom_id, overview_cipher, highlights_cipher, decisions_cipher,
         action_items_cipher, risks_cipher, evidence_ids, message_count,
         analysis_model, reasoning_effort, generated_at, job_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, chatroom_id) DO UPDATE SET
         overview_cipher = excluded.overview_cipher,
         highlights_cipher = excluded.highlights_cipher,
         decisions_cipher = excluded.decisions_cipher,
         action_items_cipher = excluded.action_items_cipher,
         risks_cipher = excluded.risks_cipher,
         evidence_ids = excluded.evidence_ids,
         message_count = excluded.message_count,
         analysis_model = excluded.analysis_model,
         reasoning_effort = excluded.reasoning_effort,
         generated_at = excluded.generated_at,
         job_id = excluded.job_id`,
    )
    .run(
      day,
      summary.group_id,
      encryptSensitiveText(summary.overview, context('overview')),
      encryptSensitiveText(JSON.stringify(summary.highlights), context('highlights')),
      encryptSensitiveText(JSON.stringify(summary.decisions), context('decisions')),
      encryptSensitiveText(JSON.stringify(summary.action_items), context('action-items')),
      encryptSensitiveText(JSON.stringify(summary.risks), context('risks')),
      JSON.stringify(summary.evidence_ids),
      messageCount,
      model,
      reasoningEffort,
      now,
      jobId,
    );
}

function upsertAttentionAlert(
  day: string,
  jobId: string,
  model: string,
  reasoningEffort: string,
  alert: z.infer<typeof AlertSchema>,
  now: number,
) {
  const alertId = `a_${digest(
    [day, alert.group_id, alert.category, ...[...alert.evidence_ids].sort()].join('\u0000'),
  ).slice(0, 28)}`;
  db()
    .prepare(
      `INSERT INTO attention_alerts (
         id, day, chatroom_id, category, severity, confidence,
         title_cipher, detail_cipher, suggested_action_cipher, evidence_ids,
         status, analysis_model, reasoning_effort, first_detected_at,
         last_detected_at, job_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         severity = excluded.severity,
         confidence = excluded.confidence,
         title_cipher = excluded.title_cipher,
         detail_cipher = excluded.detail_cipher,
         suggested_action_cipher = excluded.suggested_action_cipher,
         evidence_ids = excluded.evidence_ids,
         analysis_model = excluded.analysis_model,
         reasoning_effort = excluded.reasoning_effort,
         last_detected_at = excluded.last_detected_at,
         job_id = excluded.job_id`,
    )
    .run(
      alertId,
      day,
      alert.group_id,
      alert.category,
      alert.severity,
      alert.confidence,
      encryptSensitiveText(alert.title, alertContext(alertId, 'title')),
      encryptSensitiveText(alert.detail, alertContext(alertId, 'detail')),
      encryptSensitiveText(
        alert.suggested_action,
        alertContext(alertId, 'suggested-action'),
      ),
      JSON.stringify(alert.evidence_ids),
      model,
      reasoningEffort,
      now,
      now,
      jobId,
    );
}

function upsertBusinessOpportunity(
  day: string,
  jobId: string,
  model: string,
  reasoningEffort: string,
  opportunity: z.infer<typeof OpportunitySchema>,
  now: number,
) {
  const opportunityId = `o_${digest(
    [
      day,
      opportunity.group_id,
      opportunity.category,
      ...[...opportunity.evidence_ids].sort(),
    ].join('\u0000'),
  ).slice(0, 28)}`;
  const context = (field: string) => opportunityContext(opportunityId, field);
  db()
    .prepare(
      `INSERT INTO business_opportunities (
         id, day, chatroom_id, category, confidence, title_cipher,
         detail_cipher, business_value_cipher, suggested_action_cipher,
         owner_cipher, due_cipher, evidence_ids, status, analysis_model,
         reasoning_effort, first_detected_at, last_detected_at, job_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         confidence = excluded.confidence,
         title_cipher = excluded.title_cipher,
         detail_cipher = excluded.detail_cipher,
         business_value_cipher = excluded.business_value_cipher,
         suggested_action_cipher = excluded.suggested_action_cipher,
         owner_cipher = excluded.owner_cipher,
         due_cipher = excluded.due_cipher,
         evidence_ids = excluded.evidence_ids,
         analysis_model = excluded.analysis_model,
         reasoning_effort = excluded.reasoning_effort,
         last_detected_at = excluded.last_detected_at,
         job_id = excluded.job_id`,
    )
    .run(
      opportunityId,
      day,
      opportunity.group_id,
      opportunity.category,
      opportunity.confidence,
      encryptSensitiveText(opportunity.title, context('title')),
      encryptSensitiveText(opportunity.detail, context('detail')),
      encryptSensitiveText(opportunity.business_value, context('business-value')),
      encryptSensitiveText(opportunity.suggested_action, context('suggested-action')),
      encryptSensitiveText(opportunity.owner ?? '', context('owner')),
      encryptSensitiveText(opportunity.due ?? '', context('due')),
      JSON.stringify(opportunity.evidence_ids),
      model,
      reasoningEffort,
      now,
      now,
      jobId,
    );
}

function latestSummaryTimestamp(day: string) {
  const row = db()
    .prepare('SELECT MAX(generated_at) AS generated_at FROM group_summaries WHERE day = ?')
    .get(day) as { generated_at: number | null };
  return row.generated_at ?? null;
}

function expireOldJobs(now: number) {
  db()
    .prepare(
      `UPDATE analysis_jobs
       SET status = 'expired', error_code = 'ANALYSIS_JOB_EXPIRED'
       WHERE status = 'pending' AND expires_at < ?`,
    )
    .run(now);
}

function markJobExpired(jobId: string) {
  db()
    .prepare(
      `UPDATE analysis_jobs
       SET status = 'expired', error_code = 'ANALYSIS_JOB_EXPIRED'
       WHERE id = ?`,
    )
    .run(jobId);
  secureDatabaseFiles();
}

function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function evidenceId(groupId: string, messageId: string) {
  return `e_${digest(`${groupId}\u0000${messageId}`).slice(0, 24)}`;
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function summaryContext(day: string, groupId: string, field: string) {
  return `analysis:summary:${day}:${groupId}:${field}`;
}

function alertContext(alertId: string, field: string) {
  return `analysis:alert:${alertId}:${field}`;
}

function opportunityContext(opportunityId: string, field: string) {
  return `analysis:opportunity:${opportunityId}:${field}`;
}

function decryptOrPlaceholder(ciphertext: string, context: string) {
  try {
    return decryptSensitiveText(ciphertext, context);
  } catch {
    return '[本机数据无法解密]';
  }
}

function decryptJson<T>(ciphertext: string, context: string, fallback: T): T {
  try {
    return JSON.parse(decryptSensitiveText(ciphertext, context)) as T;
  } catch {
    return fallback;
  }
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
