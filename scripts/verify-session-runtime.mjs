#!/usr/bin/env node

import assert from 'node:assert/strict';
import { automaticSyncTiming } from '../lib/sync-schedule.mjs';
import {
  completedSyncAllowsSemanticAnalysis,
  UPDATE_INTERVAL_MS,
  UPDATE_INTERVAL_MINUTES,
} from '../lib/update-cadence.mjs';
import {
  heartbeatManagedLease,
  isActiveManagedLease,
} from '../lib/session-lease-policy.mjs';
import {
  browserAutomationAdapter,
  existingPageRefreshAppleScript,
  selectDefaultHttpBrowserBundleId,
} from '../lib/default-browser-policy.mjs';

const now = 1_800_000;
const intervalMs = UPDATE_INTERVAL_MS;

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
  'A recent failed or manual attempt must apply the same 15-minute backoff.',
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
assert.equal(UPDATE_INTERVAL_MS, 15 * 60 * 1000);
assert.equal(UPDATE_INTERVAL_MINUTES, 15);
assert.equal(completedSyncAllowsSemanticAnalysis('ok'), true);
assert.equal(completedSyncAllowsSemanticAnalysis('partial'), false);
assert.equal(completedSyncAllowsSemanticAnalysis('failed'), false);

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

const viewerHeartbeat = heartbeatManagedLease(
  {
    ...lease,
    skill_expires_at: now - 1,
    expires_at: now + 1,
    last_viewer_heartbeat_at: now - 60_000,
  },
  state,
  projectRoot,
  now,
  3 * 60_000,
);
assert.equal(viewerHeartbeat?.expires_at, now + 3 * 60_000);
assert.equal(viewerHeartbeat?.last_viewer_heartbeat_at, now);
assert.equal(
  heartbeatManagedLease(
    { ...lease, expires_at: now, last_viewer_heartbeat_at: now - 60_000 },
    state,
    projectRoot,
    now,
    3 * 60_000,
  ),
  null,
  'An expired viewer lease must not be revived by a late heartbeat.',
);
assert.equal(
  heartbeatManagedLease(
    {
      ...lease,
      skill_expires_at: now - 1,
      last_viewer_heartbeat_at: null,
    },
    state,
    projectRoot,
    now,
    3 * 60_000,
  ),
  null,
  'The first viewer heartbeat must arrive during the Skill grace window.',
);

const defaultBrowser = selectDefaultHttpBrowserBundleId([
  {
    LSHandlerURLScheme: 'http',
    LSHandlerRoleAll: 'com.apple.Safari',
    LSHandlerModificationDate: 100,
  },
  {
    LSHandlerURLScheme: 'http',
    LSHandlerRoleAll: 'com.google.chrome',
    LSHandlerModificationDate: 200,
  },
]);
assert.equal(defaultBrowser, 'com.google.chrome');
const chromeAdapter = browserAutomationAdapter(defaultBrowser);
assert.deepEqual(chromeAdapter, {
  bundleId: 'com.google.Chrome',
  kind: 'chromium',
});
const refreshScript = existingPageRefreshAppleScript(chromeAdapter);
assert.match(refreshScript, /set URL of browserTab to targetURL/);
assert.match(refreshScript, /return "refreshed_existing_page"/);
assert.equal(browserAutomationAdapter('org.mozilla.firefox'), null);

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'verified',
      summary: 'Session lease, default-browser reuse, and 15-minute dual-sync-to-Terra timing policies passed.',
      checks: {
        first_run_due: true,
        failed_attempt_backoff: true,
        viewer_expiry_rejected: true,
        skill_expiry_rejected: true,
        session_mismatch_rejected: true,
        active_viewer_outlives_initial_skill_window: true,
        expired_viewer_not_revived: true,
        unopened_session_not_revived: true,
        fifteen_minute_update_interval: true,
        default_browser_existing_page_refresh: true,
        terra_requires_complete_sync: true,
      },
    },
    null,
    2,
  )}\n`,
);
