import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  addPriorityKeyword,
  prioritySettings,
  removePriorityKeyword,
  setConversationStarred,
} from '@/lib/conversation-priorities';

export const dynamic = 'force-dynamic';

const UpdateSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set_starred'),
    chatroom_id: z.string().min(1).max(512),
    starred: z.boolean(),
  }),
  z.object({
    action: z.literal('add_keyword'),
    keyword: z.string().min(1).max(128),
  }),
  z.object({
    action: z.literal('remove_keyword'),
    id: z.string().regex(/^kw_[a-f0-9]{28}$/),
  }),
]);

export async function GET() {
  return NextResponse.json({ ok: true, ...prioritySettings() });
}

export async function POST(request: NextRequest) {
  const parsed = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: 'INVALID_PRIORITY_UPDATE', error: '优先级设置参数无效。' },
      { status: 400 },
    );
  }

  if (parsed.data.action === 'set_starred') {
    if (!setConversationStarred(parsed.data.chatroom_id, parsed.data.starred)) {
      return NextResponse.json(
        { ok: false, code: 'GROUP_NOT_FOUND', error: '未找到指定群聊。' },
        { status: 404 },
      );
    }
  } else if (parsed.data.action === 'add_keyword') {
    try {
      addPriorityKeyword(parsed.data.keyword);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INVALID_PRIORITY_KEYWORD';
      return NextResponse.json(
        {
          ok: false,
          code,
          error:
            code === 'PRIORITY_KEYWORD_LIMIT'
              ? '优先关键词最多设置 24 个。'
              : '关键词不能为空或格式无效。',
        },
        { status: 400 },
      );
    }
  } else if (!removePriorityKeyword(parsed.data.id)) {
    return NextResponse.json(
      { ok: false, code: 'PRIORITY_KEYWORD_NOT_FOUND', error: '未找到这个优先关键词。' },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, ...prioritySettings() });
}
