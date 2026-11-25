import { createHash } from 'node:crypto';
import { copyFrozen, validateSnapshot } from '../../../../core';
import type { DocumentSnapshot, Result } from '../../../../core';
import type { CommitOutcome, PortError, SaveReceipt, SaveRequest } from '../../../../ports';
import { localFailure } from './errors';

export function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Некорректный DTO');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error('Некорректный DTO');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== names.length ||
    names.some(
      (name) =>
        !descriptors[name] || !('value' in descriptors[name]) || !descriptors[name].enumerable,
    )
  )
    throw new Error('Некорректные поля DTO');
  return Object.fromEntries(names.map((name) => [name, descriptors[name]!.value as unknown]));
}

export function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Некорректный идентификатор');
  return value;
}

export function parseSnapshot(value: unknown): DocumentSnapshot {
  const body = fields(value, ['text', 'fileMetadata']);
  const metadata = fields(body['fileMetadata'], ['encoding', 'bom']);
  const text = body['text'];
  const encoding = metadata['encoding'];
  const bom = metadata['bom'];
  if (
    typeof text !== 'string' ||
    (encoding !== 'utf-8' && encoding !== 'windows-1251') ||
    typeof bom !== 'boolean'
  )
    throw new Error('Некорректный снимок');
  const snapshot: DocumentSnapshot = { text, fileMetadata: { encoding, bom } };
  if (validateSnapshot(snapshot)) throw new Error('Некорректный снимок');
  return copyFrozen(snapshot);
}

export function parseSaveRequest(value: unknown): Result<SaveRequest, PortError> {
  try {
    const data = fields(value, [
      'operationId',
      'documentId',
      'format',
      'target',
      'snapshot',
      'access',
    ]);
    const target = fields(data['target'], ['ref', 'expectedRevision']);
    const ref = fields(target['ref'], ['storageId', 'resourceId']);
    const operationId = nonempty(data['operationId']);
    const documentId = nonempty(data['documentId']);
    const storageId = nonempty(ref['storageId']);
    const resourceId = nonempty(ref['resourceId']);
    const expectedRevision =
      target['expectedRevision'] === null ? null : nonempty(target['expectedRevision']);
    const format = data['format'];
    if (format !== 'txt' && format !== 'markdown') throw new Error('Некорректный формат');
    const snapshot = parseSnapshot(data['snapshot']);
    if (data['access'] !== null) {
      const lease = fields(data['access'], ['token', 'expiresAt']);
      nonempty(lease['token']);
      if (
        typeof lease['expiresAt'] !== 'number' ||
        !Number.isSafeInteger(lease['expiresAt']) ||
        lease['expiresAt'] < 0
      )
        throw new Error('Некорректная аренда');
    }
    if (storageId !== 'local' || data['access'] !== null)
      return localFailure('unsupported', 'Поддерживается локальное сохранение без аренды');
    return {
      ok: true,
      value: copyFrozen({
        operationId,
        documentId,
        format,
        target: { ref: { storageId, resourceId }, expectedRevision },
        snapshot,
        access: null,
      }),
    };
  } catch {
    return localFailure('invalid-input', 'Некорректный запрос сохранения');
  }
}

export function requestHash(request: SaveRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.operationId,
        request.documentId,
        request.format,
        request.target.ref.storageId,
        request.target.ref.resourceId,
        request.target.expectedRevision,
        request.snapshot.text,
        request.snapshot.fileMetadata.encoding,
        request.snapshot.fileMetadata.bom,
        request.access,
      ]),
    )
    .digest('hex');
}

export function parseReceipt(value: unknown, request: SaveRequest): SaveReceipt {
  const data = fields(value, [
    'operationId',
    'documentId',
    'format',
    'ref',
    'storageRevision',
    'versionId',
  ]);
  const ref = fields(data['ref'], ['storageId', 'resourceId']);
  if (
    data['operationId'] !== request.operationId ||
    data['documentId'] !== request.documentId ||
    data['format'] !== request.format ||
    ref['storageId'] !== 'local' ||
    ref['resourceId'] !== request.target.ref.resourceId
  )
    throw new Error('Несогласованное подтверждение сохранения');
  return copyFrozen({
    operationId: request.operationId,
    documentId: request.documentId,
    format: request.format,
    ref: request.target.ref,
    storageRevision: nonempty(data['storageRevision']),
    versionId: data['versionId'] === null ? null : nonempty(data['versionId']),
  });
}

export function parseOutcome(value: unknown, request: SaveRequest): CommitOutcome {
  if (!value || typeof value !== 'object' || !('kind' in value))
    throw new Error('Некорректный исход');
  switch (value.kind) {
    case 'saved': {
      const data = fields(value, ['kind', 'receipt']);
      return { kind: 'saved', receipt: parseReceipt(data['receipt'], request) };
    }
    case 'conflict': {
      const data = fields(value, ['kind', 'actualRevision']);
      return {
        kind: 'conflict',
        actualRevision: data['actualRevision'] === null ? null : nonempty(data['actualRevision']),
      };
    }
    case 'not-written': {
      const data = fields(value, ['kind', 'error']);
      const error = fields(data['error'], ['code', 'message', 'retryable']);
      const code = error['code'];
      const codes: readonly PortError['code'][] = [
        'invalid-input',
        'not-found',
        'permission-denied',
        'encoding-error',
        'io-error',
        'busy',
        'cancelled',
        'unsupported',
        'target-required',
      ];
      if (
        !codes.some((allowed) => allowed === code) ||
        typeof error['message'] !== 'string' ||
        typeof error['retryable'] !== 'boolean'
      )
        throw new Error('Некорректная ошибка операции');
      return {
        kind: 'not-written',
        error: {
          code: code as PortError['code'],
          message: error['message'],
          retryable: error['retryable'],
        },
      };
    }
    default:
      throw new Error('Некорректный завершённый исход');
  }
}
