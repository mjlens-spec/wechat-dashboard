import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  WxDaemonStatus,
  WxMessage,
  WxNewMessagesResponse,
  WxSession,
} from './wx-types';

const run = promisify(execFile);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_OPTS = {
  maxBuffer: 64 * 1024 * 1024,
  timeout: 60_000,
} as const;

type WxCommand = 'daemon' | 'history' | 'new-messages' | 'sessions';

async function wxRaw(command: WxCommand, args: string[], opts = DEFAULT_OPTS): Promise<string> {
  try {
    const { stdout } = await run(resolveWxBinary(), [command, ...args], {
      ...opts,
      shell: false,
    });
    return stdout;
  } catch (error) {
    throw normalizeWxError(error);
  }
}

async function wxJsonPayload(
  command: Exclude<WxCommand, 'daemon'>,
  args: string[],
  opts = DEFAULT_OPTS,
): Promise<unknown> {
  const stdout = await wxRaw(command, [...args, '--json'], opts);
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`wx ${command} did not return JSON`);
  }
}

function unwrapArray<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  return [];
}

export function resolveWxBinary(): string {
  const configured = (
    process.env.WECHAT_DASHBOARD_WX_BIN ||
    process.env.WECHAT_DASHBOARD_WX_BINARY ||
    ''
  ).trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error('WECHAT_DASHBOARD_WX_BIN must be an absolute path');
    }
    return configured;
  }

  const candidates = [
    join(/*turbopackIgnore: true*/ process.cwd(), 'node_modules', '.bin', 'wx'),
    '/opt/homebrew/bin/wx',
    '/usr/local/bin/wx',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export async function wxSessions(limit = 500): Promise<WxSession[]> {
  const safeLimit = clampInteger(limit, 1, 2_000);
  const payload = await wxJsonPayload('sessions', ['-n', String(safeLimit)]);
  return unwrapArray<WxSession>(payload, ['data', 'sessions', 'items']);
}

export async function wxHistory(
  chat: string,
  since: string,
  until: string,
  limit = 300,
  offset = 0,
): Promise<WxMessage[]> {
  if (!chat || chat.length > 512) throw new Error('Invalid conversation id');
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) throw new Error('Invalid history date');
  const safeLimit = clampInteger(limit, 1, 1_000);
  const safeOffset = clampInteger(offset, 0, 1_000_000);
  const payload = await wxJsonPayload('history', [
    chat,
    '--since',
    since,
    '--until',
    until,
    '-n',
    String(safeLimit),
    '--offset',
    String(safeOffset),
  ]);
  return unwrapArray<WxMessage>(payload, ['data', 'messages', 'items']);
}

export async function wxNewMessages(limit = 1_000): Promise<WxNewMessagesResponse> {
  const safeLimit = clampInteger(limit, 1, 5_000);
  const payload = await wxJsonPayload('new-messages', [
    '-n',
    String(safeLimit),
    '--with-meta',
  ]);
  if (!payload || typeof payload !== 'object') {
    return { count: 0, messages: [] };
  }
  const record = payload as Record<string, unknown>;
  const messages = unwrapArray<WxNewMessagesResponse['messages'][number]>(record, [
    'messages',
    'data',
    'items',
  ]);
  return {
    count: typeof record.count === 'number' ? record.count : messages.length,
    messages,
    meta:
      record.meta && typeof record.meta === 'object'
        ? (record.meta as WxNewMessagesResponse['meta'])
        : undefined,
  };
}

export async function wxDaemonStatus(): Promise<WxDaemonStatus> {
  try {
    const out = await wxRaw('daemon', ['status']);
    const lower = out.toLowerCase();
    const running = lower.includes('running') || lower.includes('运行');
    const pidMatch = out.match(/pid[^\d]*(\d+)/i);
    return {
      running,
      pid: pidMatch ? Number(pidMatch[1]) : undefined,
    };
  } catch {
    return { running: false };
  }
}

export async function wxAvailable(): Promise<boolean> {
  try {
    await run(resolveWxBinary(), ['--version'], { timeout: 5_000, shell: false });
    return true;
  } catch {
    return false;
  }
}

export function isWxConversationNotFound(error: unknown): boolean {
  return error instanceof WxCommandError && error.code === 'WX_CONVERSATION_NOT_FOUND';
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

class WxCommandError extends Error {
  constructor(readonly code: string) {
    super('The local WeChat reader command failed');
    this.name = 'WxCommandError';
  }
}

function normalizeWxError(error: unknown): WxCommandError {
  const stderr =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: string }).stderr ?? '')
      : '';
  if (/找不到联系人|contact not found/i.test(stderr)) {
    return new WxCommandError('WX_CONVERSATION_NOT_FOUND');
  }
  if (/多个|歧义|ambiguous|multiple matches/i.test(stderr)) {
    return new WxCommandError('WX_CONVERSATION_AMBIGUOUS');
  }
  return new WxCommandError('WX_COMMAND_FAILED');
}
