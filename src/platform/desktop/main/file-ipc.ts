import { basename } from 'node:path';
import type { Result, StorageRef } from '../../../core';
import type { OpenDialogResult } from '../../../application';
import type { LoadedDocument, PortError } from '../../../ports';
import type { LocalClient } from './persistence/local-services';
import { fields, nonempty } from './persistence/save-data';
import { draftRevision, parseDraftKey } from './persistence/draft-data';
import { localFailure } from './persistence/errors';

export function createFileIpc(
  client: LocalClient,
  pickPaths: () => Promise<readonly string[] | null>,
) {
  let active = true;
  let picking: Promise<Result<OpenDialogResult | null, PortError>> | null = null;
  const denied = () => localFailure('permission-denied', 'Окно документа закрыто');
  return {
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
