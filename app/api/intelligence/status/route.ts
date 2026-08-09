import { NextResponse } from 'next/server';
import { intelligenceStatus } from '@/lib/intelligence-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, latest_job: intelligenceStatus() });
}
