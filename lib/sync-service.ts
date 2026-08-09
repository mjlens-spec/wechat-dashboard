import {
  beginSyncRun,
  conversationLookup,
  conversationsMissingCoverage,
  conversationsNeedingReconcile,
  coverageSnapshot,
  finishSyncRun,
  getAppStateNumber,
  getLatestSuccessfulSyncRun,
  getLatestSyncRun,
  getSyncRun,
  pendingBackfillConversations,
  setAppState,
  syncInProgress as databaseSyncInProgress,
  updateSyncRun,
  upsertConversations,
  upsertConversationsFromNewMessages,
} from './conversations';
import { EncryptionKeyUnavailableError } from './crypto-store';
import { readConfig } from './config';
import { automaticSyncTiming } from './sync-schedule.mjs';
import {
  bulkInsertMessages,
  getConversationSyncState,
  recordConversationSync,
} from './messages-store';
import {
  assertPinnedWeChatAccount,
  WeChatAccountChangedError,
} from './wechat-account';
import {
  isWxConversationNotFound,
  wxHistory,
  wxNewMessages,
  wxSessions,
} from './wx';
import type { WxMessage, WxNewMessage, WxSession } from './wx-types';

export const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
export const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

const RUN_TIME_BUDGET_MS = 90_000;
const QUICK_WINDOW_SECONDS = 2 * 60 * 60;
const HISTORY_OVERLAP_SECONDS = 5 * 60;
const QUICK_CONVERSATION_LIMIT = 25;
const DAY_BATCH_CONVERSATION_LIMIT = 20;
const HISTORY_PAGE_LIMIT = 300;
const RUN_MESSAGE_LIMIT = 5_000;
const INCREMENTAL_MESSAGE_LIMIT = 1_000;
const HISTORY_CONCURRENCY = 2;

export type SyncMode = 'bootstrap' | 'latest';

type SyncGlobal = typeof globalThis & {
  __wechatDashboardWorker?: Promise<void>;
  __wechatDashboardWorkerRunId?: number;
};

const syncGlobal = globalThis as SyncGlobal;

interface ProgressTotals {
  conversationsSeen: number;
  conversationsTotal: number;
  conversationsSynced: number;
  conversationsSkipped: number;
  failedConversations: number;
  messagesSeen: number;
  messagesInserted: number;
  truncated: boolean;
}

interface HistoryTarget {
  id: string;
  offset: number;
}

interface HistoryPageResult {
  seen: number;
  inserted: number;
  failed: boolean;
  unsupported: boolean;
  complete: boolean;
}

export function syncInProgress() {
  return databaseSyncInProgress();
}

export function startViewerScheduledSync(now = Date.now()) {
  const config = readConfig();
  if (config.demoMode) {
    return { status: 'skipped' as const, reason: 'demo_mode' as const };
  }
  if (
    !config.setupCompleted ||
    !config.privacyConfirmed ||
    !config.accountDirectory
  ) {
    return { status: 'skipped' as const, reason: 'not_configured' as const };
  }
  if (syncInProgress()) {
    return { status: 'running' as const };
  }

  const latestSuccess = getLatestSuccessfulSyncRun();
  const latestAttempt = getLatestSyncRun();
  const timing = automaticSyncTiming({
    now,
    intervalMs: AUTO_SYNC_INTERVAL_MS,
    lastSuccessAt: latestSuccess?.completed_at ?? null,
    lastAttemptAt: latestAttempt
      ? (latestAttempt.completed_at ?? latestAttempt.started_at)
      : null,
  });
  if (!timing.due) {
    return { status: 'not_due' as const, next_due_at: timing.nextDueAt };
  }

  const mode: SyncMode =
    coverageSnapshot(new Date(now)).metadata.total === 0 ? 'bootstrap' : 'latest';
  const run = startSync(mode);
  return {
    status: run.started ? ('started' as const) : ('running' as const),
    mode,
    run_id: run.runId,
    next_due_at: now + AUTO_SYNC_INTERVAL_MS,
  };
}

export function startSync(mode: SyncMode): { runId: number; started: boolean } {
  const run = beginSyncRun(mode);
  const persistedMode = getSyncRun(run.runId)?.mode;
  const workerMode: SyncMode = persistedMode === 'bootstrap' ? 'bootstrap' : 'latest';
  if (
    !syncGlobal.__wechatDashboardWorker ||
    syncGlobal.__wechatDashboardWorkerRunId !== run.runId
  ) {
    syncGlobal.__wechatDashboardWorkerRunId = run.runId;
    syncGlobal.__wechatDashboardWorker = performSync(run.runId, workerMode).finally(() => {
      if (syncGlobal.__wechatDashboardWorkerRunId === run.runId) {
        delete syncGlobal.__wechatDashboardWorker;
        delete syncGlobal.__wechatDashboardWorkerRunId;
      }
    });
  }
  return run;
}

async function performSync(runId: number, mode: SyncMode) {
  const config = readConfig();
  const progress = emptyProgress();

  try {
    if (config.demoMode) {
      finishSyncRun(runId, 'ok');
      return;
    }
    if (!config.setupCompleted || !config.privacyConfirmed) {
      throw new SyncConfigurationError();
    }

    assertPinnedWeChatAccount();
    const deadline = Date.now() + RUN_TIME_BUDGET_MS;
    if (mode === 'bootstrap') {
      await bootstrap(runId, progress, deadline);
    } else {
      await incremental(runId, progress, deadline);
    }

    const status = progress.failedConversations > 0 ? 'partial' : 'ok';
    finishSyncRun(runId, status, {
      ...progress,
      errorCode: status === 'partial' ? 'WX_HISTORY_PARTIAL' : null,
    });
  } catch (error) {
    finishSyncRun(runId, 'failed', {
      ...progress,
      errorCode: syncErrorCode(error),
    });
  }
}

async function bootstrap(
  runId: number,
  progress: ProgressTotals,
  deadline: number,
) {
  updateSyncRun(runId, { phase: 'metadata' });
  const sessions = normalizeSessions(await wxSessions(1_000));
  upsertConversations(sessions);
  progress.conversationsSeen = sessions.length;
  updateProgress(runId, progress, 'metadata');

  const now = Math.floor(Date.now() / 1000);
  const recentSince = now - QUICK_WINDOW_SECONDS;
  const quickTargets = conversationsMissingCoverage(
    recentSince,
    QUICK_CONVERSATION_LIMIT,
  ).map((target) => ({ id: target.id, offset: 0 }));
  progress.conversationsTotal = quickTargets.length;
  updateProgress(runId, progress, 'recent');
  await processHistoryTargets(runId, progress, quickTargets, {
    phase: 'recent',
    since: recentSince,
    until: now,
    deadline,
    backfill: false,
  });

  if (Date.now() >= deadline) return;
  await continueTodayBackfill(runId, progress, deadline, now);
}

async function incremental(
  runId: number,
  progress: ProgressTotals,
  deadline: number,
) {
  updateSyncRun(runId, { phase: 'incremental' });
  const response = await wxNewMessages(INCREMENTAL_MESSAGE_LIMIT);
  const messages = normalizeNewMessages(response.messages);
  upsertConversationsFromNewMessages(messages);

  const grouped = new Map<string, WxNewMessage[]>();
  for (const message of messages) {
    const rows = grouped.get(message.username) ?? [];
    rows.push(message);
    grouped.set(message.username, rows);
  }

  progress.conversationsSeen = grouped.size;
  progress.conversationsTotal = grouped.size;
  progress.messagesSeen += messages.length;
  progress.truncated =
    response.count > messages.length || messages.length >= INCREMENTAL_MESSAGE_LIMIT;
  for (const [conversationId, rows] of grouped) {
    const inserted = bulkInsertMessages(conversationId, rows);
    progress.messagesInserted += inserted.inserted;
    progress.conversationsSynced++;
    recordConversationSync(conversationId, {
      status: progress.truncated ? 'partial' : 'ok',
      truncated: progress.truncated,
    });
  }
  updateProgress(runId, progress, 'incremental');

  if (Date.now() >= deadline) return;
  await reconcileIfDue(runId, progress, deadline);
  if (Date.now() >= deadline) return;
  await continueTodayBackfill(
    runId,
    progress,
    deadline,
    Math.floor(Date.now() / 1000),
  );
}

async function reconcileIfDue(
  runId: number,
  progress: ProgressTotals,
  deadline: number,
) {
  const lastReconcile = getAppStateNumber('last_reconcile_at') ?? 0;
  if (Date.now() - lastReconcile < RECONCILE_INTERVAL_MS) return;

  updateSyncRun(runId, { phase: 'reconcile' });
  const sessions = normalizeSessions(await wxSessions(1_000));
  upsertConversations(sessions);
  progress.conversationsSeen = Math.max(progress.conversationsSeen, sessions.length);

  const now = Math.floor(Date.now() / 1000);
  const targets = conversationsNeedingReconcile(
    DAY_BATCH_CONVERSATION_LIMIT,
    now - QUICK_WINDOW_SECONDS,
  ).map(
    (target) => ({
      id: target.id,
      offset: 0,
      since:
        target.local_timestamp > 0
          ? Math.max(0, target.local_timestamp - HISTORY_OVERLAP_SECONDS)
          : now - QUICK_WINDOW_SECONDS,
    }),
  );
  progress.conversationsTotal += targets.length;

  for (const target of targets) {
    const remainingMessages = RUN_MESSAGE_LIMIT - progress.messagesSeen;
    if (Date.now() >= deadline || remainingMessages <= 0) break;
    const result = await syncHistoryPage(
      target.id,
      target.since,
      now,
      0,
      Math.min(HISTORY_PAGE_LIMIT, remainingMessages),
      false,
    );
    mergeHistoryResult(progress, result);
    updateProgress(runId, progress, 'reconcile');
  }

  if (targets.length < DAY_BATCH_CONVERSATION_LIMIT && Date.now() < deadline) {
    setAppState('last_reconcile_at', String(Date.now()));
  }
}

async function continueTodayBackfill(
  runId: number,
  progress: ProgressTotals,
  deadline: number,
  nowSeconds: number,
) {
  const since = startOfTodaySeconds();
  const targets = pendingBackfillConversations(
    since,
    DAY_BATCH_CONVERSATION_LIMIT,
  ).map((target) => ({
    id: target.id,
    offset: target.backfill_since === since ? target.backfill_offset : 0,
  }));
  if (targets.length === 0) return;

  progress.conversationsTotal += targets.length;
  updateProgress(runId, progress, 'today');
  await processHistoryTargets(runId, progress, targets, {
    phase: 'today',
    since,
    until: nowSeconds,
    deadline,
    backfill: true,
  });
}

async function processHistoryTargets(
  runId: number,
  progress: ProgressTotals,
  targets: HistoryTarget[],
  options: {
    phase: 'recent' | 'today';
    since: number;
    until: number;
    deadline: number;
    backfill: boolean;
  },
) {
  let index = 0;
  let remainingMessages = RUN_MESSAGE_LIMIT - progress.messagesSeen;
  while (
    index < targets.length &&
    remainingMessages > 0 &&
    Date.now() < options.deadline
  ) {
    const pair = targets.slice(index, index + HISTORY_CONCURRENCY);
    const targetsRemaining = targets.length - index;
    const fairLimit = Math.max(
      1,
      Math.min(HISTORY_PAGE_LIMIT, Math.floor(remainingMessages / targetsRemaining)),
    );
    const results = await Promise.all(
      pair.map((target) =>
        syncHistoryPage(
          target.id,
          options.since,
          options.until,
          target.offset,
          fairLimit,
          options.backfill,
        ),
      ),
    );
    for (const result of results) {
      mergeHistoryResult(progress, result);
      remainingMessages -= result.seen;
    }
    index += pair.length;
    updateProgress(runId, progress, options.phase);
  }

  if (index < targets.length || remainingMessages <= 0) {
    progress.conversationsSkipped += targets.length - index;
    updateProgress(runId, progress, options.phase);
  }
}

async function syncHistoryPage(
  conversationId: string,
  since: number,
  until: number,
  offset: number,
  limit: number,
  backfill: boolean,
): Promise<HistoryPageResult> {
  try {
    const raw = await readHistoryPage(conversationId, since, until, limit, offset);
    const timestamps = raw
      .map((message) => Number(message.timestamp) || 0)
      .filter((timestamp) => timestamp > 0);
    const messages = raw.filter(
      (message) => message.timestamp >= since && message.timestamp <= until,
    );
    const inserted = bulkInsertMessages(conversationId, messages);
    const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const complete = raw.length < limit || oldest === null || oldest <= since;
    recordConversationSync(conversationId, {
      status: complete ? 'ok' : 'partial',
      truncated: !complete,
      coverageSince: complete ? since : undefined,
      coverageUntil: complete ? until : undefined,
      backfillSince: backfill ? since : undefined,
      backfillOffset: backfill ? (complete ? 0 : offset + raw.length) : undefined,
      backfillComplete: backfill ? complete : undefined,
    });
    return {
      seen: raw.length,
      inserted: inserted.inserted,
      failed: false,
      unsupported: false,
      complete,
    };
  } catch (error) {
    if (error instanceof UnsupportedConversationError) {
      return markConversationUnsupported(conversationId, backfill, since, error.code);
    }
    if (shouldAbandonPrivateConversation(conversationId)) {
      return markConversationUnsupported(
        conversationId,
        backfill,
        since,
        'WX_PRIVATE_RETRY_LIMIT',
      );
    }
    recordConversationSync(conversationId, {
      status: 'failed',
      lastError: 'WX_HISTORY_UNAVAILABLE',
      failedChunk: true,
      truncated: true,
      backfillSince: backfill ? since : undefined,
      backfillOffset: backfill ? offset : undefined,
      backfillComplete: backfill ? false : undefined,
    });
    return { seen: 0, inserted: 0, failed: true, unsupported: false, complete: false };
  }
}

function shouldAbandonPrivateConversation(conversationId: string): boolean {
  const lookup = conversationLookup(conversationId);
  const previousFailures = getConversationSyncState(conversationId)?.failed_chunks ?? 0;
  return lookup?.chatType === 'private' && previousFailures >= 2;
}

function markConversationUnsupported(
  conversationId: string,
  backfill: boolean,
  since: number,
  errorCode: string,
): HistoryPageResult {
  recordConversationSync(conversationId, {
    status: 'unsupported',
    lastError: errorCode,
    truncated: false,
    backfillSince: backfill ? since : undefined,
    backfillOffset: backfill ? 0 : undefined,
    backfillComplete: backfill ? true : undefined,
  });
  return {
    seen: 0,
    inserted: 0,
    failed: false,
    unsupported: true,
    complete: true,
  };
}

async function readHistoryPage(
  conversationId: string,
  since: number,
  until: number,
  limit: number,
  offset: number,
): Promise<WxMessage[]> {
  const sinceDate = localDate(new Date(since * 1000));
  const untilDate = localDate(new Date(until * 1000));
  try {
    return await wxHistory(
      conversationId,
      sinceDate,
      untilDate,
      limit,
      offset,
    );
  } catch (error) {
    if (!isWxConversationNotFound(error)) throw error;
    const lookup = conversationLookup(conversationId);
    const lookupName = lookup?.name;
    if (!lookupName || lookupName === conversationId) {
      if (lookup?.chatType !== 'private') throw error;
      throw new UnsupportedConversationError();
    }
    try {
      return await wxHistory(lookupName, sinceDate, untilDate, limit, offset);
    } catch (fallbackError) {
      if (isWxConversationNotFound(fallbackError)) {
        if (lookup?.chatType !== 'private') throw fallbackError;
        throw new UnsupportedConversationError();
      }
      throw fallbackError;
    }
  }
}

function mergeHistoryResult(progress: ProgressTotals, result: HistoryPageResult) {
  progress.messagesSeen += result.seen;
  progress.messagesInserted += result.inserted;
  if (result.failed) {
    progress.failedConversations++;
  } else if (result.unsupported) {
    progress.conversationsSkipped++;
  } else {
    progress.conversationsSynced++;
  }
  if (!result.complete) progress.truncated = true;
}

function updateProgress(runId: number, progress: ProgressTotals, phase: string) {
  updateSyncRun(runId, { phase, ...progress });
}

function normalizeSessions(sessions: WxSession[]): WxSession[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (!session || typeof session.username !== 'string' || !session.username.trim()) return false;
    if (seen.has(session.username)) return false;
    seen.add(session.username);
    return session.chat_type === 'group' || session.chat_type === 'private';
  });
}

function normalizeNewMessages(messages: WxNewMessage[]): WxNewMessage[] {
  return messages.filter(
    (message) =>
      message &&
      typeof message.username === 'string' &&
      Boolean(message.username) &&
      (message.chat_type === 'group' || message.chat_type === 'private') &&
      Number.isFinite(message.timestamp) &&
      message.timestamp > 0,
  );
}

function emptyProgress(): ProgressTotals {
  return {
    conversationsSeen: 0,
    conversationsTotal: 0,
    conversationsSynced: 0,
    conversationsSkipped: 0,
    failedConversations: 0,
    messagesSeen: 0,
    messagesInserted: 0,
    truncated: false,
  };
}

function syncErrorCode(error: unknown): string {
  if (error instanceof WeChatAccountChangedError) return error.code;
  if (error instanceof EncryptionKeyUnavailableError) return error.code;
  if (error instanceof SyncConfigurationError) return error.code;
  return 'WECHAT_READER_UNAVAILABLE';
}

function startOfTodaySeconds(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

class SyncConfigurationError extends Error {
  readonly code = 'DASHBOARD_NOT_CONFIGURED';
}

class UnsupportedConversationError extends Error {
  readonly code = 'WX_CONVERSATION_UNRESOLVABLE';
}
