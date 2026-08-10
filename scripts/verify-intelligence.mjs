#!/usr/bin/env node

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const baseUrl = new URL(process.env.WECHAT_DASHBOARD_URL ?? 'http://127.0.0.1:3000');
const databasePath = join(homedir(), '.wechat-dashboard', 'dashboard.db');
const database = new Database(databasePath, { readonly: true, fileMustExist: true });

try {
  const [
    summariesResponse,
    attentionResponse,
    opportunitiesResponse,
    summariesPage,
    attentionPage,
    opportunitiesPage,
  ] =
    await Promise.all([
      fetch(new URL('/api/summaries', baseUrl), { cache: 'no-store' }),
      fetch(new URL('/api/attention', baseUrl), { cache: 'no-store' }),
      fetch(new URL('/api/opportunities', baseUrl), { cache: 'no-store' }),
      fetch(new URL('/summaries', baseUrl), { cache: 'no-store' }),
      fetch(new URL('/attention', baseUrl), { cache: 'no-store' }),
      fetch(new URL('/opportunities', baseUrl), { cache: 'no-store' }),
    ]);
  if (
    !summariesResponse.ok ||
    !attentionResponse.ok ||
    !opportunitiesResponse.ok ||
    !summariesPage.ok ||
    !attentionPage.ok ||
    !opportunitiesPage.ok
  ) {
    throw new Error('One or more intelligence routes did not return HTTP 200.');
  }

  const summaries = await summariesResponse.json();
  const attention = await attentionResponse.json();
  const opportunities = await opportunitiesResponse.json();
  const groupIds = summaries.summaries.map((item) => item.group_id);
  const distinctGroups = new Set(groupIds);
  if (groupIds.length !== distinctGroups.size) {
    throw new Error('The summary API merged or duplicated a group entry.');
  }
  if (
    summaries.summaries.some(
      (item) => !item.overview || item.overview === '[本机数据无法解密]',
    )
  ) {
    throw new Error('At least one summary cannot be decrypted.');
  }

  const cipherAudit = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM group_summaries) AS summaries,
         (SELECT COUNT(*) FROM attention_alerts) AS alerts,
         (SELECT COUNT(*) FROM business_opportunities) AS opportunities,
         (SELECT COUNT(*) FROM group_summaries
          WHERE overview_cipher NOT LIKE 'v1:%'
             OR highlights_cipher NOT LIKE 'v1:%'
             OR decisions_cipher NOT LIKE 'v1:%'
             OR action_items_cipher NOT LIKE 'v1:%'
             OR risks_cipher NOT LIKE 'v1:%') AS invalid_summary_ciphers,
         (SELECT COUNT(*) FROM attention_alerts
          WHERE title_cipher NOT LIKE 'v1:%'
             OR detail_cipher NOT LIKE 'v1:%'
             OR suggested_action_cipher NOT LIKE 'v1:%') AS invalid_alert_ciphers,
         (SELECT COUNT(*) FROM business_opportunities
          WHERE title_cipher NOT LIKE 'v1:%'
             OR detail_cipher NOT LIKE 'v1:%'
             OR business_value_cipher NOT LIKE 'v1:%'
             OR suggested_action_cipher NOT LIKE 'v1:%') AS invalid_opportunity_ciphers`,
    )
    .get();
  if (
    cipherAudit.invalid_summary_ciphers ||
    cipherAudit.invalid_alert_ciphers ||
    cipherAudit.invalid_opportunity_ciphers
  ) {
    throw new Error('Plaintext or invalid analysis fields were found at rest.');
  }

  const databaseMode = statSync(databasePath).mode & 0o777;
  if (databaseMode !== 0o600) throw new Error('Dashboard database mode is not 0600.');

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'verified',
        summary: 'Dual-platform intelligence routes, conversation separation, decryption, and encrypted storage passed.',
        next_actions: [],
        artifacts: [],
        checks: {
          summary_page_http: summariesPage.status,
          attention_page_http: attentionPage.status,
          opportunities_page_http: opportunitiesPage.status,
          summaries: summaries.summaries.length,
          distinct_summary_groups: distinctGroups.size,
          alerts: attention.alerts.length,
          opportunities: opportunities.opportunities.length,
          invalid_summary_ciphers: cipherAudit.invalid_summary_ciphers,
          invalid_alert_ciphers: cipherAudit.invalid_alert_ciphers,
          invalid_opportunity_ciphers: cipherAudit.invalid_opportunity_ciphers,
          database_mode: databaseMode.toString(8),
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  database.close();
}
