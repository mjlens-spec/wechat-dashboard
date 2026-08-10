import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);
const LARK_CLI = resolveLarkCli();
const MAX_BUFFER = 32 * 1024 * 1024;
const REQUIRED_SCOPES = [
  'im:chat:read',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
  'im:message:readonly',
  'search:message',
] as const;

const envelopeSchema = z
  .object({
    ok: z.boolean(),
    identity: z.string().optional(),
    data: z.unknown().optional(),
    error: z
      .object({
        type: z.string().optional(),
        subtype: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const chatSchema = z
  .object({
    chat_id: z.string().min(1).max(512),
    chat_mode: z.string().max(32).optional(),
    name: z.string().max(2_048).optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    chat_id: z.string().min(1).max(512),
    chat_name: z.string().max(2_048).optional(),
    chat_type: z.string().max(32).optional(),
    chat_partner: z.unknown().optional(),
    content: z.string().max(2_000_000).optional(),
    create_time: z.union([z.string().max(64), z.number()]),
    deleted: z.boolean().optional(),
    message_id: z.string().min(1).max(512),
    msg_type: z.string().max(64).optional(),
    sender: z.unknown().optional(),
    updated: z.boolean().optional(),
    update_time: z.union([z.string().max(64), z.number()]).optional(),
  })
  .passthrough();

export interface FeishuChat {
  chat_id: string;
  chat_mode?: string;
  name?: string;
}

export interface FeishuMessage {
  chat_id: string;
  chat_name?: string;
  chat_type?: string;
  chat_partner?: unknown;
  content?: string;
  create_time: string | number;
  deleted?: boolean;
  message_id: string;
  msg_type?: string;
  sender?: unknown;
  updated?: boolean;
  update_time?: string | number;
}

export interface FeishuAuthStatus {
  installed: boolean;
  ready: boolean;
  identity: 'user' | 'unknown';
  tokenStatus: string;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  missingScopes: string[];
  errorCode: string | null;
}

export interface FeishuPage<T> {
  items: T[];
  hasMore: boolean;
}

export async function feishuAuthStatus(): Promise<FeishuAuthStatus> {
  try {
    const raw = await runJson(['auth', 'status', '--json', '--verify'], false);
    const record = asRecord(raw);
    const identities = asRecord(record.identities);
    const user = asRecord(identities.user ?? record.user ?? record.data);
    const scopes = stringList(
      user.scope ?? user.scopes ?? record.scopes ?? asRecord(record.token).scopes,
    );
    const status = String(
      user.status ?? record.user_status ?? record.status ?? record.token_status ?? '',
    ).toLowerCase();
    const tokenStatus = String(
      user.tokenStatus ?? user.token_status ?? record.token_status ?? asRecord(record.token).status ?? status,
    );
    const identity =
      String(record.identity ?? user.identity ?? '').toLowerCase() === 'user'
        ? 'user'
        : status === 'ready'
          ? 'user'
          : 'unknown';
    const ready =
      identity === 'user' &&
      !['expired', 'missing', 'invalid', 'error'].includes(tokenStatus.toLowerCase()) &&
      (status === 'ready' || Boolean(record.verified) || Boolean(user.verified)) &&
      user.available !== false;
    return {
      installed: true,
      ready,
      identity,
      tokenStatus: tokenStatus || (ready ? 'valid' : 'unknown'),
      expiresAt: stringOrNull(user.expiresAt ?? user.expires_at ?? record.expires_at),
      refreshExpiresAt: stringOrNull(
        user.refreshExpiresAt ?? user.refresh_expires_at ?? record.refresh_expires_at,
      ),
      missingScopes: REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)),
      errorCode: ready ? null : 'FEISHU_AUTH_NOT_READY',
    };
  } catch (error) {
    return {
      installed: error instanceof FeishuCliError ? error.code !== 'FEISHU_CLI_MISSING' : true,
      ready: false,
      identity: 'unknown',
      tokenStatus: 'unavailable',
      expiresAt: null,
      refreshExpiresAt: null,
      missingScopes: [...REQUIRED_SCOPES],
      errorCode: feishuErrorCode(error),
    };
  }
}

export async function feishuChats(): Promise<FeishuPage<FeishuChat>> {
  const envelope = await runEnvelope([
    'im',
    '+chat-list',
    '--as',
    'user',
    '--types',
    'p2p,group',
    '--sort',
    'active_time',
    '--page-size',
    '100',
    '--page-all',
    '--page-limit',
    '50',
    '--format',
    'json',
  ]);
  const data = asRecord(envelope.data);
  const items = z.array(chatSchema).parse(Array.isArray(data.chats) ? data.chats : []);
  return { items, hasMore: Boolean(data.has_more) };
}

export async function feishuMessages(
  start: string,
  end: string,
): Promise<FeishuPage<FeishuMessage>> {
  const envelope = await runEnvelope([
    'im',
    '+messages-search',
    '--as',
    'user',
    '--query',
    '',
    '--start',
    start,
    '--end',
    end,
    '--page-size',
    '50',
    '--page-all',
    '--page-limit',
    '40',
    '--no-reactions',
    '--format',
    'json',
  ]);
  const data = asRecord(envelope.data);
  const items = z
    .array(messageSchema)
    .parse(Array.isArray(data.messages) ? data.messages : []);
  return { items, hasMore: Boolean(data.has_more) };
}

export function feishuErrorCode(error: unknown): string {
  if (error instanceof FeishuCliError) return error.code;
  if (error instanceof z.ZodError) return 'FEISHU_RESPONSE_INVALID';
  return 'FEISHU_SYNC_FAILED';
}

async function runEnvelope(args: string[]) {
  const raw = await runJson(args, true);
  const envelope = envelopeSchema.parse(raw);
  if (!envelope.ok) {
    const subtype = envelope.error?.subtype?.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    throw new FeishuCliError(subtype ? `FEISHU_${subtype}` : 'FEISHU_API_FAILED');
  }
  if (envelope.identity !== 'user') throw new FeishuCliError('FEISHU_IDENTITY_INVALID');
  return envelope;
}

async function runJson(args: string[], requireUserIdentity: boolean): Promise<unknown> {
  try {
    const { stdout } = await run(LARK_CLI, args, {
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (requireUserIdentity) {
      const record = asRecord(parsed);
      if (record.identity !== 'user') throw new FeishuCliError('FEISHU_IDENTITY_INVALID');
    }
    return parsed;
  } catch (error) {
    if (error instanceof FeishuCliError) throw error;
    const record = asRecord(error);
    if (typeof record.stdout === 'string' && record.stdout.trim()) {
      try {
        const envelope = envelopeSchema.parse(JSON.parse(record.stdout));
        const subtype = envelope.error?.subtype
          ?.toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_');
        throw new FeishuCliError(
          subtype ? `FEISHU_${subtype}` : 'FEISHU_API_FAILED',
        );
      } catch (nested) {
        if (nested instanceof FeishuCliError) throw nested;
      }
    }
    if (record.code === 'ENOENT') throw new FeishuCliError('FEISHU_CLI_MISSING');
    if (record.killed || record.code === 'ETIMEDOUT') {
      throw new FeishuCliError('FEISHU_CLI_TIMEOUT');
    }
    throw new FeishuCliError('FEISHU_CLI_FAILED');
  }
}

class FeishuCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FeishuCliError';
  }
}

function resolveLarkCli(): string {
  for (const path of [
    resolve(process.cwd(), 'node_modules', '.bin', 'lark-cli'),
    '/opt/homebrew/bin/lark-cli',
    '/usr/local/bin/lark-cli',
  ]) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Try the next standard macOS installation path.
    }
  }
  return 'lark-cli';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return typeof value === 'string'
    ? value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
