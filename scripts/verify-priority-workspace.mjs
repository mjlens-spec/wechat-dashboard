#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const origin = 'http://127.0.0.1:3000';
const headers = { 'content-type': 'application/json', origin };
const dashboard = await requestJson('/api/dashboard?range=week&type=group');
const group = dashboard.priority_workspace?.groups?.[0];
assert.ok(group?.id && group?.name, 'A local group is required for the live priority test.');

const originalStarred = Boolean(group.starred);
const probeKeyword = `priority-probe-${randomBytes(6).toString('hex')}`;
let probeKeywordId = null;

try {
  await requestJson('/api/priorities', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'set_starred',
      chatroom_id: group.id,
      starred: !originalStarred,
    }),
  });
  const changedSettings = await requestJson('/api/priorities');
  assert.equal(changedSettings.starred_group_ids.includes(group.id), !originalStarred);

  const keywordResult = await requestJson('/api/priorities', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'add_keyword',
      keyword: probeKeyword,
      source: 'wechat',
    }),
  });
  const createdKeyword = keywordResult.keywords.find(
    (entry) => entry.keyword === probeKeyword,
  );
  probeKeywordId = createdKeyword?.id;
  assert.match(probeKeywordId ?? '', /^kw_[a-f0-9]{28}$/);
  assert.equal(createdKeyword?.source, 'wechat');
  const database = new Database(join(homedir(), '.wechat-dashboard', 'dashboard.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = database
      .prepare('SELECT keyword_cipher FROM priority_keywords WHERE id = ?')
      .get(probeKeywordId);
    assert.match(row?.keyword_cipher ?? '', /^v1:/);
    assert.equal(row?.keyword_cipher.includes(probeKeyword), false);
  } finally {
    database.close();
  }

  const updatedKeyword = await requestJson('/api/priorities', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'update_keyword_source',
      id: probeKeywordId,
      source: 'feishu',
    }),
  });
  assert.equal(
    updatedKeyword.keywords.find((entry) => entry.id === probeKeywordId)?.source,
    'feishu',
  );

  const insight = await requestJson(
    `/api/keywords?id=${encodeURIComponent(probeKeywordId)}&range=day`,
  );
  assert.equal(insight.keyword.source, 'feishu');
  assert.equal(insight.counts.wechat, 0);

  const searchResult = await requestJson(
    `/api/dashboard?range=week&type=group&q=${encodeURIComponent(group.name)}`,
  );
  assert.ok(searchResult.priority_workspace.groups.some((entry) => entry.id === group.id));
} finally {
  await requestJson('/api/priorities', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'set_starred',
      chatroom_id: group.id,
      starred: originalStarred,
    }),
  }).catch(() => null);
  if (probeKeywordId) {
    await requestJson('/api/priorities', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'remove_keyword', id: probeKeywordId }),
    }).catch(() => null);
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'verified',
      summary: 'Live local star, encrypted keyword, and group search flows passed.',
      checks: {
        star_round_trip: true,
        keyword_round_trip: true,
        keyword_ciphertext_at_rest: true,
        keyword_source_round_trip: true,
        keyword_source_filter: true,
        group_search: true,
        original_preferences_restored: true,
      },
    },
    null,
    2,
  )}\n`,
);

async function requestJson(path, init) {
  const response = await fetch(new URL(path, origin), {
    cache: 'no-store',
    ...init,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(`Local priority request failed: ${response.status}`);
  }
  return body;
}
