import { basename } from 'node:path';
import type { Result, StorageRef } from '../../../core';
import type {
  CloseDecision,
  OpenDialogResult,
  SaveDialogRequest,
  SaveDialogResult,
} from '../../../application';
import type { LoadedDocument, OperationStatus, PortError, SaveResult } from '../../../ports';
import type { LocalClient } from './persistence/local-services';
import { fields, nonempty, parseSaveRequest } from './persistence/save-data';
import { draftRevision, parseDraftKey } from './persistence/draft-data';
import { localFailure } from './persistence/errors';
import { resolveLocalPath } from './persistence/path-registry';
import { createFileProbe } from './persistence/file-reader';

export interface FileDialogs {
  pickSave(
    input: SaveDialogRequest & { readonly currentPath: string | null },
  ): Promise<string | null>;
  confirmOverwrite(displayName: string): Promise<boolean>;
  confirmClose(displayName: string): Promise<CloseDecision>;
}
function ref(value: unknown): StorageRef {
  const data = fields(value, ['storageId', 'resourceId']);
  return { storageId: nonempty(data['storageId']), resourceId: nonempty(data['resourceId']) };
}
function name(value: unknown): string {
  const text = nonempty(value);
  if (/[\\/\0]/.test(text) || text === '.' || text === '..') throw new Error('Некорректное имя');
  return text;
}
export function fileIpcFailure(channel: string, error: PortError, input: unknown) {
  if (channel === 'document:save') return { kind: 'not-written' as const, error };
  if (channel === 'operation:reconcile') {
    const id: unknown =
      input && typeof input === 'object'
        ? Object.getOwnPropertyDescriptor(input, 'operationId')?.value
        : undefined;
    return { kind: 'unknown' as const, operationId: typeof id === 'string' ? id : '', error };
  }
  return { ok: false as const, error };
}

export function createFileIpc(
  client: LocalClient,
  pickPaths: () => Promise<readonly string[] | null>,
  dialogs?: FileDialogs,
) {
  let active = true;
  let picking: Promise<Result<OpenDialogResult | null, PortError>> | null = null;
  const denied = () => localFailure('permission-denied', 'Окно документа закрыто');
  return {
    async pickSave(input: unknown): Promise<Result<SaveDialogResult | null, PortError>> {
      if (!active) return denied();
      if (!dialogs) return localFailure('unsupported', 'Диалог сохранения не подключён');
      let request: SaveDialogRequest;
      try {
        const data = fields(input, ['suggestedName', 'format', 'current']);
        if (data['format'] !== 'txt' && data['format'] !== 'markdown') throw new Error('format');
        request = {
          suggestedName: name(data['suggestedName']),
          format: data['format'],
          current: data['current'] === null ? null : ref(data['current']),
        };
      } catch {
        return localFailure('invalid-input', 'Некорректный запрос выбора цели');
      }
      try {
        let currentPath: string | null = null;
        if (request.current) {
          const described = await client.describeResource(request.current);
          if (!described.ok) return described;
          currentPath = described.value.path;
        }
        if (!active) return denied();
        const path = await dialogs.pickSave({ ...request, currentPath });
        if (!active) return denied();
        if (path === null) return { ok: true, value: null };
        const resolved = await resolveLocalPath(path, 'save-target');
        if (!resolved.ok) return resolved;
        if (resolved.value.format !== request.format)
          return localFailure('unsupported', 'Расширение цели не соответствует формату документа');
        const probe = await createFileProbe()(resolved.value.path);
        if (!active) return denied();
        if (!probe.ok && probe.error.code !== 'not-found') return probe;
        const expectedRevision = probe.ok ? probe.value.storageRevision : null;
        if (
          expectedRevision !== null &&
          !(await dialogs.confirmOverwrite(basename(resolved.value.path)))
        )
          return { ok: true, value: null };
        if (!active) return denied();
        const registered = await client.registerPath(resolved.value.path, 'save-target');
        if (!registered.ok) return registered;
        if (!active) return denied();
        return {
          ok: true,
          value: {
            target: { ref: registered.value, expectedRevision },
            displayName: basename(resolved.value.path),
          },
        };
      } catch {
        return localFailure('io-error', 'Не удалось выбрать цель сохранения');
      }
    },
    async confirmClose(input: unknown): Promise<Result<CloseDecision, PortError>> {
      if (!active) return denied();
      if (!dialogs) return localFailure('unsupported', 'Диалог закрытия не подключён');
      let displayName: string;
      try {
        displayName = name(fields(input, ['displayName'])['displayName']);
      } catch {
        return localFailure('invalid-input', 'Некорректный запрос закрытия');
      }
      try {
        const value = await dialogs.confirmClose(displayName);
        return active ? { ok: true, value } : denied();
      } catch {
        return localFailure('io-error', 'Не удалось подтвердить закрытие');
      }
    },
    async saveDocument(input: unknown): Promise<SaveResult> {
      const parsed = parseSaveRequest(input);
      if (!parsed.ok) return { kind: 'not-written', error: parsed.error };
      if (!active) return { kind: 'not-written', error: denied().error };
      try {
        return await client.documents.save(parsed.value);
      } catch {
        return {
          kind: 'unknown',
          operationId: parsed.value.operationId,
          error: localFailure('io-error', 'Исход записи требует проверки', true).error,
        };
      }
    },
    async getOperation(input: unknown): Promise<Result<OperationStatus, PortError>> {
      if (!active) return denied();
      try {
        return await client.documents.getOperation(
          nonempty(fields(input, ['operationId'])['operationId']),
        );
      } catch {
        return localFailure('invalid-input', 'Некорректный запрос операции');
      }
    },
    async reconcileOperation(input: unknown): Promise<SaveResult> {
      let operationId = '';
      try {
        operationId = nonempty(fields(input, ['operationId'])['operationId']);
      } catch {
        return {
          kind: 'unknown',
          operationId,
          error: localFailure('invalid-input', 'Некорректный запрос операции').error,
        };
      }
      if (!active) return { kind: 'unknown', operationId, error: denied().error };
      try {
        return await client.documents.reconcile(operationId);
      } catch {
        return {
          kind: 'unknown',
          operationId,
          error: localFailure('io-error', 'Не удалось проверить сохранение').error,
        };
      }
    },
    async pickOpen(input: unknown): Promise<Result<OpenDialogResult | null, PortError>> {
      if (input !== null) return localFailure('invalid-input', 'Ожидается пустой запрос');
      if (!active) return denied();
      if (picking) return picking;
      picking = Promise.resolve().then(async () => {
        try {
          if (!active) return denied();
          const paths = await pickPaths();
          if (!active) return denied();
          if (paths === null) return { ok: true, value: null };
          const documents: { ref: StorageRef; displayName: string }[] = [],
            errors: { displayName: string; error: PortError }[] = [];
          for (const path of paths) {
            if (!active) return denied();
            const registered = await client.registerPath(path, 'open');
            if (!active) return denied();
            const displayName = basename(path);
            if (registered.ok) documents.push({ ref: registered.value, displayName });
            else errors.push({ displayName, error: registered.error });
          }
          return { ok: true, value: { documents, errors } };
        } catch {
          return localFailure('io-error', 'Не удалось выбрать документы');
        } finally {
          picking = null;
        }
      });
      return picking;
    },
    async loadDocument(input: unknown): Promise<Result<LoadedDocument, PortError>> {
      if (!active) return denied();
      let ref: StorageRef;
      try {
        const request = fields(input, ['ref']),
          data = fields(request['ref'], ['storageId', 'resourceId']);
        ref = {
          storageId: nonempty(data['storageId']),
          resourceId: nonempty(data['resourceId']),
        };
      } catch {
        return localFailure('invalid-input', 'Некорректный запрос загрузки');
      }
      try {
        return await client.documents.load(ref, null);
      } catch {
        return localFailure('io-error', 'Не удалось загрузить документ');
      }
    },
    async removeDraft(input: unknown): Promise<Result<null, PortError>> {
      if (!active) return denied();
      try {
        const request = fields(input, ['key', 'through']),
          key = parseDraftKey(request['key']),
          through = draftRevision(request['through']);
        const result = await client.drafts.removeThrough(key, through);
        return result.ok ? { ok: true, value: null } : result;
      } catch {
        return localFailure('invalid-input', 'Некорректный запрос очистки черновика');
      }
    },
    close() {
      active = false;
      client.close();
    },
  };
}
