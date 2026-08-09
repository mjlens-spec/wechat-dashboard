import { MessageCircleMore, MessagesSquare } from 'lucide-react';

export interface DashboardConversation {
  id: string;
  name: string;
  chat_type: 'group' | 'private';
  summary: string;
  last_sender: string;
  last_time: string;
  last_activity: number;
  unread: number;
  message_count: number;
}

export default function ConversationList({
  conversations,
}: {
  conversations: DashboardConversation[];
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-soft)] px-5 py-4">
        <div>
          <div className="text-[15px] font-semibold">近期会话 · 群聊优先</div>
          <div className="mt-1 text-[12px] text-[var(--text-3)]">
            按当前统计窗口内的消息数排序
          </div>
        </div>
        <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-3)]">
          Group First
        </div>
      </div>

      {conversations.length === 0 ? (
        <div className="px-5 py-16 text-center text-[13px] text-[var(--text-3)]">
          暂无会话数据。读取器就绪后会在 30 分钟内自动同步。
        </div>
      ) : (
        <div className="divide-y divide-[var(--border-soft)]">
          {conversations.map((conversation) => (
            <ConversationRow key={conversation.id} conversation={conversation} />
          ))}
        </div>
      )}
    </section>
  );
}

function ConversationRow({ conversation }: { conversation: DashboardConversation }) {
  const isGroup = conversation.chat_type === 'group';
  return (
    <div className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 transition-colors hover:bg-[var(--surface-2)]">
      <div
        className={`flex size-9 items-center justify-center rounded-md border border-[var(--border-soft)] ${
          isGroup ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--warn-soft)] text-[var(--warn)]'
        }`}
      >
        {isGroup ? <MessagesSquare size={15} /> : <MessageCircleMore size={15} />}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-medium text-[var(--text)]">
            {conversation.name}
          </span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
              isGroup
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--warn-soft)] text-[var(--warn)]'
            }`}
          >
            {isGroup ? '群聊' : '私信'}
          </span>
          {conversation.unread > 0 && (
            <span className="shrink-0 rounded-full bg-[var(--danger)] px-1.5 text-[10px] text-white">
              {conversation.unread}
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-[12px] text-[var(--text-3)]">
          {conversation.last_sender ? `${conversation.last_sender}：` : ''}
          {conversation.summary || '暂无摘要'}
        </div>
      </div>
      <div className="min-w-[92px] text-right">
        <div className="text-[15px] font-semibold tabular-nums text-[var(--text)]">
          {conversation.message_count.toLocaleString()}
        </div>
        <div className="mt-1 text-[11px] text-[var(--text-3)]">
          {conversation.last_time || '—'}
        </div>
      </div>
    </div>
  );
}
