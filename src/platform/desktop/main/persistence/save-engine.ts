import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import type { Result } from '../../../../core';
import { equalSnapshots } from '../../../../core';
import type {
  CommitOutcome,
  PortError,
  SaveReceipt,
  SaveRequest,
  SaveResult,
} from '../../../../ports';
import { encodeFile } from './codec';
import { fileFailure, localFailure } from './errors';
import type { ReadLocalFile } from './file-reader';
import { createFileReader } from './file-reader';
import type { FileWriteIO } from './file-writer';
import type { LocalRepository, ResourceRecord } from './repository';
import type { JournalOperation, SaveJournal } from './save-journal';
import { requestHash } from './save-data';

const failed = (error: PortError): CommitOutcome => ({ kind: 'not-written', error });
const error = (message: string): PortError => ({ code: 'io-error', message, retryable: true });
const unknown = (id: string): SaveResult => ({
  kind: 'unknown',
  operationId: id,
  error: error('Исход сохранения требует проверки журнала'),
});

export function createSaveEngine(
  repository: LocalRepository,
  journal: SaveJournal,
  readFile: ReturnType<typeof createFileReader>,
  io: FileWriteIO,
  onConfirmed: (receipt: SaveReceipt) => void = () => {},
) {
  async function current(
    record: ResourceRecord,
    operation?: JournalOperation,
  ): Promise<Result<ReadLocalFile | null, PortError>> {
    const read = await readFile(
      record.canonicalPath,
      operation
        ? { contentHash: operation.newHash, fileMetadata: operation.request.snapshot.fileMetadata }
        : record.hint,
    );
    return !read.ok && read.error.code === 'not-found' ? { ok: true, value: null } : read;
  }
  async function clean(record: ResourceRecord, operation: JournalOperation): Promise<boolean> {
    if (operation.tempName && operation.tempIdentity) {
      try {
        await io.removeTemp(record.canonicalPath, operation.tempName, operation.tempIdentity);
      } catch {
        /* Не удаляем неподтверждённый/недоступный temp. */
        return false;
      }
    }
    return true;
  }
  function finish(operation: JournalOperation, receipt: SaveReceipt): SaveResult {
    try {
      journal.written(operation, receipt);
      return journal.finish(operation);
    } catch {
      return {
        kind: 'history-pending',
        receipt,
        error: error('Файл подтверждён; фиксация истории ожидает восстановления'),
      };
    }
  }
  async function reconcile(operation: JournalOperation): Promise<SaveResult> {
    if (operation.phase === 'settled') return operation.outcome!;
    if (operation.phase === 'needs-attention') return unknown(operation.request.operationId);
    const record = repository.get(operation.request.target.ref.resourceId);
    if (!record) return unknown(operation.request.operationId);
    if (operation.phase === 'file-written') {
      await clean(record, operation);
      return finish(operation, operation.receipt!);
    }
    if (operation.phase === 'prepared') {
      await clean(record, operation);
      return journal.settle(
        operation.request,
        failed(error('Подготовленное сохранение не было опубликовано')),
      );
    }
    if (!(await clean(record, operation))) return unknown(operation.request.operationId);
    const actual = await current(record, operation);
    if (
      actual.ok &&
      operation.tempName &&
      (actual.value?.storageRevision ?? null) === operation.oldRevision
    )
      return journal.settle(
        operation.request,
        failed(error('Публикация метаданных/содержимого не состоялась')),
      );
    if (actual.ok && actual.value?.contentHash === operation.newHash) {
      const receipt: SaveReceipt = {
        operationId: operation.request.operationId,
        documentId: operation.request.documentId,
        format: operation.request.format,
        ref: operation.request.target.ref,
        storageRevision: actual.value.storageRevision,
        versionId: null,
      };
      onConfirmed(receipt);
      return finish(operation, receipt);
    }
    if (actual.ok && (actual.value?.storageRevision ?? null) === operation.oldRevision)
      return journal.settle(
        operation.request,
        failed(error('Публикация сохранения не состоялась')),
      );
    journal.attention(operation);
    return unknown(operation.request.operationId);
  }

  async function aliases(record: ResourceRecord): Promise<boolean> {
    const stat = await lstat(record.canonicalPath, { bigint: true }).catch(() => null);
    if (!stat) return false;
    for (const other of repository.all()) {
      if (other.resourceId === record.resourceId) continue;
      try {
        if ((await realpath(other.canonicalPath)) !== other.canonicalPath) continue;
        const candidate = await lstat(other.canonicalPath, { bigint: true });
        if (candidate.isFile() && candidate.dev === stat.dev && candidate.ino === stat.ino)
          return true;
      } catch {
        /* Исчезнувший путь не подтверждает алиас. */
      }
    }
    return false;
  }

  async function save(request: SaveRequest, accepted: () => boolean): Promise<SaveResult> {
    let operation: JournalOperation | undefined;
    let publicationStarted = false;
    let receipt: SaveReceipt | undefined;
    let record: ResourceRecord | undefined;
    let lookupComplete = false;
    try {
      const cached = journal.get(request.operationId);
      lookupComplete = true;
      if (cached) {
        if (requestHash(cached.request) !== requestHash(request))
          return failed(localFailure('invalid-input', 'Другой запрос для operationId').error);
        try {
          return await reconcile(cached);
        } catch {
          return unknown(request.operationId);
        }
      }
      record = repository.get(request.target.ref.resourceId);
      if (!record) return failed(localFailure('not-found', 'Ресурс отсутствует в реестре').error);
      const pending = journal.pendingFor(record.resourceId);
      if (pending) {
        const result = await reconcile(pending);
        if (result.kind === 'history-pending' || result.kind === 'unknown')
          return failed(localFailure('busy', 'Предыдущее сохранение ещё не разрешено', true).error);
        // Reconcile мог изменить encoding/DocumentId цели при тех же байтах.
        record = repository.get(request.target.ref.resourceId);
        if (!record) return failed(localFailure('not-found', 'Ресурс отсутствует в реестре').error);
      }
      const encoded = encodeFile(request.snapshot);
      if (!encoded.ok) return failed(encoded.error);
      const initial = await current(record);
      if (!initial.ok) return failed(initial.error);
      const old = initial.value;
      if ((old?.storageRevision ?? null) !== request.target.expectedRevision)
        return journal.settle(request, {
          kind: 'conflict',
          actualRevision: old?.storageRevision ?? null,
        });
      const permissions = await io.check(record.canonicalPath);
      if (!permissions.ok) return failed(permissions.error);
      if (await aliases(record))
        return failed(
          localFailure('busy', 'В реестре обнаружена неоднозначная цель записи', true).error,
        );
      if (!accepted())
        return failed(localFailure('permission-denied', 'Владелец доступа уже закрыт').error);
      const sameState =
        old &&
        equalSnapshots(old.snapshot, request.snapshot) &&
        record.documentId === request.documentId &&
        record.format === request.format;
      operation = journal.prepare(
        request,
        old,
        sameState ? null : `.neweditor-${randomUUID()}.tmp`,
      );
      if (operation.tempName) {
        const identity = await io.prepare(
          record.canonicalPath,
          operation.tempName,
          encoded.value,
          permissions.value,
        );
        operation = { ...operation, tempIdentity: identity };
        journal.rememberTemp(operation, identity);
      }
      const checked = await current(record);
      if (!checked.ok)
        throw Object.assign(new Error('Ошибка повторной сверки'), { portError: checked.error });
      if ((checked.value?.storageRevision ?? null) !== operation.oldRevision) {
        await clean(record, operation);
        return journal.settle(request, {
          kind: 'conflict',
          actualRevision: checked.value?.storageRevision ?? null,
        });
      }
      const writable = await io.check(record.canonicalPath);
      if (!writable.ok)
        throw Object.assign(new Error('Цель не доступна для записи'), {
          portError: writable.error,
        });
      if (await aliases(record)) throw new Error('Обнаружен алиас цели');
      journal.replacing(operation);
      if (operation.tempName) {
        publicationStarted = true;
        const published = await io.publish(
          record.canonicalPath,
          operation.tempName,
          old === null,
          operation.tempIdentity!,
          operation.newHash,
        );
        if (published.kind !== 'published') {
          publicationStarted = false;
          await clean(record, operation);
          if (published.kind === 'not-published')
            return journal.settle(request, failed(published.error));
          const appeared = await current(record);
          return journal.settle(
            request,
            appeared.ok
              ? { kind: 'conflict', actualRevision: appeared.value?.storageRevision ?? null }
              : failed(appeared.error),
          );
        }
        if (!(await clean(record, operation)))
          throw new Error('Не удалось очистить опубликованный temp');
        await io.syncDirectory(record.canonicalPath);
      }
      const confirmed = await current(record, operation);
      if (!confirmed.ok) throw new Error('Не удалось подтвердить результат публикации');
      if (!confirmed.value || confirmed.value.contentHash !== operation.newHash) {
        if (!publicationStarted) throw new Error('Состояние изменилось до подтверждения');
        journal.attention(operation);
        return unknown(request.operationId);
      }
      receipt = {
        operationId: request.operationId,
        documentId: request.documentId,
        format: request.format,
        ref: request.target.ref,
        storageRevision: confirmed.value.storageRevision,
        versionId: null,
      };
      onConfirmed(receipt);
      return finish(operation, receipt);
    } catch (cause) {
      if (!lookupComplete) return unknown(request.operationId);
      if (receipt)
        return { kind: 'history-pending', receipt, error: error('История ожидает восстановления') };
      if (publicationStarted) return unknown(request.operationId);
      if (operation && record) await clean(record, operation);
      const portError =
        cause && typeof cause === 'object' && 'portError' in cause
          ? (cause.portError as PortError)
          : fileFailure(cause).error;
      const outcome = failed(portError);
      if (operation) {
        try {
          return journal.settle(request, outcome);
        } catch {
          /* Файл точно не менялся; журнал остаётся для восстановления. */
        }
      }
      return outcome;
    }
  }
  return { save, reconcile };
}
