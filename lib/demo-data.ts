import { upsertConversations } from './conversations';
import { writeConfig } from './config';
import { bulkInsertMessages, recordConversationSync } from './messages-store';
import type { WxMessage, WxSession } from './wx-types';

const CONVERSATIONS = [
  { id: 'demo-project@chatroom', name: '项目协作群', type: 'group' as const },
  { id: 'demo-product@chatroom', name: '产品讨论群', type: 'group' as const },
  { id: 'demo-operations@chatroom', name: '日常运营群', type: 'group' as const },
  { id: 'demo-client@chatroom', name: '客户沟通群', type: 'group' as const },
  { id: 'demo-reading@chatroom', name: '阅读分享群', type: 'group' as const },
  { id: 'demo-colleague-a', name: '同事 A', type: 'private' as const },
  { id: 'demo-colleague-b', name: '同事 B', type: 'private' as const },
];

const SENDERS = ['Alex', 'Ming', 'Luna', 'Kai', 'River', 'Yuki', 'Chen'];
const CONTENTS = [
  '请在今天下班前确认新版排期。',
  '客户刚刚补充了两项修改，请大家留意。',
  '明天上午十点前需要给出最终答复。',
  '当前数据有异常，正在核对原因。',
  '方案已经确认，可以按新时间执行。',
];

export function seedDemoData() {
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const sessions: WxSession[] = CONVERSATIONS.map((conversation, index) => ({
    username: conversation.id,
    chat: conversation.name,
    chat_type: conversation.type,
    is_group: conversation.type === 'group',
    last_msg_type: 'text',
    last_sender: SENDERS[index % SENDERS.length],
    summary: CONTENTS[index % CONTENTS.length],
    time: formatTime(new Date(now.getTime() - index * 60_000)),
    timestamp: nowSeconds - index * 60,
    unread: index % 3,
  }));
  upsertConversations(sessions);

  for (let conversationIndex = 0; conversationIndex < CONVERSATIONS.length; conversationIndex++) {
    const conversation = CONVERSATIONS[conversationIndex];
    const messages: WxMessage[] = [];
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      for (let index = 0; index < 12; index++) {
        const time = new Date(now);
        time.setDate(time.getDate() - dayOffset);
        time.setHours(9 + (index % 10), (index * 7) % 60, 0, 0);
        messages.push({
          local_id: dayOffset * 10_000 + conversationIndex * 1_000 + index + 1,
          sender: SENDERS[(index + conversationIndex) % SENDERS.length],
          content: CONTENTS[(index + conversationIndex + dayOffset) % CONTENTS.length],
          time: formatTime(time),
          timestamp: Math.floor(time.getTime() / 1000),
          type: 'text',
        });
      }
    }
    bulkInsertMessages(conversation.id, messages);
    recordConversationSync(conversation.id, {
      status: 'ok',
      coverageSince: nowSeconds - 7 * 24 * 60 * 60,
      coverageUntil: nowSeconds,
      backfillComplete: true,
    });
  }

  writeConfig({
    demoMode: true,
    setupCompleted: true,
    privacyConfirmed: true,
    accountDirectory: null,
    myNicknames: ['你的微信名'],
    defaultSyncDays: 7,
    autoSyncMinutes: 30,
  });

  return {
    groups: CONVERSATIONS.filter((conversation) => conversation.type === 'group').length,
    privateChats: CONVERSATIONS.filter((conversation) => conversation.type === 'private').length,
    days: 7,
  };
}

function formatTime(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}:00`;
}
