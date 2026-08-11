import { NextResponse } from 'next/server';
import { intelligenceStatus } from '@/lib/intelligence-store';
import { heartbeatViewerSession } from '@/lib/session-lease';
import { startViewerScheduledSync } from '@/lib/sync-service';

export const dynamic = 'force-dynamic';

export async function POST() {
  const session = heartbeatViewerSession();
  let sync:
    | ReturnType<typeof startViewerScheduledSync>
    | { status: 'not_managed' | 'error' } = { status: 'not_managed' };
  let intelligence: ReturnType<typeof intelligenceStatus> = null;
  if (session.managed) {
    try {
      sync = startViewerScheduledSync();
    } catch {
      sync = { status: 'error' };
    }
    try {
      intelligence = intelligenceStatus();
    } catch {
      intelligence = null;
    }
  }
  return NextResponse.json({
    ok: true,
    ...session,
    sync,
    intelligence,
  });
}
