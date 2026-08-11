'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { DASHBOARD_REFRESH_EVENT } from '@/lib/dashboard-refresh-events';

type OpportunityStatus = 'new' | 'following' | 'converted' | 'dismissed';
type Opportunity = {
  id: string;
  conversation_name: string;
  platform: 'wechat' | 'feishu';
  chat_type: 'group' | 'private';
  category: 'new_demand' | 'budget_signal' | 'collaboration' | 'upsell' | 'referral' | 'renewal';
  confidence: number;
  title: string;
  detail: string;
  business_value: string;
  suggested_action: string;
  owner: string;
  due: string;
  evidence_count: number;
  status: OpportunityStatus;
  last_detected_at: number;
};

type OpportunityResponse = {
  ok: boolean;
  opportunities: Opportunity[];
  counts: { new: number; following: number; converted: number; wechat: number; feishu: number };
  intelligence: { display_model: string | null; display_reasoning?: string | null } | null;
};

const CATEGORY_LABELS: Record<Opportunity['category'], string> = {
  new_demand: '新需求',
  budget_signal: '预算信号',
  collaboration: '合作机会',
  upsell: '增购升级',
  referral: '转介绍',
  renewal: '续约复购',
};

export default function OpportunitiesPage() {
  const [date, setDate] = useState(localToday);
  const [status, setStatus] = useState<OpportunityStatus>('new');
  const [data, setData] = useState<OpportunityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/opportunities?date=${date}`, { cache: 'no-store' });
      const next = (await response.json()) as OpportunityResponse;
      if (!response.ok || !next.ok) throw new Error('无法读取潜在商机');
      setData(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取潜在商机');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(load, 60_000);
    const reloadUpdatedData = () => void load();
    window.addEventListener(DASHBOARD_REFRESH_EVENT, reloadUpdatedData);
    window.addEventListener('focus', reloadUpdatedData);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener(DASHBOARD_REFRESH_EVENT, reloadUpdatedData);
      window.removeEventListener('focus', reloadUpdatedData);
    };
  }, [load]);

  const visible = useMemo(
    () => data?.opportunities.filter((item) => item.status === status) ?? [],
    [data?.opportunities, status],
  );

  async function updateStatus(id: string, nextStatus: OpportunityStatus) {
    const response = await fetch('/api/opportunities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, status: nextStatus }),
    });
    if (!response.ok) {
      setError('商机状态更新失败');
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
              <BriefcaseBusiness size={18} className="mt-1 text-[var(--accent)]" />
              <div>
                <div className="report-kicker">Opportunity Radar · Terra High</div>
                <h1>潜在商机提示</h1>
                <p>从微信与飞书的群聊、已授权私信中抓取需求、预算、合作与续约信号。</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="date-control"><CalendarDays size={14} /><input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="theme-date-input bg-transparent outline-none" /></label>
              <button className="btn" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />刷新页面</button>
            </div>
          </div>
        </header>

        <div className="attention-body">
          <div className="attention-counts">
            <OpportunityCount label="新线索" value={data?.counts.new ?? 0} />
            <OpportunityCount label="跟进中" value={data?.counts.following ?? 0} />
            <OpportunityCount label="已转化" value={data?.counts.converted ?? 0} />
            <OpportunityCount label="分析引擎" value={data?.intelligence?.display_model?.includes('terra') ? 'Terra High' : '待运行'} text />
          </div>
          <div className="attention-toolbar">
            <div className="attention-tabs">
              {(['new', 'following', 'converted', 'dismissed'] as OpportunityStatus[]).map((item) => (
                <button key={item} className={status === item ? 'attention-tab-active' : ''} onClick={() => setStatus(item)}>
                  {{ new: '新线索', following: '跟进中', converted: '已转化', dismissed: '已忽略' }[item]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-3)]"><Sparkles size={12} />每条商机必须引用同一会话中的消息证据</div>
          </div>
          {error && <div className="mt-4 rounded-md bg-[var(--danger-soft)] px-4 py-3 text-[13px] text-[var(--danger)]">{error}</div>}
          <div className="attention-platform-grid">
            {(['wechat', 'feishu'] as const).map((platform) => (
              <OpportunityColumn key={platform} platform={platform} items={visible.filter((item) => item.platform === platform)} onStatus={updateStatus} />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

function OpportunityColumn({ platform, items, onStatus }: { platform: 'wechat' | 'feishu'; items: Opportunity[]; onStatus: (id: string, status: OpportunityStatus) => Promise<void> }) {
  return (
    <section className="attention-platform-column">
      <header className="platform-dashboard-header compact-platform-header"><span className={`platform-chip platform-chip-${platform}`}>{platform === 'wechat' ? '微信' : '飞书'}</span><div><h2>{platform === 'wechat' ? '微信商机' : '飞书商机'}</h2><p>{items.length} 项</p></div></header>
      <div className="opportunity-list">
        {items.length ? items.map((item) => <OpportunityCard key={item.id} item={item} onStatus={onStatus} />) : <div className="modern-empty compact-empty"><p>当前没有相关线索。</p></div>}
      </div>
    </section>
  );
}

function OpportunityCard({ item, onStatus }: { item: Opportunity; onStatus: (id: string, status: OpportunityStatus) => Promise<void> }) {
  return (
    <article className="opportunity-card">
      <div className="flex items-center justify-between gap-3"><span className="status-tag">{CATEGORY_LABELS[item.category]}</span><span className="text-[11px] text-[var(--text-3)]">置信度 {item.confidence.toFixed(2)}</span></div>
      <h2>{item.title}</h2>
      <p className="opportunity-source">{item.conversation_name} · {item.chat_type === 'group' ? '群聊' : '私信'} · {item.evidence_count} 条证据</p>
      <p className="opportunity-detail">{item.detail}</p>
      <div className="opportunity-value"><strong>业务价值</strong><span>{item.business_value}</span></div>
      <div className="attention-action-note"><ArrowUpRight size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" /><span><strong>建议动作：</strong>{item.suggested_action}</span></div>
      {(item.owner || item.due) && <p className="opportunity-source">{[item.owner && `负责人：${item.owner}`, item.due && `时间：${item.due}`].filter(Boolean).join(' · ')}</p>}
      <div className="opportunity-actions">
        {item.status === 'new' && <button className="btn btn-primary" onClick={() => void onStatus(item.id, 'following')}><ArrowUpRight size={13} />开始跟进</button>}
        {(item.status === 'new' || item.status === 'following') && <button className="btn" onClick={() => void onStatus(item.id, 'converted')}><CheckCircle2 size={13} />标记转化</button>}
        {(item.status === 'new' || item.status === 'following') && <button className="btn" onClick={() => void onStatus(item.id, 'dismissed')}><X size={13} />忽略</button>}
      </div>
    </article>
  );
}

function OpportunityCount({ label, value, text = false }: { label: string; value: number | string; text?: boolean }) {
  return <div className="attention-count"><div className="text-[11px] text-[var(--text-3)]">{label}</div><div className={`mt-2 font-semibold ${text ? 'text-[16px]' : 'text-[25px]'}`}>{value}</div></div>;
}

function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
