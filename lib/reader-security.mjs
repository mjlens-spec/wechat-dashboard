import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function readerCacheIsPrivate(home = homedir()) {
  const expected = [
    { path: join(home, '.wx-cli'), type: 'directory' },
    { path: join(home, '.wx-cli', 'cache'), type: 'directory' },
    { path: join(home, '.wx-cli', 'all_keys.json'), type: 'file' },
  ];
  try {
    return expected.every(({ path, type }) => {
      const stat = lstatSync(path);
      const correctType = type === 'directory' ? stat.isDirectory() : stat.isFile();
      const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
      return !stat.isSymbolicLink() && correctType && owned && (stat.mode & 0o077) === 0;
    });
  } catch {
    return false;
  }
}
