#!/usr/bin/env node

import assert from 'node:assert/strict';
import { automaticSyncTiming } from '../lib/sync-schedule.mjs';
import { isActiveManagedLease } from '../lib/session-lease-policy.mjs';

const now = 1_800_000;
const intervalMs = 30 * 60 * 1_000;

assert.deepEqual(
  automaticSyncTiming({ now, intervalMs, lastSuccessAt: null, lastAttemptAt: null }),
  { due: true, nextDueAt: now },
);
assert.deepEqual(
  automaticSyncTiming({
    now,
    intervalMs,
    lastSuccessAt: now - intervalMs,
    lastAttemptAt: now - 60_000,
  }),
  { due: false, nextDueAt: now - 60_000 + intervalMs },
  'A recent failed or manual attempt must apply the same 30-minute backoff.',
);
assert.equal(
  automaticSyncTiming({
    now,
    intervalMs,
    lastSuccessAt: now - intervalMs * 2,
    lastAttemptAt: now - intervalMs,
  }).due,
  true,
);

const projectRoot = '/private/project';
const state = {
  version: 1,
  session_id: 'session-id',
  project_root: projectRoot,
};
const lease = {
  ...state,
  expires_at: now + 1,
  skill_expires_at: now + 1,
};
assert.equal(isActiveManagedLease(lease, state, projectRoot, now), true);
assert.equal(
  isActiveManagedLease({ ...lease, expires_at: now }, state, projectRoot, now),
  false,
  'An expired viewer lease must not be renewed.',
);
assert.equal(
  isActiveManagedLease({ ...lease, skill_expires_at: now }, state, projectRoot, now),
  false,
  'An expired Skill lease must not be renewed.',
);
assert.equal(
  isActiveManagedLease(lease, { ...state, session_id: 'other' }, projectRoot, now),
  false,
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'verified',
      summary: 'Session lease and 30-minute viewer-sync timing policies passed.',
      checks: {
        first_run_due: true,
        failed_attempt_backoff: true,
        viewer_expiry_rejected: true,
        skill_expiry_rejected: true,
        session_mismatch_rejected: true,
      },
    },
    null,
    2,
  )}\n`,
);
