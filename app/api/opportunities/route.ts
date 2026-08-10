import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  opportunitiesDashboard,
  updateOpportunityStatus,
} from '@/lib/intelligence-store';
import { normalizeDate } from '@/lib/range';

export const dynamic = 'force-dynamic';

const UpdateSchema = z.object({
  id: z.string().regex(/^o_[a-f0-9]{28}$/),
  status: z.enum(['new', 'following', 'converted', 'dismissed']),
});

export async function GET(request: NextRequest) {
  const day = normalizeDate(new URL(request.url).searchParams.get('date'));
  return NextResponse.json(opportunitiesDashboard(day));
}

export async function POST(request: NextRequest) {
  const parsed = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: 'INVALID_OPPORTUNITY_UPDATE', error: '商机状态参数无效。' },
      { status: 400 },
    );
  }
  if (!updateOpportunityStatus(parsed.data.id, parsed.data.status)) {
    return NextResponse.json(
      { ok: false, code: 'OPPORTUNITY_NOT_FOUND', error: '未找到这条潜在商机。' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
