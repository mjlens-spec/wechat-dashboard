#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  hasEvidenceOverlap,
  matchesSuppressedItem,
  textSimilarity,
} from '../lib/intelligence-suppression.mjs';

assert.equal(hasEvidenceOverlap(['e_1'], ['e_1', 'e_2']), true);
assert.equal(hasEvidenceOverlap(['e_1'], ['e_2']), false);

assert.equal(
  matchesSuppressedItem(
    {
      evidenceIds: ['e_new'],
      title: '合同报价待客户确认',
      detail: '客户仍在等待合同报价和最终确认，请尽快回复。',
    },
    {
      evidenceIds: ['e_old'],
      title: '客户催确认合同报价',
      detail: '客户要求尽快确认合同报价并给出明确回复。',
    },
  ),
  true,
);

assert.equal(
  matchesSuppressedItem(
    {
      evidenceIds: ['e_3'],
      title: '下季度内容排期需要补充',
      detail: '品牌团队希望补充社媒内容主题和排期。',
    },
    {
      evidenceIds: ['e_1'],
      title: '客户催确认合同报价',
      detail: '客户要求尽快确认合同报价并给出明确回复。',
    },
  ),
  false,
);

assert.ok(textSimilarity('合同报价待客户确认', '客户催确认合同报价') >= 0.58);

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'verified',
      summary: 'Handled and dismissed intelligence items remain suppressed across changed evidence and wording.',
      checks: {
        evidence_overlap: true,
        paraphrase_match: true,
        unrelated_item_preserved: true,
      },
    },
    null,
    2,
  )}\n`,
);
