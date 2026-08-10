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
  const [openAlerts, setOpenAlerts] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [syncResponse, attentionResponse] = await Promise.all([
          fetch('/api/sync', { cache: 'no-store' }),
          fetch('/api/attention', { cache: 'no-store' }),
        ]);
        const [data, attention] = await Promise.all([
          syncResponse.json() as Promise<SyncStatus>,
          attentionResponse.json() as Promise<{ counts?: { open?: number } }>,
        ]);
        if (!cancelled) {
          setSync(data);
          setOpenAlerts(attention.counts?.open ?? 0);
        }
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
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <div className="flex items-center gap-2">
          <span className="brand-mark" />
          <div className="report-kicker">Local · Private</div>
        </div>
        <Link href="/" className="sidebar-title">
          WeChat<br />Dashboard
        </Link>
        <div className="sidebar-subtitle">
          macOS 本机只读 · 群聊优先
        </div>
      </div>

      <nav className="sidebar-nav">
        <NavItem
          href="/"
          icon={<LayoutDashboard size={15} />}
          label="总览"
          active={pathname === '/'}
        />
        <div className="sidebar-section-label">
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
          badge={openAlerts}
        />
        <NavItem
          href="/setup"
          icon={<Settings2 size={15} />}
          label="本机设置"
          active={pathname === '/setup'}
        />
      </nav>

      <div className="sidebar-status">
        <div className="sidebar-status-line">
          <span className="size-2" style={{ background: status.tone }} />
          {status.label}
        </div>
        <div className="sidebar-privacy">
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
  badge,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className={`sidebar-nav-item ${active ? 'sidebar-nav-item-active' : ''}`}
    >
      {icon}
      <span>{label}</span>
      {Boolean(badge) && <span className="sidebar-badge">{badge}</span>}
    </Link>
  );
}
