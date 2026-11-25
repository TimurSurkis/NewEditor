import type { PortError } from '../../../../ports';

export function localFailure(
  code: PortError['code'],
  message: string,
  retryable = false,
): { readonly ok: false; readonly error: PortError } {
  return { ok: false, error: { code, message, retryable } };
}

export function fileFailure(error: unknown): { readonly ok: false; readonly error: PortError } {
  const code =
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'SQLITE_BUSY':
    case 'SQLITE_LOCKED':
      return localFailure('busy', 'Служебная база временно занята', true);
    case 'ENOENT':
      return localFailure('not-found', 'Файл или его каталог не найден');
    case 'EACCES':
    case 'EPERM':
      return localFailure('permission-denied', 'Нет доступа к файлу');
    case 'ELOOP':
    case 'EISDIR':
    case 'ENOTSUP':
    case 'EOPNOTSUPP':
    case 'EXDEV':
      return localFailure('unsupported', 'Путь не является поддерживаемым обычным файлом');
    case 'EBUSY':
    case 'ETXTBSY':
    case 'EAGAIN':
      return localFailure('busy', 'Файл временно занят', true);
    default:
      return localFailure('io-error', 'Ошибка операции с файлом', true);
  }
}
