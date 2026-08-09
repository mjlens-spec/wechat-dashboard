'use client';

import { useEffect } from 'react';

const HEARTBEAT_INTERVAL_MS = 60_000;

export default function SessionHeartbeat() {
  useEffect(() => {
    const heartbeat = () => {
      void fetch('/api/session/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      }).catch(() => {
        // A closed or expired local session needs no browser-side recovery.
      });
    };
    heartbeat();
    const interval = window.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  return null;
}
