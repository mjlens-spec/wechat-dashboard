'use client';

import { useState } from 'react';
import { KeyRound, Plus, Search, Star, X } from 'lucide-react';

export type PriorityKeyword = { id: string; keyword: string };

export type PriorityGroup = {
  id: string;
  name: string;
  chat_type: 'group';
  summary: string;
  last_sender: string;
  last_time: string;
  last_activity: number;
  unread: number;
  message_count: number;
  starred: boolean;
  matched_keywords: string[];
  search_matched: boolean;
  search_match_location: 'name' | 'message' | 'combined' | null;
  priority_score: number;
};

export type PriorityWorkspaceData = {
  query: string;
  keywords: PriorityKeyword[];
  groups: PriorityGroup[];
  counts: {
    total_groups: number;
    starred: number;
    keyword_matched: number;
    results: number;
  };
  message_scan: { scanned: number; truncated: boolean };
};

export default function PriorityWorkspace({
  data,
  days,
  searchValue,
  onSearchChange,
  onToggleStar,
  onAddKeyword,
  onRemoveKeyword,
  saving,
}: {
  data?: PriorityWorkspaceData;
  days: number;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onToggleStar: (groupId: string, starred: boolean) => Promise<void>;
  onAddKeyword: (keyword: string) => Promise<boolean>;
  onRemoveKeyword: (keywordId: string) => Promise<void>;
  saving: boolean;
}) {
  const [keywordDraft, setKeywordDraft] = useState('');

  async function submitKeyword(event: React.FormEvent) {
    event.preventDefault();
    const keyword = keywordDraft.trim();
    if (!keyword || saving) return;
    if (await onAddKeyword(keyword)) setKeywordDraft('');
  }

  return (
    <section className="priority-workspace">
      <div className="priority-header">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="report-kicker">Priority workspace · 工作权重</div>
            <h2>优先群聊</h2>
            <p>
              星标群始终置顶；优先关键词命中的群聊随后前置，再按当前 {days} 天区间的消息量与活跃时间排序。
            </p>
          </div>
          <div className="priority-metrics">
            <PriorityMetric label="星标" value={data?.counts.starred ?? 0} />
            <PriorityMetric label="关键词命中" value={data?.counts.keyword_matched ?? 0} />
            <PriorityMetric label={searchValue ? '搜索结果' : '群聊总数'} value={searchValue ? (data?.counts.results ?? 0) : (data?.counts.total_groups ?? 0)} />
          </div>
        </div>

        <div className="priority-search-grid">
          <label className="search-field flex min-w-0 items-center gap-2">
            <Search size={16} className="shrink-0 text-[var(--accent)]" />
            <input
              type="search"
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索群名，或检索当前区间内的消息关键词"
              className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
              aria-label="搜索群聊与消息关键词"
            />
            {searchValue && (
              <button
                type="button"
                className="icon-button"
                onClick={() => onSearchChange('')}
                aria-label="清空搜索"
              >
                <X size={14} />
              </button>
            )}
          </label>

          <form className="search-field flex min-w-0 items-center gap-2" onSubmit={submitKeyword}>
            <KeyRound size={16} className="shrink-0 text-[var(--secondary)]" />
            <input
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
              placeholder="增加优先关键词，如客户名、项目名"
              className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
              maxLength={64}
              aria-label="增加优先关键词"
            />
            <button
              type="submit"
              className="icon-button icon-button-primary"
              disabled={!keywordDraft.trim() || saving}
              aria-label="增加优先关键词"
            >
              <Plus size={14} />
            </button>
          </form>
        </div>

        <div className="priority-keywords">
          <span className="priority-keywords-label">
            优先关键词
          </span>
          {data?.keywords.length ? (
            data.keywords.map((keyword) => (
              <span key={keyword.id} className="priority-keyword">
                {keyword.keyword}
                <button
                  type="button"
                  onClick={() => void onRemoveKeyword(keyword.id)}
                  disabled={saving}
                  aria-label={`删除关键词 ${keyword.keyword}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))
          ) : (
            <span className="text-[12px] text-[var(--text-3)]">
              尚未设置。添加后，命中群名或当前区间消息的群聊会自动前置。
            </span>
          )}
        </div>
        <div className="priority-explanation">
          星标置顶 → 关键词命中数 → 当前区间消息量 → 最近活跃时间
        </div>
      </div>

      {data?.groups.length ? (
        <div className="priority-group-list">
          {data.groups.map((group, index) => (
            <PriorityGroupRow
              key={group.id}
              group={group}
              index={index}
              maxScore={Math.max(1, ...data.groups.map((item) => item.priority_score))}
              saving={saving}
              onToggleStar={onToggleStar}
            />
          ))}
        </div>
      ) : (
        <div className="px-6 py-14 text-center">
          <Search size={24} className="mx-auto text-[var(--accent)]" />
          <h3 className="mt-3 text-[15px] font-semibold">
            {searchValue ? '当前区间没有匹配群聊' : '等待群聊数据'}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-6 text-[var(--text-3)]">
            {searchValue
              ? '可以缩短关键词，或调整上方统计时间区间。搜索只在本机完成。'
              : '本地读取器完成同步后，群聊会按照星标、关键词和活跃度出现在这里。'}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-soft)] bg-[var(--surface-2)] px-5 py-2.5 text-[11px] text-[var(--text-3)]">
        <span>搜索与权重计算只在本机进行，优先关键词加密保存在 Dashboard 数据库。</span>
        <span>
          已检索 {data?.message_scan.scanned.toLocaleString() ?? 0} 条区间消息
          {data?.message_scan.truncated ? ' · 已按安全上限截断' : ''}
        </span>
      </div>
    </section>
  );
}

function PriorityMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="priority-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function PriorityGroupRow({
  group,
  index,
  maxScore,
  saving,
  onToggleStar,
}: {
  group: PriorityGroup;
  index: number;
  maxScore: number;
  saving: boolean;
  onToggleStar: (groupId: string, starred: boolean) => Promise<void>;
}) {
  return (
    <article className={`priority-row ${group.starred ? 'priority-row-starred' : ''}`}>
      <div className={`priority-rank ${index < 2 ? 'rank-accent' : ''}`}>
        {String(index + 1).padStart(2, '0')}
      </div>
      <div className="priority-row-main">
        <div className="priority-row-heading">
      <button
        type="button"
        className={`star-button ${group.starred ? 'star-button-active' : ''}`}
        onClick={() => void onToggleStar(group.id, !group.starred)}
        disabled={saving}
        aria-pressed={group.starred}
        aria-label={group.starred ? `取消置顶 ${group.name}` : `星标置顶 ${group.name}`}
        title={group.starred ? '取消星标置顶' : '星标并置顶'}
      >
        <Star size={16} fill={group.starred ? 'currentColor' : 'none'} />
      </button>
          <h3 className="min-w-0 truncate text-[14px] font-semibold text-[var(--text)]">
            {group.name}
          </h3>
          {group.starred && <span className="status-tag status-tag-starred">星标置顶</span>}
          {group.matched_keywords.slice(0, 3).map((keyword) => (
            <span key={keyword} className="status-tag status-tag-keyword">{keyword}</span>
          ))}
          {group.matched_keywords.length > 3 && (
            <span className="text-[11px] text-[var(--text-3)]">+{group.matched_keywords.length - 3}</span>
          )}
          {group.search_match_location && (
            <span className="status-tag">
              {group.search_match_location === 'name' ? '群名命中' : '消息命中'}
            </span>
          )}
          <strong className="priority-message-count">{group.message_count.toLocaleString()}</strong>
        </div>
        <div className="score-track score-track-large">
          <span
            className={`score-fill ${index < 2 ? 'score-fill-accent' : ''}`}
            style={{ width: `${Math.max(4, (group.priority_score / maxScore) * 100)}%` }}
          />
        </div>
        <p className="priority-row-summary">
          {group.last_sender ? `${group.last_sender}：` : ''}
          {group.summary || '暂无本地消息摘要'}
          <span>{group.last_time || '—'}</span>
        </p>
      </div>
    </article>
  );
}
