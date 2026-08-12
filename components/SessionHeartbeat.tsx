'use client';

import { useEffect, useRef } from 'react';
import {
  DASHBOARD_REFRESH_EVENT,
  type DashboardRefreshReason,
} from '@/lib/dashboard-refresh-events';
import { UPDATE_INTERVAL_MS } from '@/lib/update-cadence.mjs';

const HEARTBEAT_INTERVAL_MS = 30_000;
const SYNC_POLL_INTERVAL_MS = 1_500;
const SYNC_POLL_TIMEOUT_MS = 100_000;

type HeartbeatResponse = {
  ok: boolean;
  sync?: {
    status: 'started' | 'running' | 'not_due' | 'skipped' | 'not_managed' | 'error';
    run_id?: number | null;
  };
  intelligence?: {
    imported_at?: number | null;
    last_imported_at?: number | null;
  } | null;
};

type SyncStatusResponse = {
  ok: boolean;
  run?: { status: 'running' | 'ok' | 'partial' | 'failed' } | null;
};

export default function SessionHeartbeat() {
  const lastImportedAt = useRef<number | null>(null);
  const pollingRunId = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pageRefreshStarted = false;
    const pageRefreshDueAt = Date.now() + UPDATE_INTERVAL_MS;

    const notify = (reason: DashboardRefreshReason) => {
      window.dispatchEvent(
        new CustomEvent(DASHBOARD_REFRESH_EVENT, { detail: { reason } }),
      );
    };

    const pollSync = async (runId: number) => {
      if (pollingRunId.current === runId) return;
      pollingRunId.current = runId;
      const deadline = Date.now() + SYNC_POLL_TIMEOUT_MS;
      try {
        while (!cancelled && Date.now() < deadline) {
          const response = await fetch(`/api/sync?run_id=${runId}`, {
            cache: 'no-store',
          });
          const result = (await response.json()) as SyncStatusResponse;
          if (!response.ok || !result.ok) return;
          if (result.run && result.run.status !== 'running') {
            notify('content-sync-completed');
            return;
          }
          await new Promise((resolve) =>
            window.setTimeout(resolve, SYNC_POLL_INTERVAL_MS),
          );
        }
      } catch {
        // The normal page polling remains the fallback for a transient failure.
      } finally {
        if (pollingRunId.current === runId) pollingRunId.current = null;
      }
    };

    const heartbeat = async () => {
      try {
        const response = await fetch('/api/session/heartbeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store',
          keepalive: true,
        });
        if (!response.ok) return;
        const result = (await response.json()) as HeartbeatResponse;
        if (!result.ok || cancelled) return;

        const runId = result.sync?.run_id;
        if (
          Number.isSafeInteger(runId) &&
          runId &&
          (result.sync?.status === 'started' || result.sync?.status === 'running')
        ) {
          void pollSync(runId);
        }

        const importedAt =
          result.intelligence?.last_imported_at ??
          result.intelligence?.imported_at ??
          null;
        if (
          lastImportedAt.current !== null &&
          importedAt !== null &&
          importedAt > lastImportedAt.current
        ) {
          notify('semantic-analysis-imported');
        }
        lastImportedAt.current = importedAt;
      } catch {
        // A closed or expired local session needs no browser-side recovery.
      }
    };

    const refreshPageWhenDue = () => {
      if (
        pageRefreshStarted ||
        Date.now() < pageRefreshDueAt
      ) {
        return;
      }
      pageRefreshStarted = true;
      window.location.reload();
    };

    void heartbeat();
    const interval = window.setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
    const pageRefresh = window.setTimeout(refreshPageWhenDue, UPDATE_INTERVAL_MS);
    const resume = () => {
      if (document.visibilityState === 'visible') {
        refreshPageWhenDue();
        if (!pageRefreshStarted) void heartbeat();
      }
    };
    const focus = () => {
      refreshPageWhenDue();
      if (!pageRefreshStarted) void heartbeat();
    };
    window.addEventListener('focus', focus);
    window.addEventListener('online', heartbeat);
    document.addEventListener('visibilitychange', resume);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(pageRefresh);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', heartbeat);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);

  return null;
}
