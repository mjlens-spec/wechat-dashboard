import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';

export function securePrivateDirectory(path, { create = false } = {}) {
  let stat = safeLstat(path);
  if (!stat) {
    if (!create) throw new Error(`Required private directory is missing: ${path}`);
    mkdirSync(path, { mode: 0o700 });
    stat = lstatSync(path);
  }
  assertOwnedType(path, stat, 'directory');
  chmodSync(path, 0o700);
  assertOwnedType(path, lstatSync(path), 'directory');
  return true;
}

export function securePrivateFile(path, { allowMissing = false } = {}) {
  const stat = safeLstat(path);
  if (!stat) {
    if (allowMissing) return false;
    throw new Error(`Required private file is missing: ${path}`);
  }
  assertOwnedType(path, stat, 'file');
  chmodSync(path, 0o600);
  assertOwnedType(path, lstatSync(path), 'file');
  return true;
}

export function createPrivateFile(path) {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    assertOwnedType(path, fstatSync(fd), 'file');
  } finally {
    closeSync(fd);
  }
  securePrivateFile(path);
}

export function openPrivateAppendFile(path) {
  securePrivateFile(path, { allowMissing: true });
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    assertOwnedType(path, fstatSync(fd), 'file');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function safeLstat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertOwnedType(path, stat, expected) {
  const correctType = expected === 'directory' ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !correctType) {
    throw new Error(`Private ${expected} must not be a symlink or another file type: ${path}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Private ${expected} must be owned by the current user: ${path}`);
  }
}
