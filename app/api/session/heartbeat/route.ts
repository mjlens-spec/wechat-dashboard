import { NextResponse } from 'next/server';
import { heartbeatViewerSession } from '@/lib/session-lease';
import { startViewerScheduledSync } from '@/lib/sync-service';

export const dynamic = 'force-dynamic';

export async function POST() {
  const session = heartbeatViewerSession();
  let sync:
    | ReturnType<typeof startViewerScheduledSync>
    | { status: 'not_managed' | 'error' } = { status: 'not_managed' };
  if (session.managed) {
    try {
      sync = startViewerScheduledSync();
    } catch {
      sync = { status: 'error' };
    }
  }
  return NextResponse.json({ ok: true, ...session, sync });
}
