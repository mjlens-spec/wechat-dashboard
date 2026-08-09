import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  attentionDashboard,
  updateAttentionStatus,
} from '@/lib/intelligence-store';
import { normalizeDate } from '@/lib/range';

export const dynamic = 'force-dynamic';

const UpdateSchema = z.object({
  id: z.string().regex(/^a_[a-f0-9]{28}$/),
  status: z.enum(['open', 'handled', 'dismissed']),
});

export async function GET(request: NextRequest) {
  const day = normalizeDate(new URL(request.url).searchParams.get('date'));
  return NextResponse.json(attentionDashboard(day));
}

export async function POST(request: NextRequest) {
  const parsed = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: 'INVALID_ATTENTION_UPDATE', error: '提示状态参数无效。' },
      { status: 400 },
    );
  }
  if (!updateAttentionStatus(parsed.data.id, parsed.data.status)) {
    return NextResponse.json(
      { ok: false, code: 'ATTENTION_NOT_FOUND', error: '未找到这条重点关注提示。' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
