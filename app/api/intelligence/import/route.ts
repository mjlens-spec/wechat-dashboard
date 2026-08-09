import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  AnalysisImportError,
  importAnalysisResult,
} from '@/lib/intelligence-store';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(importAnalysisResult(body));
  } catch (error) {
    if (error instanceof AnalysisImportError) {
      return NextResponse.json(
        { status: 'error', code: error.code, error: error.message },
        { status: 409 },
      );
    }
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          status: 'error',
          code: 'INVALID_ANALYSIS_RESULT',
          error: 'Luna 分析结果不符合 Dashboard 的结构化数据契约。',
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        status: 'error',
        code: 'ANALYSIS_IMPORT_FAILED',
        error: '无法写入本机分析结果。',
      },
      { status: 500 },
    );
  }
}
