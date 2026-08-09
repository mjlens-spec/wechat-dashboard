'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import TopBar, {
  type ConversationFilter,
  type RangeKey,
} from '@/components/TopBar';
import StatGrid, { type CardsData } from '@/components/StatGrid';
import TrendChart, { type TrendPoint } from '@/components/TrendChart';
import CoveragePanel, { type CoverageData } from '@/components/CoveragePanel';
import PriorityWorkspace, {
  type PriorityWorkspaceData,
} from '@/components/PriorityWorkspace';

const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

type DashboardResponse = {
  ok: boolean;
  error?: string;
  range: RangeKey;
  filter: ConversationFilter;
  window: { since: string; until: string; days: number };
  cards: CardsData;
  trend: TrendPoint[];
  priority_workspace: PriorityWorkspaceData;
  coverage: CoverageData;
  source: {
    kind: 'demo' | 'local_wechat';
    auto_sync_interval_ms: number;
    syncing: boolean;
    last_success_at: number | null;
    stale: boolean;
    bootstrap_required: boolean;
    latest_run: SyncRun | null;
  };
};

type SyncRun = {
      id: number;
      mode: 'bootstrap' | 'latest';
      status: 'running' | 'ok' | 'partial' | 'failed';
      phase: string;
      completed_at: number | null;
      conversations_total: number;
      conversations_synced: number;
      failed_conversations: number;
      messages_seen: number;
      messages_inserted: number;
      truncated: number;
      error_code: string | null;
};

export default function Page() {
  const [range, setRange] = useState<RangeKey>('week');
  const [filter, setFilter] = useState<ConversationFilter>('group');
  const [date, setDate] = useState(localToday);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [setupChecked, setSetupChecked] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [prioritySaving, setPrioritySaving] = useState(false);
  const [statusText, setStatusText] = useState('读取本地快照…');
  const [nextSyncAt, setNextSyncAt] = useState(
    () => Date.now() + AUTO_SYNC_INTERVAL_MS,
  );
  const [, tickClock] = useReducer((value: number) => value + 1, 0);
  const syncLock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/setup', { cache: 'no-store' });
        const setup = (await response.json()) as { configured?: boolean };
        if (!cancelled && !setup.configured) {
          window.location.href = '/setup';
          return;
        }
      } finally {
        if (!cancelled) setSetupChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(async () => {
    const response = await fetch(
      `/api/dashboard?range=${range}&date=${date}&type=${filter}&q=${encodeURIComponent(activeQuery)}`,
      { cache: 'no-store' },
    );
    const data = (await response.json()) as DashboardResponse;
    if (!response.ok || !data.ok) throw new Error(data.error || 'Dashboard load failed');
    setDashboard(data);
    setNextSyncAt(
      data.source.last_success_at
        ? data.source.last_success_at + data.source.auto_sync_interval_ms
        : Date.now(),
    );
    if (!syncLock.current) setStatusText(sourceStatus(data));
    return data;
  }, [activeQuery, date, filter, range]);

  useEffect(() => {
    const timer = window.setTimeout(() => setActiveQuery(searchQuery.trim()), 260);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const updatePriority = useCallback(
    async (payload: Record<string, unknown>) => {
      if (prioritySaving) return false;
      setPrioritySaving(true);
      try {
        const response = await fetch('/api/priorities', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !result.ok) {
          setStatusText(result.error || '优先级设置保存失败');
          return false;
        }
        await reload();
        setStatusText('优先级设置已保存在本机');
        return true;
      } catch {
        setStatusText('优先级设置保存失败');
        return false;
      } finally {
        setPrioritySaving(false);
      }
    },
    [prioritySaving, reload],
  );

  const syncNow = useCallback(
    async (mode: 'latest' | 'bootstrap' = 'latest') => {
      if (syncLock.current) return;
      syncLock.current = true;
      setSyncing(true);
      setStatusText(mode === 'bootstrap' ? '正在建立安全本地快照…' : '正在读取新增微信消息…');
      try {
        const response = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        const data = (await response.json()) as {
          ok: boolean;
          error?: string;
          run_id?: number;
        };
        if (!response.ok || !data.ok) {
          setStatusText(data.error || '本地同步失败');
        } else if (data.run_id) {
          const run = await pollSyncRun(data.run_id, setStatusText);
          if (!run) {
            setStatusText('同步仍在本机后台继续，可稍后查看进度');
          } else if (run.status === 'failed') {
            setStatusText(syncFailureText(run.error_code));
          } else {
            setStatusText(
              run.status === 'partial'
                ? `部分完成 · 新增 ${run.messages_inserted} 条，${run.failed_conversations} 个会话待重试`
                : `同步完成 · 新增 ${run.messages_inserted} 条`,
            );
          }
        }
      } catch {
        setStatusText('本地同步失败，请检查读取器状态');
      } finally {
        syncLock.current = false;
        setSyncing(false);
        setNextSyncAt(Date.now() + AUTO_SYNC_INTERVAL_MS);
        try {
          await reload();
        } catch {
          // Keep the actionable sync error already shown in the header.
        }
      }
    },
    [reload],
  );

  useEffect(() => {
    if (!setupChecked) return;
    const timer = window.setTimeout(() => {
      void reload().catch(() => setStatusText('无法读取本地 Dashboard 数据库'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload, setupChecked]);

  useEffect(() => {
    if (!setupChecked) return;
    const refresh = window.setInterval(() => {
      if (!syncLock.current) {
        void reload().catch(() => setStatusText('无法读取本地 Dashboard 数据库'));
      }
    }, 60_000);
    const clock = window.setInterval(tickClock, 1_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(clock);
    };
  }, [reload, setupChecked]);

  if (!setupChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] text-[13px] text-[var(--text-3)]">
        检查本机配置…
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[var(--bg)]">
      <Sidebar />
      <main id="main-content" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          range={range}
          filter={filter}
          date={date}
          onRangeChange={setRange}
          onFilterChange={setFilter}
          onDateChange={setDate}
          syncing={syncing || Boolean(dashboard?.source.syncing)}
          onSync={() => void syncNow('latest')}
          onInitialSync={() => void syncNow('bootstrap')}
          statusText={statusText}
          nextSyncAt={nextSyncAt}
        />

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto w-full max-w-[1440px]">
            <StatGrid
              cards={dashboard?.cards}
              days={dashboard?.window.days ?? 7}
              lastSuccessAt={dashboard?.source.last_success_at ?? null}
              stale={dashboard?.source.stale ?? true}
            />
            <div className="mt-4">
              <CoveragePanel coverage={dashboard?.coverage} />
            </div>
            <div className="mt-4">
              <PriorityWorkspace
                data={dashboard?.priority_workspace}
                days={dashboard?.window.days ?? 7}
                searchValue={searchQuery}
                onSearchChange={setSearchQuery}
                onToggleStar={(groupId, starred) =>
                  updatePriority({
                    action: 'set_starred',
                    chatroom_id: groupId,
                    starred,
                  }).then(() => undefined)
                }
                onAddKeyword={(keyword) =>
                  updatePriority({ action: 'add_keyword', keyword })
                }
                onRemoveKeyword={(id) =>
                  updatePriority({ action: 'remove_keyword', id }).then(() => undefined)
                }
                saving={prioritySaving}
              />
            </div>
            <div className="mt-4">
              <TrendChart data={dashboard?.trend ?? []} />
            </div>
            <div className="mt-4 pb-2 text-center text-[11px] text-[var(--text-3)]">
              数据源：本机微信 Mac 客户端 · SQLite 快照只保存在本机 · 页面打开时每 30 分钟刷新
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function sourceStatus(data: DashboardResponse) {
  if (data.source.kind === 'demo') return '示例数据 · 不读取真实微信';
  if (data.source.syncing) return '正在读取最新微信消息…';
  if (!data.source.last_success_at) return '等待首次真实数据同步';
  if (data.source.latest_run?.status === 'partial') return '最近一次同步部分完成';
  if (data.source.latest_run?.status === 'failed') return '读取器需要处理';
  return `最后同步 ${new Date(data.source.last_success_at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

async function pollSyncRun(
  runId: number,
  onProgress: (text: string) => void,
): Promise<SyncRun | null> {
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    const response = await fetch(`/api/sync?run_id=${runId}`, { cache: 'no-store' });
    const data = (await response.json()) as { ok: boolean; run: SyncRun | null };
    const run = data.run;
    if (run) {
      onProgress(syncProgressText(run));
      if (run.status !== 'running') return run;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
  }
  return null;
}

function syncProgressText(run: SyncRun) {
  const phase: Record<string, string> = {
    queued: '准备同步',
    metadata: '更新会话目录',
    recent: '同步最近 2 小时',
    incremental: '读取新增消息',
    reconcile: '进行每小时对账',
    today: '分批补齐今日消息',
  };
  const label = phase[run.phase] ?? '同步本地数据';
  if (run.conversations_total > 0) {
    return `${label} · ${Math.min(run.conversations_synced, run.conversations_total)} / ${run.conversations_total}`;
  }
  return label;
}

function syncFailureText(code: string | null) {
  if (code === 'WECHAT_ACCOUNT_CHANGED') return '检测到微信账号变化，已暂停同步';
  if (code === 'ENCRYPTION_KEY_UNAVAILABLE') return '无法访问 macOS Keychain 加密密钥';
  if (code === 'DASHBOARD_NOT_CONFIGURED') return '请先完成本机设置';
  return '本地读取器暂不可用，请打开设置检查状态';
}
