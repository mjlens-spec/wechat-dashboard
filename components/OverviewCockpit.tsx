import Link from 'next/link';
import { Star } from 'lucide-react';
import type { CardsData } from '@/components/StatGrid';
import type { CoverageData } from '@/components/CoveragePanel';
import type { PriorityWorkspaceData } from '@/components/PriorityWorkspace';

export type OverviewAttentionItem = {
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
  title: string;
  suggested_action: string;
  evidence_count: number;
  status: 'open' | 'handled' | 'dismissed';
  last_detected_at: number;
};

export type OverviewAttentionData = {
  alerts: OverviewAttentionItem[];
  counts: { open: number; critical: number; high: number; mentions: number };
  intelligence: {
    display_model: string | null;
    display_reasoning?: string | null;
    imported_at: number | null;
    last_imported_at?: number | null;
  } | null;
};

const CATEGORY_LABELS: Record<OverviewAttentionItem['category'], string> = {
  mention: '@ 我的信息',
  customer_emotion: '客户情绪',
  urgent: '紧急问题',
  no_response: '迟迟未回复',
  conflict: '矛盾冲突',
  no_solution: '尚无解决方案',
};

export default function OverviewCockpit({
  cards,
  coverage,
  priorities,
  attention,
  days,
  lastSuccessAt,
  stale,
  platform,
}: {
  cards?: CardsData;
  coverage?: CoverageData;
  priorities?: PriorityWorkspaceData;
  attention: OverviewAttentionData | null;
  days: number;
  lastSuccessAt: number | null;
  stale: boolean;
  platform: 'wechat' | 'feishu';
}) {
  const platformAlerts = attention?.alerts.filter((alert) => alert.platform === platform) ?? [];
  const openAlerts = platformAlerts.filter((alert) => alert.status === 'open').slice(0, 5);
  const highestPriority = platformAlerts.filter(
    (alert) => alert.status === 'open' && isUrgent(alert.severity),
  ).length;

  return (
    <section className="overview-cockpit">
      <div className="needs-panel">
        <header className="needs-header">
          <div>
            <div className="report-kicker">Today · Needs you</div>
            <h1>今天要处理什么</h1>
            <p>
              {modelLabel(
                attention?.intelligence?.display_model,
                attention?.intelligence?.display_reasoning,
              )}
              {(
                attention?.intelligence?.last_imported_at ??
                attention?.intelligence?.imported_at
              )
                ? ` ${formatTime(
                    attention?.intelligence?.last_imported_at ??
                      attention?.intelligence?.imported_at ??
                      0,
                  )} 生成`
                : ' 等待首次分析'}
              {' · '}每条结论引用本机消息证据
            </p>
          </div>
          <div className="needs-count">
            <strong>{platformAlerts.filter((alert) => alert.status === 'open').length}</strong>
            <span>项待处理 · {highestPriority} 项最高优先</span>
          </div>
        </header>

        <div className="needs-list">
          {openAlerts.length ? (
            openAlerts.map((alert, index) => (
              <article
                key={alert.id}
                className={`needs-row ${isUrgent(alert.severity) ? 'needs-row-urgent' : ''}`}
              >
                <div className="needs-index">{String(index + 1).padStart(2, '0')}</div>
                <div className="needs-copy">
                  <div className="needs-meta">
                    <span className="status-tag">{CATEGORY_LABELS[alert.category]}</span>
                    <span className={`severity severity-${alert.severity}`}>
                      {alert.severity}
                    </span>
                  </div>
                  <h2>{alert.title}</h2>
                  <p>建议动作：{alert.suggested_action}</p>
                </div>
                <div className="needs-source">
                  <span>{alert.group_name}</span>
                  <span>{formatTime(alert.last_detected_at)} · {alert.evidence_count} 条证据</span>
                </div>
              </article>
            ))
          ) : (
            <div className="modern-empty compact-empty">
              <div className="report-kicker">No open alerts</div>
              <h2>目前没有待关注提示</h2>
              <p>下一次语义分析完成后，需要你留意或介入的群聊会出现在这里。</p>
            </div>
          )}
        </div>

        <footer className="panel-footer">
          <span>
            {platformAlerts.filter((alert) => alert.status === 'open').length > openAlerts.length
              ? `还有 ${platformAlerts.filter((alert) => alert.status === 'open').length - openAlerts.length} 项提示`
              : '今天的待关注提示已全部列出'}
          </span>
          <Link href="/attention">查看全部重点关注提示 →</Link>
        </footer>
      </div>

      <aside className="ledger-panel">
        <div className="ledger-kicker report-kicker">Local ledger · 本机账本</div>
        <LedgerRow label={`窗口消息 · ${days} 天`} value={cards?.total_messages.toLocaleString() ?? '—'} />
        <LedgerRow
          label="活跃群聊 / 已发现"
          value={cards ? `${cards.active_groups} / ${cards.total_groups}` : '—'}
        />
        <LedgerRow
          label="活跃私信 / 已发现"
          value={cards ? `${cards.active_private} / ${cards.total_private}` : '—'}
          secondary
        />
        <LedgerRow
          label="数据新鲜度"
          value={lastSuccessAt ? relativeTime(lastSuccessAt) : '未同步'}
          danger={stale}
          strongDivider
        />

        <CoverageLedger coverage={coverage} />
        <PriorityLedger priorities={priorities} />

        <footer className="ledger-footer">
          数据源：{platform === 'wechat' ? '本机微信 Mac 客户端' : '飞书 CLI 用户认证'} · SQLite 快照只保存在本机
        </footer>
      </aside>
    </section>
  );
}

function LedgerRow({
  label,
  value,
  secondary = false,
  danger = false,
  strongDivider = false,
}: {
  label: string;
  value: string;
  secondary?: boolean;
  danger?: boolean;
  strongDivider?: boolean;
}) {
  return (
    <div className={`ledger-row ${strongDivider ? 'ledger-row-strong' : ''}`}>
      <span>{label}</span>
      <strong className={danger ? 'text-danger' : secondary ? 'text-secondary' : ''}>{value}</strong>
    </div>
  );
}

function CoverageLedger({ coverage }: { coverage?: CoverageData }) {
  const buckets = [
    {
      label: '会话目录',
      complete: coverage?.metadata.total ?? 0,
      total: coverage?.metadata.total ?? 0,
    },
    {
      label: '最近 2 小时',
      complete: coverage?.recent.complete ?? 0,
      total: coverage?.recent.total ?? 0,
    },
    {
      label: '今日消息',
      complete: coverage?.today.complete ?? 0,
      total: coverage?.today.total ?? 0,
    },
  ];

  return (
    <section className="coverage-ledger">
      <div className="report-kicker">Coverage · 数据覆盖</div>
      <div className="coverage-bars">
        {buckets.map((bucket, index) => {
          const percent = bucket.total > 0 ? Math.min(100, (bucket.complete / bucket.total) * 100) : 0;
          return (
            <div key={bucket.label} className="coverage-bar-row">
              <div>
                <span>{bucket.label}</span>
                <span>{bucket.complete} / {bucket.total}</span>
              </div>
              <div className="score-track">
                <span
                  className={index < 2 ? 'score-fill score-fill-accent' : 'score-fill'}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p>7 天与 30 天历史尚未自动读取。</p>
    </section>
  );
}

function PriorityLedger({ priorities }: { priorities?: PriorityWorkspaceData }) {
  const groups = priorities?.groups.slice(0, 5) ?? [];
  const maxScore = Math.max(1, ...groups.map((group) => group.priority_score));
  return (
    <section className="priority-ledger">
      <div className="priority-ledger-heading">
        <div className="report-kicker">优先群聊 · 按权重排序</div>
        <a href="#priority-workspace">全部 {priorities?.counts.total_groups ?? 0} →</a>
      </div>
      <div className="priority-ledger-list">
        {groups.length ? groups.map((group, index) => (
          <div className="priority-ledger-row" key={group.id}>
            <span className={index < 2 ? 'rank-accent' : ''}>{String(index + 1).padStart(2, '0')}</span>
            <div>
              <div className="priority-ledger-meta">
                {group.starred ? <Star size={12} fill="currentColor" className="star-active" /> : <span className="star-spacer" />}
                <strong>{group.name}</strong>
                {group.matched_keywords.slice(0, 1).map((keyword) => (
                  <span className="status-tag status-tag-keyword" key={keyword}>{keyword}</span>
                ))}
                <b>{group.message_count.toLocaleString()}</b>
              </div>
              <div className="score-track score-track-large">
                <span
                  className={`score-fill ${index < 2 ? 'score-fill-accent' : ''}`}
                  style={{ width: `${Math.max(4, (group.priority_score / maxScore) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        )) : (
          <p className="ledger-placeholder">同步后显示优先群聊排名。</p>
        )}
      </div>
    </section>
  );
}

function isUrgent(severity: OverviewAttentionItem['severity']) {
  return severity === 'critical' || severity === 'high';
}

function modelLabel(
  model: string | null | undefined,
  reasoning: string | null | undefined,
) {
  if (model?.includes('terra') && reasoning === 'high') return 'Terra High';
  if (model?.includes('terra')) return 'Terra · 历史强度未记录';
  return model || 'Codex';
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function relativeTime(timestamp: number) {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
