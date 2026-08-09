import { NextRequest, NextResponse } from 'next/server';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DATA_DIR, configStatus, writeConfig } from '@/lib/config';
import { seedDemoData } from '@/lib/demo-data';
import {
  detectActiveWeChatAccount,
  pinActiveWeChatAccount,
} from '@/lib/wechat-account';
import { wxAvailable, wxDaemonStatus, wxSessions } from '@/lib/wx';

export const dynamic = 'force-dynamic';

const SetupSchema = z.object({
  myNicknames: z.array(z.string()).default([]),
  privacyConfirmed: z.boolean(),
  demoMode: z.boolean().default(false),
  defaultSyncDays: z.number().int().min(1).max(30).default(7),
});

export async function GET() {
  const [wxInstalled, daemon, wxReaderReady] = await Promise.all([
    wxAvailable(),
    wxDaemonStatus(),
    wxSessions(1).then(() => true).catch(() => false),
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
    autoSyncMinutes: 30,
    accountDirectory,
    setupCompleted: true,
  });
  const demo = parsed.data.demoMode ? seedDemoData() : null;
  return NextResponse.json({ ok: true, configured: true, config, demo });
}

function readerCacheIsPrivate(): boolean {
  const paths = [
    join(/*turbopackIgnore: true*/ homedir(), '.wx-cli'),
    join(/*turbopackIgnore: true*/ homedir(), '.wx-cli', 'cache'),
    join(/*turbopackIgnore: true*/ homedir(), '.wx-cli', 'all_keys.json'),
  ];
  try {
    return paths.every((path) => (statSync(path).mode & 0o077) === 0);
  } catch {
    return false;
  }
}
