import { MessagesSquare, MessageCircleMore, UsersRound, Wifi } from 'lucide-react';

export interface CardsData {
  total_messages: number;
  active_conversations: number;
  active_groups: number;
  total_groups: number;
  active_private: number;
  total_private: number;
  total_conversations: number;
}

export default function StatGrid({
  cards,
  days,
  lastSuccessAt,
  stale,
}: {
  cards?: CardsData;
  days: number;
  lastSuccessAt: number | null;
  stale: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card
        icon={<MessagesSquare size={15} className="text-[var(--accent)]" />}
        label="窗口消息"
        value={cards?.total_messages.toLocaleString() ?? '—'}
        sub={`统计范围 · ${days} 天`}
      />
      <Card
        icon={<UsersRound size={15} className="text-[var(--accent)]" />}
        label="活跃群聊"
        value={cards ? `${cards.active_groups} / ${cards.total_groups}` : '—'}
        sub="有消息的群 / 已发现群"
      />
      <Card
        icon={<MessageCircleMore size={15} className="text-[var(--warn)]" />}
        label="活跃私信"
        value={cards ? `${cards.active_private} / ${cards.total_private}` : '—'}
        sub="有消息的私信 / 已发现私信"
        accent="warn"
      />
      <Card
        icon={<Wifi size={15} className={stale ? 'text-[var(--danger)]' : 'text-[var(--accent)]'} />}
        label="数据新鲜度"
        value={lastSuccessAt ? relativeTime(lastSuccessAt) : '未同步'}
        sub={stale ? '已超过 20 分钟，请检查读取器' : '页面打开时每 10 分钟刷新'}
        accent={stale ? 'danger' : undefined}
      />
    </div>
  );
}

function Card({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub: string;
  accent?: 'warn' | 'danger';
}) {
  const line =
    accent === 'warn'
      ? 'bg-[var(--warn)]'
      : accent === 'danger'
        ? 'bg-[var(--danger)]'
        : 'bg-[var(--accent)]';
  return (
    <div className="card relative overflow-hidden px-5 py-4">
      <div className={`absolute inset-x-0 top-0 h-px ${line} opacity-60`} />
      <div className="flex items-center justify-between gap-2 text-[13px] text-[var(--text-2)]">
        <span className="flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)]">Local</span>
      </div>
      <div className="mt-3 text-[32px] font-semibold leading-none tabular-nums text-[var(--text)]">
        {value}
      </div>
      <div className="mt-2 text-[12px] text-[var(--text-3)]">{sub}</div>
    </div>
  );
}

function relativeTime(timestamp: number) {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
