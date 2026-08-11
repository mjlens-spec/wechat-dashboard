#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  keywordMatchesPlatform,
  normalizeKeywordSource,
} from '../lib/keyword-tracking-policy.mjs';

assert.equal(normalizeKeywordSource('wechat'), 'wechat');
assert.equal(normalizeKeywordSource('feishu'), 'feishu');
assert.equal(normalizeKeywordSource('all'), 'all');
assert.equal(normalizeKeywordSource('unknown'), 'all');

assert.equal(keywordMatchesPlatform('wechat', 'wechat'), true);
assert.equal(keywordMatchesPlatform('wechat', 'feishu'), false);
assert.equal(keywordMatchesPlatform('feishu', 'feishu'), true);
assert.equal(keywordMatchesPlatform('all', 'wechat'), true);
assert.equal(keywordMatchesPlatform('all', 'feishu'), true);

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'verified',
      summary: 'Custom keyword source selection policy passed.',
      checks: {
        source_normalization: true,
        wechat_filter: true,
        feishu_filter: true,
        dual_platform_filter: true,
      },
    },
    null,
    2,
  )}\n`,
);
