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

const MAX_GROUPS = 50;
const MAX_MESSAGES_PER_GROUP = 180;
const MAX_MESSAGES_TOTAL = 800;
const MAX_MESSAGE_CONTENT = 1_200;

export type AnalysisMode = 'scheduled' | 'summaries' | 'alerts';
export type AttentionCategory =
  | 'mention'
  | 'customer_emotion'
  | 'urgent'
  | 'no_response'
  | 'conflict'
  | 'no_solution';
export type AttentionSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AttentionStatus = 'open' | 'handled' | 'dismissed';

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
const AnalysisPayloadSchema = z.object({
  model: z.string().trim().min(1).max(120),
  summaries: z.array(SummarySchema).max(MAX_GROUPS).default([]),
  alerts: z.array(AlertSchema).max(120).default([]),
});
const ImportSchema = z.object({
  job_id: z.string().uuid(),
  job_token: z.string().min(32).max(200),
  analysis: AnalysisPayloadSchema,
});

interface EncryptedGroupRow {
  id: string;
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
        mode,
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
    summary: `已准备 ${groups.length} 个群、${resolvedEvidence.length} 条消息的受限分析上下文。`,
    next_actions: ['使用当前 Agent 的首选模型生成结构化结果', '校验证据 ID 后导回 Dashboard'],
    artifacts: [],
    context: {
      schema_version: 1,
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
      groups,
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

  const evidence = evidenceForJob(job.id);
  validateAnalysisEvidence(parsed.analysis, evidence);

  let summaryCount = 0;
  let alertCount = 0;
  db().transaction(() => {
    for (const summary of parsed.analysis.summaries) {
      const messageCount = summary.evidence_ids.length;
      upsertGroupSummary(
        job.day,
        job.id,
        parsed.analysis.model,
        summary,
        messageCount,
        now,
      );
      summaryCount++;
    }
    for (const alert of parsed.analysis.alerts) {
      upsertAttentionAlert(job.day, job.id, parsed.analysis.model, alert, now);
      alertCount++;
    }
    db()
      .prepare(
        `UPDATE analysis_jobs
         SET status = 'imported', imported_at = ?, analysis_model = ?
         WHERE id = ?`,
      )
      .run(now, parsed.analysis.model, job.id);
  })();
  secureDatabaseFiles();
  return {
    status: 'imported' as const,
    summary: `已写入 ${summaryCount} 个群聊汇总和 ${alertCount} 条重点关注提示。`,
    next_actions: ['在 Dashboard 中查看群聊汇总与重点关注提示'],
    artifacts: [],
    imported: { summaries: summaryCount, alerts: alertCount },
  };
}

export function summaryDashboard(day = localDay(new Date())) {
  const rows = db()
    .prepare(
      `SELECT s.*, c.name_cipher
       FROM group_summaries s
       JOIN conversations c ON c.id = s.chatroom_id
       WHERE s.day = ?
       ORDER BY s.generated_at DESC, s.chatroom_id`,
    )
    .all(day) as Array<{
    day: string;
    chatroom_id: string;
    name_cipher: string;
    overview_cipher: string;
    highlights_cipher: string;
    decisions_cipher: string;
    action_items_cipher: string;
    risks_cipher: string;
    evidence_ids: string;
    message_count: number;
    analysis_model: string;
    generated_at: number;
  }>;
  const summaries = rows.map((row) => ({
    day: row.day,
    group_id: row.chatroom_id,
    group_name: decryptOrPlaceholder(
      row.name_cipher,
      `conversation:name:${row.chatroom_id}`,
    ),
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
      `SELECT a.*, c.name_cipher
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
    category: AttentionCategory;
    severity: AttentionSeverity;
    confidence: number;
    title_cipher: string;
    detail_cipher: string;
    suggested_action_cipher: string;
    evidence_ids: string;
    status: AttentionStatus;
    analysis_model: string;
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

export function intelligenceStatus() {
  const latest = db()
    .prepare(
      `SELECT id, mode, status, requested_outputs, created_at, expires_at,
              imported_at, analysis_model, group_count, message_count, error_code
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
        group_count: number;
        message_count: number;
        error_code: string | null;
      }
    | undefined;
  const lastImported = db()
    .prepare(
      `SELECT analysis_model, imported_at
       FROM analysis_jobs
       WHERE status = 'imported' AND analysis_model IS NOT NULL
       ORDER BY imported_at DESC LIMIT 1`,
    )
    .get() as
    | { analysis_model: string; imported_at: number }
    | undefined;
  return latest
    ? {
        ...latest,
        requested_outputs: safeJsonArray(latest.requested_outputs),
        display_model: latest.analysis_model ?? lastImported?.analysis_model ?? null,
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
  const groupRows = db()
    .prepare(
      `SELECT c.id, c.name_cipher, c.last_activity, COUNT(m.message_id) AS message_count
       FROM conversations c
       JOIN messages m ON m.chatroom_id = c.id AND m.date = ?
       WHERE c.chat_type = 'group'
       GROUP BY c.id
       ORDER BY c.last_activity DESC
       LIMIT ?`,
    )
    .all(day, MAX_GROUPS) as EncryptedGroupRow[];
  const myNames = readConfig().myNicknames;
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
         WHERE chatroom_id = ? AND date = ?
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
  return summaryDue
    ? (['summaries', 'alerts'] as const)
    : (['alerts'] as const);
}

function analysisRules() {
  return {
    model_preference: {
      primary: 'gpt-5.6-luna',
      primary_reasoning: 'max',
      fallback: 'gpt-5.6-terra',
      fallback_reasoning: 'max',
      claude_code:
        'Claude Code 无法调用 Luna / Terra 时，使用当前 Claude 模型和最高可用推理强度，并记录真实模型。',
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
}

function upsertGroupSummary(
  day: string,
  jobId: string,
  model: string,
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
         analysis_model, generated_at, job_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, chatroom_id) DO UPDATE SET
         overview_cipher = excluded.overview_cipher,
         highlights_cipher = excluded.highlights_cipher,
         decisions_cipher = excluded.decisions_cipher,
         action_items_cipher = excluded.action_items_cipher,
         risks_cipher = excluded.risks_cipher,
         evidence_ids = excluded.evidence_ids,
         message_count = excluded.message_count,
         analysis_model = excluded.analysis_model,
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
      now,
      jobId,
    );
}

function upsertAttentionAlert(
  day: string,
  jobId: string,
  model: string,
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
         status, analysis_model, first_detected_at, last_detected_at, job_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         severity = excluded.severity,
         confidence = excluded.confidence,
         title_cipher = excluded.title_cipher,
         detail_cipher = excluded.detail_cipher,
         suggested_action_cipher = excluded.suggested_action_cipher,
         evidence_ids = excluded.evidence_ids,
         analysis_model = excluded.analysis_model,
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
