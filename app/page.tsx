'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import { Database, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import TopBar, { type ConversationFilter, type RangeKey } from '@/components/TopBar';
import type { CardsData } from '@/components/StatGrid';
import type { TrendPoint } from '@/components/TrendChart';
import type { CoverageData } from '@/components/CoveragePanel';
import PriorityWorkspace, {
  type PriorityWorkspaceData,
} from '@/components/PriorityWorkspace';
import OverviewCockpit, {
  type OverviewAttentionData,
} from '@/components/OverviewCockpit';

const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

type DashboardResponse = {
  ok: boolean;
  error?: string;
  range: RangeKey;
  filter: ConversationFilter;
  platform: 'wechat' | 'feishu';
  window: { since: string; until: string; days: number };
  cards: CardsData;
  trend: TrendPoint[];
  priority_workspace: PriorityWorkspaceData;
  coverage: CoverageData;
  source: {
    kind: 'demo' | 'local_dual';
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
  const filter: ConversationFilter = 'all';
  const [date, setDate] = useState(localToday);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [feishuDashboard, setFeishuDashboard] = useState<DashboardResponse | null>(null);
  const [attention, setAttention] = useState<OverviewAttentionData | null>(null);
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
    const [response, feishuResponse, attentionResponse] = await Promise.all([
      fetch(
        `/api/dashboard?range=${range}&date=${date}&type=${filter}&platform=wechat&q=${encodeURIComponent(activeQuery)}`,
        { cache: 'no-store' },
      ),
      fetch(
        `/api/dashboard?range=${range}&date=${date}&type=${filter}&platform=feishu&q=${encodeURIComponent(activeQuery)}`,
        { cache: 'no-store' },
      ),
      fetch(`/api/attention?date=${date}`, { cache: 'no-store' }),
    ]);
    const [data, feishuData, attentionData] = await Promise.all([
      response.json() as Promise<DashboardResponse>,
      feishuResponse.json() as Promise<DashboardResponse>,
      attentionResponse.json() as Promise<OverviewAttentionData & { ok?: boolean }>,
    ]);
    if (!response.ok || !data.ok) throw new Error(data.error || 'Dashboard load failed');
    if (!feishuResponse.ok || !feishuData.ok) throw new Error(feishuData.error || 'Feishu dashboard load failed');
    setDashboard(data);
    setFeishuDashboard(feishuData);
    if (attentionResponse.ok && attentionData.ok !== false) setAttention(attentionData);
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
      setStatusText(mode === 'bootstrap' ? '正在建立双端安全快照…' : '正在读取微信与飞书新增消息…');
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
          date={date}
          onRangeChange={setRange}
          onDateChange={setDate}
          syncing={syncing || Boolean(dashboard?.source.syncing)}
          onSync={() => void syncNow('latest')}
          onInitialSync={() => void syncNow('bootstrap')}
          statusText={statusText}
          nextSyncAt={nextSyncAt}
        />

        <div className="dashboard-scroll flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1600px]">
            <DashboardStateNotice
              source={dashboard?.source}
              onSync={() => void syncNow('latest')}
              onBootstrap={() => void syncNow('bootstrap')}
            />
            <section className="platform-dashboard-section">
              <header className="platform-dashboard-header">
                <span className="platform-chip platform-chip-wechat">微信</span>
                <div><h2>微信群聊和私信分析</h2><p>本机只读同步 · 微信优先展示</p></div>
              </header>
              <OverviewCockpit
                platform="wechat"
                cards={dashboard?.cards}
                days={dashboard?.window.days ?? 7}
                coverage={dashboard?.coverage}
                priorities={dashboard?.priority_workspace}
                attention={attention}
                lastSuccessAt={dashboard?.source.last_success_at ?? null}
                stale={dashboard?.source.stale ?? true}
              />
            </section>
            <section className="platform-dashboard-section">
              <header className="platform-dashboard-header">
                <span className="platform-chip platform-chip-feishu">飞书</span>
                <div><h2>飞书私信与群聊分析</h2><p>用户身份认证 · 无需本地信息抓取</p></div>
              </header>
              <OverviewCockpit
                platform="feishu"
                cards={feishuDashboard?.cards}
                days={feishuDashboard?.window.days ?? 7}
                coverage={feishuDashboard?.coverage}
                priorities={feishuDashboard?.priority_workspace}
                attention={attention}
                lastSuccessAt={feishuDashboard?.source.last_success_at ?? null}
                stale={feishuDashboard?.source.stale ?? true}
              />
            </section>
            <div id="priority-workspace" className="priority-workspace-wrap">
              <div className="platform-dashboard-header compact-platform-header"><span className="platform-chip platform-chip-wechat">微信</span><div><h2>微信优先群聊</h2></div></div>
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
            <div className="priority-workspace-wrap">
              <div className="platform-dashboard-header compact-platform-header"><span className="platform-chip platform-chip-feishu">飞书</span><div><h2>飞书优先群聊</h2></div></div>
              <PriorityWorkspace
                data={feishuDashboard?.priority_workspace}
                days={feishuDashboard?.window.days ?? 7}
                searchValue={searchQuery}
                onSearchChange={setSearchQuery}
                onToggleStar={(groupId, starred) =>
                  updatePriority({ action: 'set_starred', chatroom_id: groupId, starred }).then(() => undefined)
                }
                onAddKeyword={(keyword) => updatePriority({ action: 'add_keyword', keyword })}
                onRemoveKeyword={(id) => updatePriority({ action: 'remove_keyword', id }).then(() => undefined)}
                saving={prioritySaving}
              />
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
  if (data.source.syncing) return '正在读取微信与飞书最新消息…';
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

function DashboardStateNotice({
  source,
  onSync,
  onBootstrap,
}: {
  source?: DashboardResponse['source'];
  onSync: () => void;
  onBootstrap: () => void;
}) {
  if (!source || source.kind === 'demo') return null;
  if (source.syncing) {
    const run = source.latest_run;
    const progress = run && run.conversations_total > 0
      ? Math.min(100, (run.conversations_synced / run.conversations_total) * 100)
      : 12;
    return (
      <div className="dashboard-state dashboard-state-syncing">
        <div>
          <RefreshCw size={14} className="animate-spin" />
          <strong>{run ? syncProgressText(run) : '正在读取本地微信消息'}</strong>
          <span>同步在本机后台运行，可以继续浏览页面。</span>
        </div>
        <div className="dashboard-state-progress"><span style={{ width: `${progress}%` }} /></div>
      </div>
    );
  }
  if (source.latest_run?.status === 'failed') {
    return (
      <div className="dashboard-state dashboard-state-danger">
        <ShieldAlert size={15} />
        <div>
          <strong>{syncFailureText(source.latest_run.error_code)}</strong>
          <span>现有本机快照已保留；处理前不会继续写入。</span>
        </div>
        <Link href="/setup" className="btn btn-primary">打开本机设置</Link>
      </div>
    );
  }
  if (source.bootstrap_required) {
    return (
      <div className="dashboard-state">
        <Database size={15} />
        <div>
          <strong>等待首次真实数据同步</strong>
          <span>首次只建立会话目录，再补齐最近 2 小时与今日消息。</span>
        </div>
        <button className="btn btn-primary" onClick={onBootstrap}>建立本地快照</button>
      </div>
    );
  }
  if (source.stale) {
    return (
      <div className="dashboard-state dashboard-state-danger">
        <WifiOff size={15} />
        <div>
          <strong>已超过 60 分钟未同步</strong>
          <span>当前数字可能不完整，请检查读取器状态或立即刷新。</span>
        </div>
        <button className="btn btn-primary" onClick={onSync}>立即刷新</button>
      </div>
    );
  }
  return null;
}
