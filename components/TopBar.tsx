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

export default function TopBar({
  range,
  date,
  onRangeChange,
  onDateChange,
  syncing,
  onSync,
  onInitialSync,
  statusText,
  nextSyncAt,
}: {
  range: RangeKey;
  date: string;
  onRangeChange: (range: RangeKey) => void;
  onDateChange: (date: string) => void;
  syncing: boolean;
  onSync: () => void;
  onInitialSync: () => void;
  statusText: string;
  nextSyncAt: number;
}) {
  return (
    <header className="app-topbar">
      <div className="topbar-heading">
        <h1>微信 × 飞书会话分析</h1>
        <div className="topbar-status">
            <Clock3 size={12} />
            <span className="truncate">{statusText}</span>
            {!syncing && <span>· 下次自动刷新 {formatCountdown(nextSyncAt)}</span>}
        </div>
      </div>

      <div className="topbar-actions">
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

          <label className="date-control">
            <Calendar size={13} />
            <input
              type="date"
              value={date}
              onChange={(event) => onDateChange(event.target.value)}
              className="theme-date-input"
              title="选择统计截止日期"
            />
          </label>

          <button
            className="btn"
            onClick={onInitialSync}
            disabled={syncing}
            title="重新检查双端会话目录，并继续补齐今日消息"
          >
            <Database size={13} />
            继续补齐今天
          </button>
          <button className="btn btn-primary" onClick={onSync} disabled={syncing}>
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? '同步中' : '立即刷新'}
          </button>
      </div>
    </header>
  );
}

function Segmented({ children, label, compact = false }: { children: React.ReactNode; label: string; compact?: boolean }) {
  return (
    <div className={`segmented ${compact ? 'segmented-compact' : ''}`}>
      <span className="segmented-label">
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
      className={`segment-button ${active ? 'segment-button-active' : ''}`}
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
