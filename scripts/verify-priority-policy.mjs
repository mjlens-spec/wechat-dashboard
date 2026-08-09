#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  normalizePriorityKeyword,
  prioritizeGroupRecords,
} from '../lib/conversation-priority-policy.mjs';

const records = [
  { id: 'a', name: '客户项目群', messageText: '今天确认交付排期', messageCount: 4, lastActivity: 40, starred: false },
  { id: 'b', name: '内部协作群', messageText: '普通同步', messageCount: 20, lastActivity: 50, starred: true },
  { id: 'c', name: '品牌工作群', messageText: '客户升级，需要今天处理', messageCount: 8, lastActivity: 60, starred: false },
];
const keywords = [{ id: 'kw_1', keyword: '客户' }, { id: 'kw_2', keyword: '升级' }];

const ranked = prioritizeGroupRecords(records, { priorityKeywords: keywords });
assert.deepEqual(ranked.map((row) => row.id), ['b', 'c', 'a']);
assert.deepEqual(ranked.find((row) => row.id === 'c')?.matched_keywords, ['客户', '升级']);

const messageSearch = prioritizeGroupRecords(records, {
  priorityKeywords: keywords,
  search: '交付 排期',
});
assert.deepEqual(messageSearch.map((row) => row.id), ['a']);
assert.equal(messageSearch[0]?.search_match_location, 'message');

const nameSearch = prioritizeGroupRecords(records, { search: '内部 协作' });
assert.deepEqual(nameSearch.map((row) => row.id), ['b']);
assert.equal(nameSearch[0]?.search_match_location, 'name');

assert.equal(normalizePriorityKeyword('  客户   升级  '), '客户 升级');

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'verified',
      summary: 'Starred groups, priority keywords, and bounded search ranking passed.',
      checks: {
        starred_first: true,
        keyword_weighting: true,
        message_search: true,
        group_name_search: true,
        keyword_normalization: true,
      },
    },
    null,
    2,
  )}\n`,
);
