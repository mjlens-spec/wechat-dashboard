#!/usr/bin/env node

import assert from 'node:assert/strict';
import { resolveFeishuSyncCompletion } from '../lib/feishu-sync-policy.mjs';

const previousSuccessAt = 1_700_000_000_000;
const attemptedAt = previousSuccessAt + 30 * 60 * 1000;

assert.deepEqual(
  resolveFeishuSyncCompletion({ truncated: true, attemptedAt, previousSuccessAt }),
  {
    complete: false,
    errorCode: 'FEISHU_RESULT_TRUNCATED',
    lastSuccessAt: previousSuccessAt,
  },
);
assert.deepEqual(
  resolveFeishuSyncCompletion({ truncated: false, attemptedAt, previousSuccessAt }),
  {
    complete: true,
    errorCode: null,
    lastSuccessAt: attemptedAt,
  },
);

process.stdout.write(`${JSON.stringify({
  status: 'verified',
  checks: {
    truncated_result_does_not_advance_checkpoint: true,
    complete_result_advances_checkpoint: true,
  },
}, null, 2)}\n`);
