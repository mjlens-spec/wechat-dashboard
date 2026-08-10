import { NextRequest, NextResponse } from 'next/server';
import { readConfig } from '@/lib/config';
import {
  coverageSnapshot,
  dashboardSnapshot,
  getLatestSuccessfulSyncRun,
  getLatestSyncRun,
  type ConversationFilter,
  type PlatformFilter,
} from '@/lib/conversations';
import { normalizeDate, normalizeRangeKey, rangeToWindow } from '@/lib/range';
import { AUTO_SYNC_INTERVAL_MS, syncInProgress } from '@/lib/sync-service';
import { priorityWorkspace } from '@/lib/conversation-priorities';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const range = normalizeRangeKey(url.searchParams.get('range'), 'week');
  const anchorDate = normalizeDate(url.searchParams.get('date'));
  const filter = normalizeConversationFilter(url.searchParams.get('type'));
  const platform = normalizePlatformFilter(url.searchParams.get('platform'));
  const search = (url.searchParams.get('q') ?? '').normalize('NFKC').trim().slice(0, 128);
  const window = rangeToWindow(range, anchorDate);
  const config = readConfig();
  const latestRun = getLatestSyncRun();
  const latestSuccess = getLatestSuccessfulSyncRun();
  const snapshot = dashboardSnapshot(window.since, window.until, filter, platform);
  const coverage = coverageSnapshot(new Date(), platform);
  const priorities = priorityWorkspace(window.since, window.until, search, platform);

  return NextResponse.json({
    ok: true,
    range,
    filter,
    platform,
    window,
    ...snapshot,
    priority_workspace: priorities,
    coverage,
    source: {
      kind: config.demoMode ? 'demo' : 'local_dual',
      platform,
      auto_sync_interval_ms: AUTO_SYNC_INTERVAL_MS,
      syncing: syncInProgress() || latestRun?.status === 'running',
      latest_run: latestRun,
      last_success_at: latestSuccess?.completed_at ?? null,
      bootstrap_required: coverage.metadata.total === 0,
      stale:
        !config.demoMode &&
        (!latestSuccess?.completed_at ||
          Date.now() - latestSuccess.completed_at > AUTO_SYNC_INTERVAL_MS * 2),
    },
  });
}

function normalizePlatformFilter(value: string | null): PlatformFilter {
  if (value === 'wechat' || value === 'feishu') return value;
  return 'all';
}

function normalizeConversationFilter(value: string | null): ConversationFilter {
  if (value === 'group' || value === 'private') return value;
  return 'all';
}
