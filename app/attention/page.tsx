'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AtSign,
  BellRing,
  BrainCircuit,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  MessageCircleWarning,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { DASHBOARD_REFRESH_EVENT } from '@/lib/dashboard-refresh-events';

type AttentionStatus = 'open' | 'handled' | 'dismissed';
type AttentionItem = {
  id: string;
  platform: 'wechat' | 'feishu';
  chat_type: 'group' | 'private';
  group_name: string;
  category:
    | 'mention'
    | 'customer_emotion'
    | 'urgent'
    | 'no_response'
    | 'conflict'
    | 'no_solution';
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;
  title: string;
  detail: string;
  suggested_action: string;
  evidence_count: number;
  status: AttentionStatus;
  analysis_model: string;
  last_detected_at: number;
};

type AttentionResponse = {
  ok: boolean;
  day: string;
  alerts: AttentionItem[];
  counts: { open: number; critical: number; high: number; mentions: number };
  intelligence: {
    analysis_model: string | null;
    display_model: string | null;
    display_reasoning?: string | null;
    imported_at: number | null;
    last_imported_at?: number | null;
  } | null;
};

const CATEGORY_LABELS: Record<AttentionItem['category'], string> = {
  mention: '@ 我的信息',
  customer_emotion: '客户情绪',
  urgent: '紧急问题',
  no_response: '迟迟未回复',
  conflict: '矛盾冲突',
  no_solution: '尚无解决方案',
};

export default function AttentionPage() {
  const [date, setDate] = useState(localToday);
  const [data, setData] = useState<AttentionResponse | null>(null);
  const [filter, setFilter] = useState<AttentionStatus>('open');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/attention?date=${date}`, { cache: 'no-store' });
      const next = (await response.json()) as AttentionResponse;
      if (!response.ok || !next.ok) throw new Error('无法读取重点关注提示');
      setData(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取重点关注提示');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = window.setInterval(load, 60_000);
    const reloadUpdatedData = () => void load();
    window.addEventListener(DASHBOARD_REFRESH_EVENT, reloadUpdatedData);
    window.addEventListener('focus', reloadUpdatedData);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(refresh);
      window.removeEventListener(DASHBOARD_REFRESH_EVENT, reloadUpdatedData);
      window.removeEventListener('focus', reloadUpdatedData);
    };
  }, [load]);

  const visible = useMemo(
    () => data?.alerts.filter((alert) => alert.status === filter) ?? [],
    [data?.alerts, filter],
  );

  async function updateStatus(id: string, status: AttentionStatus) {
    const response = await fetch('/api/attention', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    if (!response.ok) {
      setError('提示状态更新失败');
      return;
    }
    await load();
  }

  return (
    <div className="flex h-screen bg-[var(--bg)]">
      <Sidebar />
      <main id="main-content" className="modern-page">
        <header className="modern-page-header">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <BellRing size={18} className="mt-1 text-[var(--accent)]" />
              <div>
                <div className="report-kicker">10 Min · Agent Intelligence</div>
                <h1>重点关注提示</h1>
                <p>
                  左侧先看微信，右侧查看飞书；群聊与已授权私信使用同一套证据标准。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="date-control">
                <CalendarDays size={14} />
                <input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  className="theme-date-input bg-transparent outline-none"
                />
              </label>
              <button className="btn" onClick={() => void load()} disabled={loading}>
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                刷新页面
              </button>
            </div>
          </div>
        </header>

        <div className="attention-body">
          <div className="attention-counts">
            <CountCard icon={<BellRing size={16} />} label="待关注" value={data?.counts.open ?? 0} />
            <CountCard icon={<ShieldAlert size={16} />} label="最高优先" value={(data?.counts.critical ?? 0) + (data?.counts.high ?? 0)} tone="danger" />
            <CountCard icon={<AtSign size={16} />} label="@ 我的信息" value={data?.counts.mentions ?? 0} />
            <CountCard
              icon={<BrainCircuit size={16} />}
              label="分析引擎"
              value={modelLabel(
                data?.intelligence?.display_model,
                data?.intelligence?.display_reasoning,
              )}
              text
            />
          </div>

          <div className="attention-toolbar">
            <div className="attention-tabs">
              {(['open', 'handled', 'dismissed'] as AttentionStatus[]).map((status) => (
                <button
                  key={status}
                  className={filter === status ? 'attention-tab-active' : ''}
                  onClick={() => setFilter(status)}
                >
                  {{ open: '待关注', handled: '已处理', dismissed: '已忽略' }[status]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-3)]">
              <Clock3 size={12} />
              已处理与已忽略事项不会重复提示 · 恢复后可重新进入待关注
            </div>
          </div>

          {error && <div className="mt-4 rounded-md bg-[var(--danger-soft)] px-4 py-3 text-[13px] text-[var(--danger)]">{error}</div>}

          <div className="attention-platform-grid">
            <AttentionColumn
              platform="wechat"
              alerts={visible.filter((alert) => alert.platform === 'wechat')}
              onStatus={updateStatus}
            />
            <AttentionColumn
              platform="feishu"
              alerts={visible.filter((alert) => alert.platform === 'feishu')}
              onStatus={updateStatus}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function AttentionColumn({
  platform,
  alerts,
  onStatus,
}: {
  platform: 'wechat' | 'feishu';
  alerts: AttentionItem[];
  onStatus: (id: string, status: AttentionStatus) => Promise<void>;
}) {
  return (
    <section className="attention-platform-column">
      <header className="platform-dashboard-header compact-platform-header">
        <span className={`platform-chip platform-chip-${platform}`}>
          {platform === 'wechat' ? '微信' : '飞书'}
        </span>
        <div>
          <h2>{platform === 'wechat' ? '微信重点关注' : '飞书重点关注'}</h2>
          <p>{alerts.length} 项</p>
        </div>
      </header>
      <div className="attention-list">
        {alerts.length ? (
          alerts.map((alert) => (
            <AttentionCard key={alert.id} alert={alert} onStatus={onStatus} />
          ))
        ) : (
          <div className="modern-empty compact-empty"><p>当前没有相关提示。</p></div>
        )}
      </div>
    </section>
  );
}

function CountCard({ icon, label, value, tone = 'normal', text = false }: { icon: React.ReactNode; label: string; value: number | string; tone?: 'normal' | 'danger'; text?: boolean }) {
  return (
    <div className={`attention-count ${tone === 'danger' ? 'attention-count-danger' : ''}`}>
      <div className={`flex items-center gap-1.5 text-[11px] ${tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text-3)]'}`}>{icon}{label}</div>
      <div className={`mt-2 font-semibold ${text ? 'text-[16px]' : 'text-[25px]'}`}>{value}</div>
    </div>
  );
}

function AttentionCard({ alert, onStatus }: { alert: AttentionItem; onStatus: (id: string, status: AttentionStatus) => Promise<void> }) {
  const isUrgent = alert.severity === 'critical' || alert.severity === 'high';
  return (
    <article className={`attention-article ${isUrgent ? 'attention-article-urgent' : ''}`}>
      <div className="attention-stripe" />
      <div className="attention-copy">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="attention-category-icon">{categoryIcon(alert.category)}</div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] text-[var(--text-3)]">{CATEGORY_LABELS[alert.category]}</span>
                <span className={`text-[10px] font-semibold uppercase ${isUrgent ? 'text-[var(--danger)]' : 'text-[var(--accent)]'}`}>{severityLabel(alert.severity)}</span>
              </div>
              <h2>{alert.title}</h2>
              <div className="mt-1 text-[11px] text-[var(--text-3)]">{alert.group_name} · {alert.chat_type === 'group' ? '群聊' : '私信'} · {formatTime(alert.last_detected_at)} · {alert.evidence_count} 条证据</div>
            </div>
          </div>
        </div>
        <p className="attention-detail">{alert.detail}</p>
        <div className="attention-action-note">
          <CircleAlert size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <span><strong className="font-semibold">建议动作：</strong>{alert.suggested_action}</span>
        </div>
      </div>
      <div className="attention-actions">
        {alert.status === 'open' && (
          <>
            <button className={`btn ${isUrgent ? 'btn-primary' : ''}`} onClick={() => void onStatus(alert.id, 'handled')}><CheckCircle2 size={13} />已处理</button>
            <button className="btn" onClick={() => void onStatus(alert.id, 'dismissed')}><X size={13} />忽略</button>
          </>
        )}
        {alert.status !== 'open' && (
          <button className="btn" onClick={() => void onStatus(alert.id, 'open')}>
            <RotateCcw size={13} />恢复待关注
          </button>
        )}
        <span>置信度 {alert.confidence.toFixed(2)}</span>
      </div>
    </article>
  );
}

function categoryIcon(category: AttentionItem['category']) {
  if (category === 'mention') return <AtSign size={16} />;
  if (category === 'no_response' || category === 'no_solution') return <Clock3 size={16} />;
  if (category === 'conflict' || category === 'customer_emotion') return <MessageCircleWarning size={16} />;
  return <ShieldAlert size={16} />;
}

function severityLabel(severity: AttentionItem['severity']) {
  return { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }[severity];
}

function modelLabel(
  model: string | null | undefined,
  reasoning: string | null | undefined,
) {
  if (model?.includes('terra') && reasoning === 'high') return 'Terra High';
  if (model?.includes('terra')) return 'Terra · 历史记录';
  return model || '待运行';
}

function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
