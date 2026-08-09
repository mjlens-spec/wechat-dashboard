import { CheckCircle2, CircleDashed, ShieldCheck } from 'lucide-react';

export interface CoverageData {
  metadata: { total: number; updated_at: number | null };
  recent: { since: number; total: number; complete: number; truncated: number; unsupported: number };
  today: { since: number; total: number; complete: number; truncated: number; unsupported: number };
  history: { status: 'not_started' };
}

export default function CoveragePanel({ coverage }: { coverage?: CoverageData }) {
  const recentDone = Boolean(
    coverage && coverage.recent.complete === coverage.recent.total,
  );
  const todayDone = Boolean(
    coverage && coverage.today.complete === coverage.today.total,
  );

  return (
    <section className="card px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[15px] font-semibold">
          <ShieldCheck size={14} className="text-[var(--accent)]" />
          数据覆盖范围
        </div>
        <div className="text-[11px] text-[var(--text-3)]">
          明确显示已完成范围，未补齐部分不会被当作完整数据
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <CoverageItem
          done={Boolean(coverage?.metadata.total)}
          label="会话目录"
          detail={coverage ? `已发现 ${coverage.metadata.total} 个群聊与私信` : '等待同步'}
        />
        <CoverageItem
          done={recentDone}
          label="最近 2 小时"
          detail={formatProgress(coverage?.recent)}
        />
        <CoverageItem
          done={todayDone}
          label="今日消息"
          detail={formatProgress(coverage?.today)}
        />
      </div>
      <div className="mt-3 text-[11px] text-[var(--text-3)]">
        7 天与 30 天历史尚未自动读取；后续只通过明确的手动任务补齐。
      </div>
    </section>
  );
}

function CoverageItem({
  done,
  label,
  detail,
}: {
  done: boolean;
  label: string;
  detail: string;
}) {
  const Icon = done ? CheckCircle2 : CircleDashed;
  return (
    <div className="rounded-md bg-[var(--surface-2)] px-3 py-3">
      <div className="flex items-center gap-1.5 text-[13px] font-medium">
        <Icon size={13} className={done ? 'text-[var(--accent)]' : 'text-[var(--warn)]'} />
        {label}
      </div>
      <div className="mt-1.5 text-[11px] text-[var(--text-3)]">{detail}</div>
    </div>
  );
}

function formatProgress(
  bucket?: { total: number; complete: number; truncated: number; unsupported: number },
) {
  if (!bucket) return '等待同步';
  if (bucket.total === 0) return '当前时间范围内没有活跃会话';
  const pending = bucket.truncated > 0 ? ` · ${bucket.truncated} 个会话待继续` : '';
  const unsupported = bucket.unsupported > 0 ? ` · ${bucket.unsupported} 个系统会话不可解析` : '';
  return `${bucket.complete} / ${bucket.total} 个可读活跃会话已完整覆盖${pending}${unsupported}`;
}
