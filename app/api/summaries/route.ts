import { NextRequest, NextResponse } from 'next/server';
import { summaryDashboard } from '@/lib/intelligence-store';
import { normalizeDate } from '@/lib/range';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const day = normalizeDate(new URL(request.url).searchParams.get('date'));
  return NextResponse.json(summaryDashboard(day));
}
