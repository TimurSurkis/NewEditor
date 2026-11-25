import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { Stats } from 'node:fs';

const posix = process.platform !== 'win32';
function owned(stat: Stats): boolean {
  return !posix || stat.uid === process.getuid!();
}
function protect(path: string, directory: boolean): void {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !(directory ? before.isDirectory() : before.isFile()) ||
    !owned(before) ||
    (!directory && before.nlink !== 1)
  )
    throw new Error('Небезопасный служебный файл или каталог');
  // Windows не предоставляет POSIX directory-fd/fchmod: DACL проверяется в P8.
  if (!posix && directory) return;
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0) |
      (directory ? (constants.O_DIRECTORY ?? 0) : 0),
  );
  try {
    const stat = fstatSync(fd);
    if (
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      !owned(stat) ||
      (!directory && stat.nlink !== 1)
    )
      throw new Error('Служебный путь изменился');
    if (posix) fchmodSync(fd, directory ? 0o700 : 0o600);
    const after = lstatSync(path);
    if (
      after.isSymbolicLink() ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      !owned(after) ||
      (posix && (after.mode & 0o7777) !== (directory ? 0o700 : 0o600)) ||
      (!directory && after.nlink !== 1)
    )
      throw new Error('Служебный путь изменился');
  } finally {
    closeSync(fd);
  }
}

export function prepareServiceProfile(path: string): void {
  if (!isAbsolute(path)) throw new Error('Профиль должен иметь абсолютный путь');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  protect(path, true);
}

export function protectDatabaseFiles(path: string, create: boolean): void {
  if (!isAbsolute(path)) throw new Error('База должна иметь абсолютный путь');
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || !owned(parent) || (posix && (parent.mode & 0o077) !== 0))
    throw new Error('Служебная база требует приватного профиля');
  for (const name of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      protect(name, false);
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT'))
        throw cause;
      if (name === path && create) {
        const fd = openSync(
          path,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        closeSync(fd);
        protect(path, false);
      } else if (name === path) throw cause;
    }
  }
}
