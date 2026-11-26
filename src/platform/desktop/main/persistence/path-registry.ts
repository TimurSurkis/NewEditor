import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import type { DocumentFormat, Result } from '../../../../core';
import type { PortError } from '../../../../ports';
import { fileFailure, localFailure } from './errors';
import type { LocalRepository, ResourceRecord } from './repository';

export type RegistrationPurpose = 'open' | 'save-target';

function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function formatOf(path: string): DocumentFormat | undefined {
  switch (extname(path).toLowerCase()) {
    case '.txt':
      return 'txt';
    case '.md':
    case '.markdown':
      return 'markdown';
    default:
      return undefined;
  }
}

interface CanonicalPath {
  readonly path: string;
  readonly format: DocumentFormat;
  readonly stat: BigIntStats | null;
}

async function canonicalize(
  path: string,
  purpose: RegistrationPurpose,
): Promise<Result<CanonicalPath, PortError>> {
  let first: BigIntStats;
  try {
    first = await lstat(path, { bigint: true });
  } catch (error) {
    if (!missing(error) || purpose === 'open') return fileFailure(error);
    const parent = await realpath(dirname(path));
    const candidate = join(parent, basename(path));
    const format = formatOf(candidate);
    if (!format) return localFailure('unsupported', 'Поддерживаются только TXT и Markdown');
    try {
      await lstat(candidate);
      return localFailure('busy', 'Цель появилась во время выбора; повторите выбор', true);
    } catch (checkError) {
      if (!missing(checkError)) return fileFailure(checkError);
    }
    return { ok: true, value: { path: candidate, format, stat: null } };
  }
  if (!first.isFile() && !first.isSymbolicLink())
    return localFailure('unsupported', 'Выбранный путь не является обычным файлом');
  // Dangling symlink не становится отсутствующей save-target.
  const canonical = await realpath(path);
  const stat = await lstat(canonical, { bigint: true });
  if (!stat.isFile())
    return localFailure('unsupported', 'Выбранная ссылка не ведёт к обычному файлу');
  const after = await lstat(path, { bigint: true });
  if (
    first.dev !== after.dev ||
    first.ino !== after.ino ||
    first.ctimeNs !== after.ctimeNs ||
    (await realpath(path)) !== canonical
  )
    return localFailure('busy', 'Путь изменился во время выбора', true);
  const format = formatOf(canonical);
  if (!format) return localFailure('unsupported', 'Поддерживаются только TXT и Markdown');
  return { ok: true, value: { path: canonical, format, stat } };
}

export async function resolveLocalPath(
  path: string,
  purpose: RegistrationPurpose,
): Promise<Result<CanonicalPath, PortError>> {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    !['open', 'save-target'].includes(purpose)
  )
    return localFailure('invalid-input', 'Некорректный абсолютный путь или назначение регистрации');
  try {
    return await canonicalize(path, purpose);
  } catch (error) {
    return fileFailure(error);
  }
}

export async function registerLocalPath(
  repository: LocalRepository,
  path: string,
  purpose: RegistrationPurpose,
  isActive: () => boolean,
): Promise<Result<ResourceRecord, PortError>> {
  const resolved = await resolveLocalPath(path, purpose);
  if (!resolved.ok) return resolved;
  const target = resolved.value;
  let found = repository.findPath(target.path);
  // realpath обычно уже объединяет алиасы. Для оставшихся nlink=1 проверяем
  // живой старый путь, а не переносим историю по inode исчезнувшего файла.
  if (!found && target.stat && target.stat.nlink === 1n && target.stat.ino > 0n) {
    for (const candidate of repository.all()) {
      try {
        if ((await realpath(candidate.canonicalPath)) !== candidate.canonicalPath) continue;
        const stat = await lstat(candidate.canonicalPath, { bigint: true });
        if (
          stat.isFile() &&
          stat.nlink === 1n &&
          stat.dev === target.stat.dev &&
          stat.ino === target.stat.ino
        )
          found = candidate;
      } catch {
        // Недоступный/исчезнувший старый путь не подтверждает совпадение ресурса.
      }
      if (found) break;
    }
  }
  if (!isActive()) return localFailure('permission-denied', 'Владелец доступа уже закрыт');
  return { ok: true, value: found ?? repository.register(target.path, target.format) };
}
