import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getLatestSuccessfulSyncRun,
  getLatestSyncRun,
  getSyncRun,
} from '@/lib/conversations';
import {
  AUTO_SYNC_INTERVAL_MS,
  startSync,
  syncInProgress,
} from '@/lib/sync-service';

export const dynamic = 'force-dynamic';

const SyncRequestSchema = z.object({
  mode: z.enum(['bootstrap', 'latest']).default('latest'),
});

export async function GET(request: NextRequest) {
  const runId = Number(new URL(request.url).searchParams.get('run_id'));
  return NextResponse.json({
    ok: true,
    syncing: syncInProgress(),
    interval_ms: AUTO_SYNC_INTERVAL_MS,
    run: Number.isSafeInteger(runId) && runId > 0 ? getSyncRun(runId) : null,
    latest_run: getLatestSyncRun(),
    latest_success: getLatestSuccessfulSyncRun(),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const parsed = SyncRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: 'INVALID_SYNC_REQUEST', error: '同步参数无效。' },
      { status: 400 },
    );
  }

  try {
    const run = startSync(parsed.data.mode);
    return NextResponse.json(
      {
        ok: true,
        accepted: run.started,
        run_id: run.runId,
      },
      { status: 202 },
    );
  } catch {
    return NextResponse.json(
      { ok: false, code: 'SYNC_START_FAILED', error: '无法创建本地同步任务。' },
      { status: 500 },
    );
  }
}
