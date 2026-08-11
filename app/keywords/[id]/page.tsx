'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  CalendarDays,
  Hash,
  MessageSquareText,
  RefreshCw,
  Tags,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { DASHBOARD_REFRESH_EVENT } from '@/lib/dashboard-refresh-events';

type KeywordSource = 'wechat' | 'feishu' | 'all';
type KeywordRange = 'day' | 'week' | 'month';

type KeywordResponse = {
  ok: boolean;
  range: KeywordRange;
  date: string;
  keyword: { id: string; keyword: string; source: KeywordSource };
  window: { since: string; until: string; days: number };
  counts: { matches: number; conversations: number; wechat: number; feishu: number };
  trend: Array<{ date: string; wechat: number; feishu: number; total: number }>;
  conversations: Array<{
    id: string;
    name: string;
    platform: 'wechat' | 'feishu';
    chat_type: 'group' | 'private';
    match_count: number;
    latest_at: number;
    matches: Array<{
      message_id: string;
      sender: string;
      content: string;
      time: string;
      timestamp: number;
      date: string;
      matched_in: 'name' | 'message' | 'both';
    }>;
  }>;
  message_scan: {
    scanned: number;
    truncated: boolean;
    visible_matches: number;
    result_truncated: boolean;
  };
  error?: string;
};

const RANGE_LABELS: Record<KeywordRange, string> = {
  day: '当天',
  week: '近 7 天',
  month: '近 30 天',
};

export default function KeywordPage() {
  const params = useParams<{ id: string }>();
  const keywordId = typeof params.id === 'string' ? params.id : '';
  const [range, setRange] = useState<KeywordRange>('week');
  const [date, setDate] = useState(localToday);
  const [data, setData] = useState<KeywordResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!keywordId) return;
    setError(null);
    try {
      const response = await fetch(
        `/api/keywords?id=${encodeURIComponent(keywordId)}&range=${range}&date=${date}`,
        { cache: 'no-store' },
      );
      const next = (await response.json()) as KeywordResponse;
      if (!response.ok || !next.ok) throw new Error(next.error ?? '无法读取关键词内容');
      setData(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取关键词内容');
    } finally {
      setLoading(false);
    }
  }, [date, keywordId, range]);

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
        <header className="modern-page-header keyword-page-header">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <Tags size={18} className="mt-1 shrink-0 text-[var(--secondary)]" />
              <div className="min-w-0">
                <div className="report-kicker">Custom Keyword · 本机匹配</div>
                <h1 className="flex min-w-0 items-center gap-2">
                  <Hash size={18} className="shrink-0 text-[var(--secondary)]" />
                  <span className="truncate">{data?.keyword.keyword ?? '关键词标签'}</span>
                </h1>
                <p>
                  聚合命中关键词的本机会话与消息片段；数据来源：
                  {sourceLabel(data?.keyword.source)}。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="segmented" aria-label="关键词统计范围">
                {(Object.keys(RANGE_LABELS) as KeywordRange[]).map((item) => (
                  <button
                    key={item}
                    className={`segment-button ${range === item ? 'segment-button-active' : ''}`}
                    onClick={() => setRange(item)}
                  >
                    {RANGE_LABELS[item]}
                  </button>
                ))}
              </div>
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

        <div className="modern-page-body keyword-page-body">
          {error && <div className="keyword-error">{error}</div>}
          <KeywordMetrics data={data} />
          <KeywordTrend data={data} />

          <section className="keyword-conversation-section">
            <div className="keyword-section-heading">
              <div>
                <div className="report-kicker">Matched Conversations</div>
                <h2>相关会话内容</h2>
              </div>
              <span>
                已扫描 {data?.message_scan.scanned.toLocaleString() ?? 0} 条本机消息
                {data?.message_scan.truncated ? ' · 已按安全上限截断' : ''}
              </span>
            </div>

            {data?.conversations.length ? (
              <div className="keyword-conversation-list">
                {data.conversations.map((conversation) => (
                  <article className="keyword-conversation" key={conversation.id}>
                    <header>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`platform-chip platform-chip-${conversation.platform}`}>
                            {conversation.platform === 'wechat' ? '微信' : '飞书'}
                          </span>
                          <h3 className="truncate">{conversation.name}</h3>
                        </div>
                        <p>
                          {conversation.chat_type === 'group' ? '群聊' : '私信'} · 命中 {conversation.match_count} 条
                        </p>
                      </div>
                      <span>{formatTime(conversation.latest_at)}</span>
                    </header>
                    <div className="keyword-message-list">
                      {conversation.matches.map((message) => (
                        <div className="keyword-message" key={message.message_id}>
                          <div className="keyword-message-meta">
                            <strong>{message.sender || '未知发送者'}</strong>
                            <span>{message.time || formatTime(message.timestamp)}</span>
                          </div>
                          <p>
                            <HighlightedText
                              text={message.content}
                              keyword={data.keyword.keyword}
                            />
                          </p>
                          {message.matched_in === 'name' && (
                            <span className="keyword-name-match">会话名称命中</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="modern-empty keyword-empty">
                <MessageSquareText size={24} />
                <h3>{loading ? '正在检索本机消息…' : '当前范围没有匹配内容'}</h3>
                <p>可以切换到近 30 天，或在本机设置中调整这个关键词的数据来源。</p>
              </div>
            )}
          </section>

          <div className="keyword-local-note">
            匹配、解密与聚合均在这台 Mac 上完成；页面不会把关键词或消息发送到外部服务。
          </div>
        </div>
      </main>
    </div>
  );
}

function KeywordMetrics({ data }: { data: KeywordResponse | null }) {
  const items = [
    ['命中消息', data?.counts.matches ?? 0],
    ['相关会话', data?.counts.conversations ?? 0],
    ['微信', data?.counts.wechat ?? 0],
    ['飞书', data?.counts.feishu ?? 0],
  ] as const;
  return (
    <div className="keyword-metrics">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value.toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
}

function KeywordTrend({ data }: { data: KeywordResponse | null }) {
  const max = useMemo(
    () => Math.max(1, ...(data?.trend.map((item) => item.total) ?? [1])),
    [data?.trend],
  );
  const visible = data?.trend ?? [];
  return (
    <section className="keyword-trend">
      <div className="keyword-section-heading">
        <div>
          <div className="report-kicker">Keyword Activity</div>
          <h2>关键词活跃趋势</h2>
        </div>
        <span>{data ? `${data.window.since} 至 ${data.window.until}` : '读取中'}</span>
      </div>
      <div className="keyword-trend-bars">
        {visible.map((item) => (
          <div className="keyword-trend-day" key={item.date} title={`${item.date} · ${item.total} 条`}>
            <div className="keyword-trend-track">
              <span
                className="keyword-trend-wechat"
                style={{ height: `${(item.wechat / max) * 100}%` }}
              />
              <span
                className="keyword-trend-feishu"
                style={{ height: `${(item.feishu / max) * 100}%` }}
              />
            </div>
            <span>{item.date.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className="keyword-trend-legend">
        <span><i className="keyword-legend-wechat" />微信</span>
        <span><i className="keyword-legend-feishu" />飞书</span>
      </div>
    </section>
  );
}

function HighlightedText({ text, keyword }: { text: string; keyword: string }) {
  const parts: React.ReactNode[] = [];
  const lowerText = text.toLocaleLowerCase('zh-CN');
  const lowerKeyword = keyword.toLocaleLowerCase('zh-CN');
  if (!lowerKeyword) return text;
  let cursor = 0;
  while (cursor < text.length) {
    const index = lowerText.indexOf(lowerKeyword, cursor);
    if (index < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<mark key={`${index}-${cursor}`}>{text.slice(index, index + keyword.length)}</mark>);
    cursor = index + keyword.length;
  }
  return parts;
}

function sourceLabel(source?: KeywordSource) {
  return source === 'wechat' ? '微信' : source === 'feishu' ? '飞书' : '微信 + 飞书';
}

function formatTime(value: number) {
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(milliseconds).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}
