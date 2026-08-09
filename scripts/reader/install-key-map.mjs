#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/reader/install-key-map.mjs <captured.json> <all_keys.json>');
  process.exit(2);
}

const captured = JSON.parse(readFileSync(inputPath, 'utf8'));
delete captured._candidate_keys;
const entries = Object.entries(captured).filter(
  ([name, value]) =>
    name.endsWith('.db') &&
    value &&
    typeof value === 'object' &&
    typeof value.enc_key === 'string' &&
    /^[0-9a-f]{64}$/i.test(value.enc_key),
);

if (entries.length === 0) {
  console.error('Refusing to install an empty key map.');
  process.exit(3);
}

const sanitized = Object.fromEntries(entries);
mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
const temporaryPath = `${outputPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, outputPath);
chmodSync(outputPath, 0o600);
console.log(`Installed ${entries.length} verified database key mappings.`);
