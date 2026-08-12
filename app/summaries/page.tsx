'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  BrainCircuit,
  CalendarDays,
  CheckCircle2,
  FileText,
  ListTodo,
  MessagesSquare,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { DASHBOARD_REFRESH_EVENT } from '@/lib/dashboard-refresh-events';

type SummaryItem = {
  day: string;
  group_id: string;
  group_name: string;
  platform: 'wechat' | 'feishu';
  chat_type: 'group' | 'private';
  overview: string;
  highlights: string[];
  decisions: string[];
  action_items: Array<{
    text: string;
    owner: string | null;
    due: string | null;
    status: string;
  }>;
  risks: string[];
  evidence_count: number;
  analysis_model: string;
  generated_at: number;
};

type SummaryResponse = {
  ok: boolean;
  day: string;
  summaries: SummaryItem[];
  last_generated_at: number | null;
  next_due_at: number;
  intelligence: {
    status: string;
    analysis_model: string | null;
    display_model: string | null;
    display_reasoning?: string | null;
    imported_at: number | null;
    last_imported_at?: number | null;
  } | null;
};

export default function SummariesPage() {
  const [date, setDate] = useState(localToday);
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/summaries?date=${date}`, { cache: 'no-store' });
      const next = (await response.json()) as SummaryResponse;
      if (!response.ok || !next.ok) throw new Error('无法读取群聊汇总');
      setData(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取群聊汇总');
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

  return (
    <div className="flex h-screen bg-[var(--bg)]">
      <Sidebar />
      <main id="main-content" className="modern-page">
        <header className="modern-page-header">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <FileText size={18} className="mt-1 text-[var(--accent)]" />
              <div>
                <div className="report-kicker">10 Min · Agent Intelligence</div>
                <h1>会话汇总</h1>
                <p>
                  微信与飞书分区展示；每个群聊或私信独立汇总，每 15 分钟由当前 Terra High 任务更新。
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

        <div className="modern-page-body">
          <StatusStrip data={data} />
          {error && (
            <div className="mt-4 rounded-md bg-[var(--danger-soft)] px-4 py-3 text-[13px] text-[var(--danger)]">
              {error}
            </div>
          )}
          <div className="summary-platform-grid">
            {(['wechat', 'feishu'] as const).map((platform) => {
              const summaries = data?.summaries.filter((summary) => summary.platform === platform) ?? [];
              return (
                <section className="summary-platform-section" key={platform}>
                  <header className="platform-dashboard-header compact-platform-header">
                    <span className={`platform-chip platform-chip-${platform}`}>{platform === 'wechat' ? '微信' : '飞书'}</span>
                    <div><h2>{platform === 'wechat' ? '微信会话汇总' : '飞书会话汇总'}</h2></div>
                  </header>
                  <div className="summary-list">
                    {summaries.length ? summaries.map((summary) => (
                      <GroupSummaryCard key={summary.group_id} summary={summary} />
                    )) : (
                      <div className="modern-empty compact-empty"><p>{loading ? '正在读取会话汇总…' : '当前没有该平台的会话汇总。'}</p></div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}

function StatusStrip({ data }: { data: SummaryResponse | null }) {
  return (
    <div className="engine-strip">
      <div className="flex items-center gap-2 text-[13px] text-[var(--text-2)]">
        <BrainCircuit size={15} className="text-[var(--accent)]" />
        <span>
          分析引擎：{displayModel(
            data?.intelligence?.display_model,
            data?.intelligence?.display_reasoning,
          )}
        </span>
      </div>
      <div className="text-[12px] text-[var(--text-3)]">
        {data?.last_generated_at
          ? `最近更新 ${formatTime(data.last_generated_at)} · 下次应更新 ${formatTime(data.next_due_at)}`
          : '尚无今日汇总'}
      </div>
    </div>
  );
}

function GroupSummaryCard({ summary }: { summary: SummaryItem }) {
  return (
    <article className="summary-article">
      <div className="summary-article-header">
        <div className="flex min-w-0 items-center gap-3">
          <div className="summary-group-icon">
            <MessagesSquare size={17} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-semibold">{summary.group_name}</h2>
            <div className="mt-1 text-[11px] text-[var(--text-3)]">
              独立{summary.chat_type === 'group' ? '群聊' : '私信'}汇总 · {summary.evidence_count} 条证据 · {formatTime(summary.generated_at)}
            </div>
          </div>
        </div>
        <span className="signal-chip rounded-full px-2.5 py-1 text-[11px]">
          {summary.analysis_model}
        </span>
      </div>
      <div>
        <p className="summary-overview">{summary.overview}</p>
        <div className="summary-quadrants">
          <SummarySection icon={<Sparkles size={14} />} title="重要进展" items={summary.highlights} />
          <SummarySection icon={<CheckCircle2 size={14} />} title="结论与决定" items={summary.decisions} />
          <ActionSection items={summary.action_items} />
          <SummarySection
            icon={<TriangleAlert size={14} />}
            title="仍需留意"
            items={summary.risks}
            tone="warn"
          />
        </div>
      </div>
    </article>
  );
}

function SummarySection({
  icon,
  title,
  items,
  tone = 'normal',
}: {
  icon: React.ReactNode;
  title: string;
  items: string[];
  tone?: 'normal' | 'warn';
}) {
  if (items.length === 0) return null;
  return (
    <section className={`summary-quadrant ${tone === 'warn' ? 'summary-quadrant-warn' : ''}`}>
      <h3>
        {icon}
        {title}
      </h3>
      <ul>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>
            <span className="summary-bullet" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActionSection({ items }: { items: SummaryItem['action_items'] }) {
  if (items.length === 0) return null;
  return (
    <section className="summary-quadrant">
      <h3>
        <ListTodo size={14} />
        待办事项
      </h3>
      <ul className="action-list">
        {items.map((item, index) => (
          <li key={`${item.text}-${index}`}>
            <div>{item.text}</div>
            {(item.owner || item.due) && (
              <div className="mt-0.5 text-[11px] text-[var(--text-3)]">
                {[item.owner && `负责人：${item.owner}`, item.due && `时间：${item.due}`]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function displayModel(
  model: string | null | undefined,
  reasoning: string | null | undefined,
) {
  if (model?.includes('terra') && reasoning === 'high') return 'Terra High';
  if (model?.includes('terra')) return 'Terra · 历史强度未记录';
  return model || '等待首次分析';
}
