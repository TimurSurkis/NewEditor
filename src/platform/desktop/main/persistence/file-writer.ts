import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PortError } from '../../../../ports';
import type { Result } from '../../../../core';
import { fileFailure, localFailure } from './errors';

export interface TempIdentity {
  readonly dev: string;
  readonly ino: string;
}
export interface WritePermissions {
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}
export type PublishOutcome =
  | { readonly kind: 'published' }
  | { readonly kind: 'exists' }
  | { readonly kind: 'not-published'; readonly error: PortError };
export interface FileWriteIO {
  check(path: string): Promise<Result<WritePermissions | null, PortError>>;
  prepare(
    path: string,
    name: string,
    bytes: Buffer,
    permissions: WritePermissions | null,
  ): Promise<TempIdentity>;
  publish(
    path: string,
    name: string,
    create: boolean,
    identity: TempIdentity,
    contentHash: string,
  ): Promise<PublishOutcome>;
  removeTemp(path: string, name: string, identity: TempIdentity): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

function errno(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

export function validTempName(name: string): boolean {
  return /^\.neweditor-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(
    name,
  );
}

async function parent(path: string): Promise<void> {
  if ((await realpath(dirname(path))) !== dirname(path))
    throw Object.assign(new Error('Подменён родительский каталог'), { code: 'EBUSY' });
}

function tempPath(path: string, name: string): string {
  if (!validTempName(name)) throw new Error('Некорректное имя временного файла');
  return join(dirname(path), name);
}

export function createFileWriter(): FileWriteIO {
  const removeTemp: FileWriteIO['removeTemp'] = async (path, name, identity) => {
    await parent(path);
    const temp = tempPath(path, name);
    try {
      const stat = await lstat(temp, { bigint: true });
      if (
        stat.isFile() &&
        stat.ino > 0n &&
        String(stat.dev) === identity.dev &&
        String(stat.ino) === identity.ino
      )
        await unlink(temp);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
  };
  return {
    async check(path) {
      try {
        await parent(path);
        let stat;
        try {
          stat = await lstat(path);
        } catch (error) {
          if (errno(error) === 'ENOENT') return { ok: true, value: null };
          throw error;
        }
        if (!stat.isFile() || (await realpath(path)) !== path)
          return localFailure('unsupported', 'Цель больше не является каноническим обычным файлом');
        if (stat.nlink > 1 || stat.ino <= 0)
          return localFailure(
            'unsupported',
            'Безопасная замена файла с такими ссылками/идентичностью не поддерживается',
          );
        if ((stat.mode & 0o222) === 0)
          return localFailure('permission-denied', 'Исходный файл доступен только для чтения');
        await access(path, constants.W_OK);
        return { ok: true, value: { mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid } };
      } catch (error) {
        return fileFailure(error);
      }
    },
    async prepare(path, name, bytes, permissions) {
      await parent(path);
      const temp = tempPath(path, name);
      const handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let identity: TempIdentity | undefined;
      try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.ino <= 0n)
          throw Object.assign(new Error('Нельзя подтвердить идентичность temp'), {
            code: 'ENOTSUP',
          });
        identity = { dev: String(stat.dev), ino: String(stat.ino) };
        await handle.writeFile(bytes);
        if (permissions) {
          if (process.platform !== 'win32') await handle.chown(permissions.uid, permissions.gid);
          await handle.chmod(permissions.mode);
        }
        await handle.sync();
        await handle.close();
        return identity;
      } catch (error) {
        try {
          await handle.close();
        } catch {
          /* Первичная ошибка важнее повторного close. */
        }
        if (identity) {
          try {
            await removeTemp(path, name, identity);
          } catch {
            /* Оставляем недоказуемый/недоступный temp. */
          }
        }
        throw error;
      }
    },
    async publish(path, name, create, identity, contentHash) {
      await parent(path);
      try {
        const temp = tempPath(path, name);
        const handle = await open(
          temp,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        try {
          const before = await handle.stat({ bigint: true });
          if (
            !before.isFile() ||
            before.nlink !== 1n ||
            String(before.dev) !== identity.dev ||
            String(before.ino) !== identity.ino
          )
            return {
              kind: 'not-published',
              error: localFailure('busy', 'Временный файл подменён', true).error,
            };
          const bytes = await handle.readFile();
          const after = await handle.stat({ bigint: true });
          const named = await lstat(temp, { bigint: true });
          if (
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            after.ino !== named.ino ||
            after.dev !== named.dev ||
            createHash('sha256').update(bytes).digest('hex') !== contentHash
          )
            return {
              kind: 'not-published',
              error: localFailure('busy', 'Содержимое временного файла изменилось', true).error,
            };
        } finally {
          await handle.close();
        }
        if (create) await link(tempPath(path, name), path);
        else await rename(tempPath(path, name), path);
        return { kind: 'published' };
      } catch (error) {
        if (create && errno(error) === 'EEXIST') return { kind: 'exists' };
        if (['EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(errno(error))))
          return {
            kind: 'not-published',
            error: localFailure(
              'unsupported',
              'Файловая система не поддерживает безопасную публикацию',
            ).error,
          };
        return { kind: 'not-published', error: fileFailure(error).error };
      }
    },
    removeTemp,
    async syncDirectory(path) {
      let handle;
      try {
        handle = await open(dirname(path), 'r');
        await handle.sync();
      } catch (error) {
        if (
          ![
            'EINVAL',
            'ENOTSUP',
            'EOPNOTSUPP',
            ...(process.platform === 'win32' ? ['EISDIR', 'EPERM'] : []),
          ].includes(String(errno(error)))
        )
          throw error;
      } finally {
        await handle?.close();
      }
    },
  };
}
