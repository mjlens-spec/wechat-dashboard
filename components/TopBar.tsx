'use client';

import { Calendar, Clock3, Database, RefreshCw } from 'lucide-react';

export type RangeKey = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
export type ConversationFilter = 'all' | 'group' | 'private';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'day', label: '今天' },
  { key: 'week', label: '7 天' },
  { key: 'month', label: '30 天' },
  { key: 'quarter', label: '90 天' },
];

const FILTERS: { key: ConversationFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'group', label: '群聊' },
  { key: 'private', label: '私信' },
];

export default function TopBar({
  range,
  filter,
  date,
  onRangeChange,
  onFilterChange,
  onDateChange,
  syncing,
  onSync,
  onInitialSync,
  statusText,
  nextSyncAt,
}: {
  range: RangeKey;
  filter: ConversationFilter;
  date: string;
  onRangeChange: (range: RangeKey) => void;
  onFilterChange: (filter: ConversationFilter) => void;
  onDateChange: (date: string) => void;
  syncing: boolean;
  onSync: () => void;
  onInitialSync: () => void;
  statusText: string;
  nextSyncAt: number;
}) {
  return (
    <div className="app-topbar border-b border-[var(--border-soft)] px-6 py-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="report-kicker">Live Local Snapshot</div>
          <div className="mt-1 text-[18px] font-semibold tracking-wide">微信群聊监控</div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-[var(--text-3)]">
            <Clock3 size={12} />
            <span className="truncate">{statusText}</span>
            {!syncing && <span>· 下次自动刷新 {formatCountdown(nextSyncAt)}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Segmented label="类型">
            {FILTERS.map((item) => (
              <SegmentButton
                key={item.key}
                active={filter === item.key}
                onClick={() => onFilterChange(item.key)}
              >
                {item.label}
              </SegmentButton>
            ))}
          </Segmented>

          <div className="control-surface flex items-center gap-1.5 rounded-md px-2.5 py-1.5">
            <Calendar size={13} className="text-[var(--text-3)]" />
            <input
              type="date"
              value={date}
              onChange={(event) => onDateChange(event.target.value)}
              className="theme-date-input min-w-[128px] bg-transparent text-[13px] outline-none"
              title="选择统计截止日期"
            />
          </div>

          <Segmented label="范围">
            {RANGES.map((item) => (
              <SegmentButton
                key={item.key}
                active={range === item.key}
                onClick={() => onRangeChange(item.key)}
              >
                {item.label}
              </SegmentButton>
            ))}
          </Segmented>

          <button
            className="btn"
            onClick={onInitialSync}
            disabled={syncing}
            title="重新检查会话目录，并继续补齐最近 2 小时与今日消息"
          >
            <Database size={13} />
            继续补齐今天
          </button>
          <button className="btn btn-primary" onClick={onSync} disabled={syncing}>
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? '同步中' : '立即刷新'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Segmented({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="control-surface flex overflow-hidden rounded-md">
      <span className="border-r border-[var(--border-soft)] px-2 py-1 text-[11px] text-[var(--text-3)]">
        {label}
      </span>
      {children}
    </div>
  );
}

function SegmentButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`px-2.5 py-1 text-[12px] transition-colors ${
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'text-[var(--text-2)] hover:text-[var(--text)]'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function formatCountdown(nextSyncAt: number) {
  const remaining = Math.max(0, nextSyncAt - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
