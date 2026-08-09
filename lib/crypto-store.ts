import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';

const KEYCHAIN_SERVICE = 'com.mjlens.wechat-dashboard';
const KEYCHAIN_ACCOUNT = 'local-message-store';
const ENVELOPE_VERSION = 'v1';
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

export class EncryptionKeyUnavailableError extends Error {
  readonly code = 'ENCRYPTION_KEY_UNAVAILABLE';

  constructor() {
    super('无法访问 WeChat Dashboard 的本机加密密钥');
    this.name = 'EncryptionKeyUnavailableError';
  }
}

export function encryptSensitiveText(value: string, context: string): string {
  if (!value) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptSensitiveText(value: string, context: string): string {
  if (!value) return '';
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(':');
  if (version !== ENVELOPE_VERSION || !ivRaw || !tagRaw || ciphertextRaw === undefined) {
    throw new Error('Unsupported encrypted field');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnvironment = process.env.WECHAT_DASHBOARD_MASTER_KEY?.trim();
  if (fromEnvironment) {
    cachedKey = decodeKey(fromEnvironment);
    return cachedKey;
  }

  if (process.platform !== 'darwin') {
    throw new EncryptionKeyUnavailableError();
  }

  try {
    const existing = execFileSync(
      '/usr/bin/security',
      [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
        '-w',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    cachedKey = decodeKey(existing);
    return cachedKey;
  } catch {
    // The item does not exist yet. Create it once in the current user's Keychain.
  }

  const generated = randomBytes(KEY_BYTES).toString('base64');
  try {
    execFileSync(
      '/usr/bin/security',
      [
        'add-generic-password',
        '-U',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
        '-w',
        generated,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    cachedKey = Buffer.from(generated, 'base64');
    return cachedKey;
  } catch {
    throw new EncryptionKeyUnavailableError();
  }
}

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) throw new EncryptionKeyUnavailableError();
  return key;
}
