import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAnalysisExport } from '@/lib/intelligence-store';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  mode: z.enum(['scheduled', 'summaries', 'alerts']).default('scheduled'),
});

export async function POST(request: NextRequest) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { status: 'error', code: 'INVALID_ANALYSIS_MODE', error: '分析模式无效。' },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(createAnalysisExport(parsed.data.mode));
  } catch {
    return NextResponse.json(
      {
        status: 'error',
        code: 'ANALYSIS_EXPORT_FAILED',
        error: '无法准备本机群聊分析上下文。',
      },
      { status: 500 },
    );
  }
}
