import { NextRequest, NextResponse } from 'next/server';
import { keywordInsight } from '@/lib/keyword-tracking';
import { normalizeDate, normalizeRangeKey, rangeToWindow } from '@/lib/range';

export const dynamic = 'force-dynamic';

const KEYWORD_ID_RE = /^kw_[a-f0-9]{28}$/;

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') ?? '';
  if (!KEYWORD_ID_RE.test(id)) {
    return NextResponse.json(
      { ok: false, code: 'INVALID_KEYWORD_ID', error: '关键词标签参数无效。' },
      { status: 400 },
    );
  }

  const requestedRange = normalizeRangeKey(url.searchParams.get('range'), 'week');
  const range = requestedRange === 'day' || requestedRange === 'month' ? requestedRange : 'week';
  const date = normalizeDate(url.searchParams.get('date'));
  const window = rangeToWindow(range, date);
  const insight = keywordInsight(id, window.since, window.until);
  if (!insight) {
    return NextResponse.json(
      { ok: false, code: 'KEYWORD_NOT_FOUND', error: '未找到这个关键词标签。' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, range, date, ...insight });
}
