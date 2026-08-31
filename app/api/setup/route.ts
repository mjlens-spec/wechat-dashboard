import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { DATA_DIR, configStatus, writeConfig } from '@/lib/config';
import { seedDemoData } from '@/lib/demo-data';
import {
  detectActiveWeChatAccount,
  pinActiveWeChatAccount,
} from '@/lib/wechat-account';
import { wxAvailable, wxDaemonStatus, wxSessions } from '@/lib/wx';
import { feishuAuthStatus } from '@/lib/feishu';
import { readerCacheIsPrivate } from '@/lib/reader-security.mjs';
import { UPDATE_INTERVAL_MINUTES } from '@/lib/update-cadence.mjs';

export const dynamic = 'force-dynamic';

const SetupSchema = z.object({
  myNicknames: z.array(z.string()).default([]),
  privacyConfirmed: z.boolean(),
  demoMode: z.boolean().default(false),
  defaultSyncDays: z.number().int().min(1).max(30).default(7),
  feishuEnabled: z.boolean().default(true),
  analyzeGroupMedia: z.boolean().default(false),
  analyzeWeChatPrivate: z.boolean().default(false),
  analyzeFeishuPrivate: z.boolean().default(false),
});

export async function GET() {
  const [wxInstalled, daemon, wxReaderReady, feishu] = await Promise.all([
    wxAvailable(),
    wxDaemonStatus(),
    wxSessions(1).then(() => true).catch(() => false),
    feishuAuthStatus(),
  ]);
  const activeAccount = detectActiveWeChatAccount();
  return NextResponse.json({
    ok: true,
    ...configStatus(),
    dataDir: DATA_DIR,
    checks: {
      wxInstalled,
      wxReaderReady,
      wxDaemonRunning: daemon.running,
      wxDaemonPid: daemon.pid ?? null,
      readerCachePrivate: readerCacheIsPrivate(),
      activeAccountDirectory: activeAccount?.accountDirectory ?? null,
      feishu,
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = SetupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }
  if (!parsed.data.privacyConfirmed) {
    return NextResponse.json(
      { ok: false, code: 'PRIVACY_CONFIRMATION_REQUIRED', error: '请先确认本机隐私边界。' },
      { status: 400 },
    );
  }
  const names = parsed.data.myNicknames.map((name) => name.trim()).filter(Boolean);
  let accountDirectory: string | null = null;
  if (!parsed.data.demoMode) {
    const [wxInstalled, daemon, wxReaderReady] = await Promise.all([
      wxAvailable(),
      wxDaemonStatus(),
      wxSessions(1).then(() => true).catch(() => false),
    ]);
    if (!wxInstalled || !daemon.running || !wxReaderReady || !readerCacheIsPrivate()) {
      return NextResponse.json(
        {
          ok: false,
          code: 'WECHAT_READER_NOT_READY',
          error: '本机微信读取器、daemon 或缓存权限尚未通过检查。',
        },
        { status: 409 },
      );
    }
    try {
      accountDirectory = pinActiveWeChatAccount().accountDirectory;
    } catch {
      return NextResponse.json(
        {
          ok: false,
          code: 'WECHAT_ACCOUNT_NOT_FOUND',
          error: '无法确定当前微信账号目录，尚未保存真实数据模式。',
        },
        { status: 409 },
      );
    }
  }
  const config = writeConfig({
    myNicknames: names,
    privacyConfirmed: parsed.data.privacyConfirmed,
    demoMode: parsed.data.demoMode,
    defaultSyncDays: parsed.data.defaultSyncDays,
    autoSyncMinutes: UPDATE_INTERVAL_MINUTES,
    feishuEnabled: parsed.data.feishuEnabled,
    analyzeGroupMedia: parsed.data.analyzeGroupMedia,
    analyzeWeChatPrivate: parsed.data.analyzeWeChatPrivate,
    analyzeFeishuPrivate: parsed.data.analyzeFeishuPrivate,
    accountDirectory,
    setupCompleted: true,
  });
  const demo = parsed.data.demoMode ? seedDemoData() : null;
  return NextResponse.json({ ok: true, configured: true, config, demo });
}
