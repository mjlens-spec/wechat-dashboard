import {
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { securePrivateDirectory, securePrivateFile } from './private-paths.mjs';

export const DATA_DIR = join(/*turbopackIgnore: true*/ homedir(), '.wechat-dashboard');

const CONFIG_PATH = join(/*turbopackIgnore: true*/ DATA_DIR, 'config.json');

export interface Config {
  myNicknames: string[];
  defaultRange: 'day' | 'week' | 'month' | 'quarter' | 'year';
  rescanConcurrency: number;
  privacyConfirmed: boolean;
  setupCompleted: boolean;
  demoMode: boolean;
  defaultSyncDays: number;
  autoSyncMinutes: number;
  accountDirectory: string | null;
}

function envNames(): string[] {
  return (process.env.WECHAT_DASHBOARD_MY_NAMES || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

const DEFAULTS: Config = {
  myNicknames: envNames(),
  defaultRange: 'week',
  rescanConcurrency: 5,
  privacyConfirmed: false,
  setupCompleted: false,
  demoMode: process.env.WECHAT_DASHBOARD_DEMO === '1',
  defaultSyncDays: 7,
  autoSyncMinutes: 30,
  accountDirectory: null,
};

export function readConfig(): Config {
  secureDataDirectory();
  if (!securePrivateFile(CONFIG_PATH, { allowMissing: true })) {
    writePrivateConfig(DEFAULTS);
    return DEFAULTS;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    const merged = { ...DEFAULTS, ...parsed, autoSyncMinutes: 30 };
    if (envNames().length > 0) merged.myNicknames = envNames();
    if (process.env.WECHAT_DASHBOARD_DEMO === '1') merged.demoMode = true;
    return merged;
  } catch {
    return DEFAULTS;
  }
}

export function writeConfig(patch: Partial<Config>): Config {
  const cur = readConfig();
  const merged = { ...cur, ...patch };
  writePrivateConfig(merged);
  return merged;
}

export function configStatus() {
  const cfg = readConfig();
  return {
    dataDir: DATA_DIR,
    configPath: CONFIG_PATH,
    configured:
      cfg.setupCompleted &&
      cfg.privacyConfirmed &&
      (cfg.demoMode || Boolean(cfg.accountDirectory)),
    config: cfg,
  };
}

export function secureDataDirectory() {
  securePrivateDirectory(DATA_DIR, { create: true });
}

function writePrivateConfig(config: Config) {
  secureDataDirectory();
  const tempPath = join(DATA_DIR, `.config-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    securePrivateFile(tempPath);
    renameSync(tempPath, CONFIG_PATH);
    securePrivateFile(CONFIG_PATH);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    throw error;
  }
}
