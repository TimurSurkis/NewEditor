import { randomUUID } from 'node:crypto';
import { copyFrozen } from '../../../../core';
import type { Result, StorageRef } from '../../../../core';
import type { DocumentStore, HistoryStore, PortError } from '../../../../ports';
import type { ServiceDatabase } from '../database';
import { createFileReader } from './file-reader';
import { localFailure } from './errors';
import { createLocalRepository } from './repository';
import type { ResourceRecord } from './repository';
import { registerLocalPath } from './path-registry';
import type { RegistrationPurpose } from './path-registry';
import { ResourceQueue } from './queue';

export interface LocalReadClient {
  registerPath(path: string, purpose: RegistrationPurpose): Promise<Result<StorageRef, PortError>>;
  readonly documents: Pick<DocumentStore, 'load'>;
  readonly history: HistoryStore;
  close(): void;
}

export interface LocalReadServices {
  createClient(owner: object): LocalReadClient;
}

export interface LocalReadOptions {
  readonly id?: () => string;
  readonly now?: () => number;
  readonly readFile?: ReturnType<typeof createFileReader>;
}

const services = new WeakMap<ServiceDatabase['connection'], LocalReadServices>();

function databaseFailure(error: unknown): { readonly ok: false; readonly error: PortError } {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    ? localFailure('busy', 'Служебная база временно занята', true)
    : localFailure('io-error', 'Не удалось прочитать или обновить служебные данные');
}

function refId(ref: StorageRef): Result<string, PortError> {
  const prototype =
    ref && typeof ref === 'object' ? (Object.getPrototypeOf(ref) as unknown) : undefined;
  const fields: Record<string, PropertyDescriptor> =
    ref &&
    typeof ref === 'object' &&
    !Array.isArray(ref) &&
    (prototype === Object.prototype || prototype === null)
      ? Object.getOwnPropertyDescriptors(ref)
      : {};
  const storageId: unknown = fields['storageId']?.value;
  const resourceId: unknown = fields['resourceId']?.value;
  if (typeof storageId !== 'string' || !storageId || typeof resourceId !== 'string' || !resourceId)
    return localFailure('invalid-input', 'Некорректная ссылка на ресурс');
  return storageId === 'local'
    ? { ok: true, value: resourceId }
    : localFailure('unsupported', 'Неподдерживаемое хранилище');
}

export function createLocalReadServices(
  database: ServiceDatabase,
  options: LocalReadOptions = {},
): LocalReadServices {
  const existing = services.get(database.connection);
  if (existing) return existing;
  const repository = createLocalRepository(
    database.connection,
    options.id ?? randomUUID,
    options.now ?? Date.now,
  );
  const readFile = options.readFile ?? createFileReader();
  const resources = new ResourceQueue();
  const registrations = new ResourceQueue();
  const clients = new Map<object, LocalReadClient>();

  const result: LocalReadServices = {
    createClient(owner) {
      const existing = clients.get(owner);
      if (existing) return existing;
      let active = true;
      const granted = new Set<string>();
      const denied = () => localFailure('permission-denied', 'Ресурс не выдан этому владельцу');
      const authorized = (id: string) => active && granted.has(id);
      const resource = (id: string): Result<ResourceRecord, PortError> => {
        if (!authorized(id)) return denied();
        const value = repository.get(id);
        return value
          ? { ok: true, value }
          : localFailure('not-found', 'Ресурс отсутствует в реестре');
      };
      async function withResource<T>(
        ref: StorageRef,
        action: (record: ResourceRecord) => Promise<Result<T, PortError>> | Result<T, PortError>,
      ): Promise<Result<T, PortError>> {
        const parsed = refId(ref);
        if (!parsed.ok) return parsed;
        const id = parsed.value; // Примитив захвачен до первого await.
        if (!authorized(id)) return denied();
        try {
          const reply = await resources.run(id, () => {
            const current = resource(id);
            return current.ok ? action(current.value) : current;
          });
          return authorized(id) ? reply : denied();
        } catch (error) {
          return databaseFailure(error);
        }
      }
      const client: LocalReadClient = {
        async registerPath(path, purpose) {
          if (!active) return denied();
          try {
            const reply = await registrations.run<Result<StorageRef, PortError>>(
              'registry',
              async () => {
                if (!active) return denied();
                const registered = await registerLocalPath(repository, path, purpose, () => active);
                if (!registered.ok) return registered;
                if (!active) return denied();
                granted.add(registered.value.resourceId);
                return {
                  ok: true,
                  value: copyFrozen({
                    storageId: 'local',
                    resourceId: registered.value.resourceId,
                  }),
                };
              },
            );
            return active ? reply : denied();
          } catch (error) {
            // Ошибки ФС возвращает registry; исключения здесь — отказ репозитория.
            return databaseFailure(error);
          }
        },
        documents: {
          async load(ref, access) {
            if (access !== null)
              return localFailure('unsupported', 'Локальная аренда не поддерживается');
            return withResource(ref, async (record) => {
              if (repository.hasPending(record.resourceId))
                return localFailure(
                  'busy',
                  'Сначала требуется разрешить незавершённое сохранение',
                  true,
                );
              const read = await readFile(record.canonicalPath, record.hint);
              if (!authorized(record.resourceId)) return denied();
              if (!read.ok) return read;
              repository.recordRead(record.resourceId, read.value);
              return {
                ok: true,
                value: copyFrozen({
                  documentId: record.documentId,
                  format: record.format,
                  ref: { storageId: 'local', resourceId: record.resourceId },
                  snapshot: read.value.snapshot,
                  storageRevision: read.value.storageRevision,
                }),
              };
            });
          },
        },
        history: {
          async list(ref, access) {
            if (access !== null)
              return localFailure('unsupported', 'Локальная аренда не поддерживается');
            return withResource(ref, (record) => ({
              ok: true,
              value: repository.list(record.resourceId),
            }));
          },
          async read(ref, versionId, access) {
            if (access !== null)
              return localFailure('unsupported', 'Локальная аренда не поддерживается');
            if (typeof versionId !== 'string' || !versionId)
              return localFailure('invalid-input', 'Некорректный идентификатор версии');
            return withResource(ref, (record) => {
              const snapshot = repository.read(record.resourceId, versionId);
              return snapshot
                ? { ok: true, value: snapshot }
                : localFailure('not-found', 'Версия не найдена');
            });
          },
        },
        close() {
          if (!active) return;
          active = false;
          granted.clear();
          clients.delete(owner);
        },
      };
      clients.set(owner, client);
      return client;
    },
  };
  services.set(database.connection, result);
  return result;
}
