import { copyFrozen } from '../../../../core';
import type { Result, StorageRef } from '../../../../core';
import type { DraftKey, DraftRecord, PortError } from '../../../../ports';
import { fields, nonempty, parseSnapshot } from './save-data';
import { localFailure } from './errors';

export function draftKey(value: DraftKey): string {
  return JSON.stringify([value.documentId, value.sessionId]);
}

export function parseDraftKey(value: unknown): DraftKey {
  const data = fields(value, ['documentId', 'sessionId']);
  return copyFrozen({
    documentId: nonempty(data['documentId']),
    sessionId: nonempty(data['sessionId']),
  });
}

export function draftRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Некорректная ревизия черновика');
  return value;
}

export function parseDraftRecord(value: unknown): Result<DraftRecord, PortError> {
  try {
    const data = fields(value, [
      'key',
      'format',
      'location',
      'snapshot',
      'baseline',
      'baseStorageRevision',
      'stateRevision',
    ]);
    const key = parseDraftKey(data['key']);
    const format = data['format'];
    if (format !== 'txt' && format !== 'markdown') throw new Error('Некорректный формат черновика');
    let location: StorageRef | null = null;
    if (data['location'] !== null) {
      const ref = fields(data['location'], ['storageId', 'resourceId']);
      const storageId = nonempty(ref['storageId']),
        resourceId = nonempty(ref['resourceId']);
      if (storageId !== 'local')
        return localFailure('unsupported', 'Неподдерживаемое хранилище черновика');
      location = { storageId, resourceId };
    }
    return {
      ok: true,
      value: copyFrozen({
        key,
        format,
        location,
        snapshot: parseSnapshot(data['snapshot']),
        baseline: parseSnapshot(data['baseline']),
        baseStorageRevision:
          data['baseStorageRevision'] === null ? null : nonempty(data['baseStorageRevision']),
        stateRevision: draftRevision(data['stateRevision']),
      }),
    };
  } catch {
    return localFailure('invalid-input', 'Некорректный черновик');
  }
}
