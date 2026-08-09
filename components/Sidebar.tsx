'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BellRing,
  FileText,
  LayoutDashboard,
  Settings2,
  ShieldCheck,
} from 'lucide-react';

type SyncStatus = {
  ok: boolean;
  syncing: boolean;
  latest_run: {
    status: 'running' | 'ok' | 'partial' | 'failed';
    completed_at: number | null;
  } | null;
};

export default function Sidebar() {
  const pathname = usePathname();
  const [sync, setSync] = useState<SyncStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/sync', { cache: 'no-store' });
        const data = (await response.json()) as SyncStatus;
        if (!cancelled) setSync(data);
      } catch {
        if (!cancelled) setSync(null);
      }
    };
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const status = sync?.syncing
    ? { label: '正在读取本地微信', tone: 'var(--warn)' }
    : sync?.latest_run?.status === 'failed'
      ? { label: '读取器需要处理', tone: 'var(--danger)' }
      : sync?.latest_run
        ? { label: '本地快照已就绪', tone: 'var(--accent)' }
        : { label: '等待首次同步', tone: 'var(--text-3)' };

  return (
    <aside className="app-sidebar flex h-screen w-[232px] shrink-0 flex-col border-r border-[var(--border-soft)]">
      <div className="border-b border-[var(--border-soft)] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <Link href="/" className="min-w-0">
            <div className="report-kicker">Local · Private</div>
            <div className="mt-1 text-[17px] font-semibold tracking-wide text-[var(--text)]">
              WeChat Dashboard
            </div>
          </Link>
        </div>
        <div className="mt-2 text-[12px] leading-relaxed text-[var(--text-3)]">
          macOS 本机只读 · 群聊优先
        </div>
      </div>

      <nav className="space-y-1 px-2 py-3">
        <NavItem
          href="/"
          icon={<LayoutDashboard size={15} />}
          label="总览"
          active={pathname === '/'}
        />
        <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-3)]">
          Codex Intelligence
        </div>
        <NavItem
          href="/summaries"
          icon={<FileText size={15} />}
          label="群聊汇总"
          active={pathname === '/summaries'}
        />
        <NavItem
          href="/attention"
          icon={<BellRing size={15} />}
          label="重点关注提示"
          active={pathname === '/attention'}
        />
        <NavItem
          href="/setup"
          icon={<Settings2 size={15} />}
          label="本机设置"
          active={pathname === '/setup'}
        />
      </nav>

      <div className="mt-auto border-t border-[var(--border-soft)] px-4 py-4">
        <div className="flex items-center gap-2 text-[12px] text-[var(--text-2)]">
          <span className="size-2 rounded-full" style={{ background: status.tone }} />
          {status.label}
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-md bg-[var(--surface-2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-3)]">
          <ShieldCheck size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          服务只监听 127.0.0.1，聊天数据不会由 Dashboard 上传。
        </div>
      </div>
    </aside>
  );
}

function NavItem({
  href,
  icon,
  label,
  active,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`relative flex items-center gap-2 rounded-md px-3 py-2 text-[14px] transition-colors ${
        active
          ? 'bg-[var(--accent-soft)] text-[var(--text)]'
          : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[var(--accent)]" />
      )}
      {icon}
      {label}
    </Link>
  );
}
