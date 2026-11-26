import { randomUUID } from 'node:crypto';
import { copyFrozen } from '../../../../core';
import type { Result, StorageRef } from '../../../../core';
import type {
  DraftKey,
  DraftRecord,
  PortError,
  ResourceEvents,
  SaveResult,
  StorageServices,
} from '../../../../ports';
import type { ServiceDatabase } from '../database';
import { createFileProbe, createFileReader } from './file-reader';
import { localFailure } from './errors';
import { createLocalRepository } from './repository';
import type { ResourceRecord } from './repository';
import { registerLocalPath } from './path-registry';
import type { RegistrationPurpose } from './path-registry';
import { ResourceQueue } from './queue';
import { createFileWriter } from './file-writer';
import type { FileWriteIO } from './file-writer';
import { createSaveJournal } from './save-journal';
import { createSaveEngine } from './save-engine';
import { parseSaveRequest } from './save-data';
import { createDraftRepository } from './draft-repository';
import { draftKey, draftRevision, parseDraftKey, parseDraftRecord } from './draft-data';
import { createResourceObserver, createWatchSignals } from './resource-observer';
import type { WatchSignals } from './resource-observer';

export interface LocalClient extends StorageServices {
  registerPath(path: string, purpose: RegistrationPurpose): Promise<Result<StorageRef, PortError>>;
  describeResource(ref: StorageRef): Promise<Result<{ readonly path: string }, PortError>>;
  readonly events: ResourceEvents;
  recoverDraft(key: DraftKey): Promise<Result<void, PortError>>;
  refreshResources(): Promise<void>;
  close(): void;
}

export interface LocalServices {
  readonly ready: Promise<Result<readonly SaveResult[], PortError>>;
  createClient(owner: object): LocalClient;
  listRecoverableDrafts(): Promise<Result<readonly DraftRecord[], PortError>>;
  close(): void;
}

export interface LocalOptions {
  readonly id?: () => string;
  readonly now?: () => number;
  readonly readFile?: ReturnType<typeof createFileReader>;
  readonly fileIO?: FileWriteIO;
  readonly probeFile?: ReturnType<typeof createFileProbe>;
  readonly signals?: WatchSignals;
}

const services = new WeakMap<ServiceDatabase['connection'], LocalServices>();

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

export function createLocalServices(
  database: ServiceDatabase,
  options: LocalOptions = {},
): LocalServices {
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
  const writes = new ResourceQueue();
  const journal = createSaveJournal(database.connection, repository, options.now ?? Date.now);
  const draftRepository = createDraftRepository(database.connection);
  const probeFile = options.probeFile ?? createFileProbe();
  const draftOwners = new Map<string, object>();
  const operationOwners = new Map<string, { owner: object; resourceId: string }>();
  const acknowledgers = new Map<object, (id: string, revision: string) => void>();
  const observer = createResourceObserver({
    signals: options.signals ?? createWatchSignals(),
    run: (id, action) => resources.run(id, action),
    async probe(id) {
      const record = repository.get(id);
      if (!record) return localFailure('not-found', 'Ресурс отсутствует в реестре');
      const raw = await probeFile(record.canonicalPath);
      if (!raw.ok)
        return raw.error.code === 'not-found'
          ? { ok: true, value: { revision: null, contentHash: null } }
          : raw;
      return {
        ok: true,
        value: { revision: raw.value.storageRevision, contentHash: raw.value.contentHash },
      };
    },
    deliver(id, owner, previous, observed) {
      const pending = journal.pendingFor(id);
      return !(
        pending?.phase === 'replacing' &&
        operationOwners.get(pending.request.operationId)?.owner === owner &&
        previous === pending.oldRevision &&
        observed.contentHash === pending.newHash
      );
    },
  });
  function sweepOperations(id: string) {
    for (const [operationId, origin] of operationOwners)
      if (origin.resourceId === id) {
        try {
          const operation = journal.get(operationId);
          if (!operation || operation.phase === 'settled') operationOwners.delete(operationId);
        } catch {
          /* Непроверяемый исход не считаем завершённым. */
        }
      }
  }
  const engine = createSaveEngine(
    repository,
    journal,
    readFile,
    options.fileIO ?? createFileWriter(),
    (receipt) => {
      const origin = operationOwners.get(receipt.operationId);
      if (origin)
        acknowledgers.get(origin.owner)?.(receipt.ref.resourceId, receipt.storageRevision);
    },
  );
  const ready: LocalServices['ready'] = Promise.resolve().then(async () => {
    try {
      const outcomes: SaveResult[] = [];
      for (const operation of journal.pending()) {
        outcomes.push(
          await resources.run(operation.request.target.ref.resourceId, () =>
            writes.run('filesystem', () => engine.reconcile(operation)),
          ),
        );
      }
      return { ok: true as const, value: outcomes };
    } catch (error) {
      return databaseFailure(error);
    }
  });
  const clients = new Map<object, LocalClient>();
  let closed = false;

  const result: LocalServices = {
    ready,
    async listRecoverableDrafts() {
      const initialized = await ready;
      if (!initialized.ok) return initialized;
      if (closed) return localFailure('permission-denied', 'Локальное хранилище закрыто');
      try {
        return {
          ok: true,
          value: copyFrozen(
            draftRepository.list().filter((record) => !draftOwners.has(draftKey(record.key))),
          ),
        };
      } catch (error) {
        return databaseFailure(error);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const client of [...clients.values()]) client.close();
      observer.close();
    },
    createClient(owner) {
      if (closed) throw new Error('Локальное хранилище закрыто');
      const existing = clients.get(owner);
      if (existing) return existing;
      let active = true;
      const granted = new Set<string>();
      const draftGrants = new Map<string, { key: DraftKey; location: StorageRef | null }>();
      const knownRevisions = new Map<string, string>();
      const watchStops = new Set<() => void>();
      const denied = () => localFailure('permission-denied', 'Ресурс не выдан этому владельцу');
      const authorized = (id: string) => active && granted.has(id);
      const acknowledge = (id: string, revision: string) => {
        if (active) {
          knownRevisions.set(id, revision);
          observer.acknowledge(owner, id, revision);
        }
      };
      acknowledgers.set(owner, acknowledge);
      const claimDraft = (key: DraftKey): Result<void, PortError> => {
        if (!active) return denied();
        const serialized = draftKey(key);
        if (draftGrants.has(serialized)) return { ok: true, value: undefined };
        if (draftOwners.has(serialized) || draftRepository.exists(key))
          return localFailure(
            'permission-denied',
            'Черновик не выдан этому владельцу; требуется восстановление',
          );
        draftOwners.set(serialized, owner);
        draftGrants.set(serialized, { key, location: null });
        return { ok: true, value: undefined };
      };
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
          const initialized = await ready;
          if (!initialized.ok) return initialized;
          const reply = await resources.run(id, () => {
            const current = resource(id);
            return current.ok ? action(current.value) : current;
          });
          return authorized(id) ? reply : denied();
        } catch (error) {
          return databaseFailure(error);
        }
      }
      const client: LocalClient = {
        describeResource(ref) {
          return withResource(ref, (record) => ({
            ok: true,
            value: { path: record.canonicalPath },
          }));
        },
        id: 'local',
        assets: null,
        access: null,
        async recoverDraft(input) {
          let key: DraftKey;
          try {
            key = parseDraftKey(input);
          } catch {
            return localFailure('invalid-input', 'Некорректный ключ черновика');
          }
          const initialized = await ready;
          if (!initialized.ok) return initialized;
          if (!active) return denied();
          try {
            const serialized = draftKey(key),
              holder = draftOwners.get(serialized);
            if (holder && holder !== owner)
              return localFailure('busy', 'Черновик используется другой сессией');
            const record = draftRepository.read(key);
            if (!record) return localFailure('not-found', 'Черновик не найден');
            draftOwners.set(serialized, owner);
            draftGrants.set(serialized, { key, location: record.location });
            return { ok: true, value: undefined };
          } catch (error) {
            return databaseFailure(error);
          }
        },
        async refreshResources() {
          await ready;
          if (active) await observer.refresh(owner);
        },
        drafts: {
          async put(input) {
            const parsed = parseDraftRecord(input);
            if (!parsed.ok) return parsed;
            const draft = parsed.value;
            const initialized = await ready;
            if (!initialized.ok) return initialized;
            if (!active) return denied();
            try {
              const inherited = draftGrants.get(draftKey(draft.key))?.location;
              if (
                draft.location &&
                !authorized(draft.location.resourceId) &&
                !(
                  inherited &&
                  inherited.resourceId === draft.location.resourceId &&
                  inherited.storageId === draft.location.storageId
                )
              )
                return denied();
              const claimed = claimDraft(draft.key);
              if (!claimed.ok) return claimed;
              const result = draftRepository.put(draft);
              if (result.ok && result.value.accepted)
                draftGrants.set(draftKey(draft.key), { key: draft.key, location: draft.location });
              return result;
            } catch (error) {
              return databaseFailure(error);
            }
          },
          async list() {
            const initialized = await ready;
            if (!initialized.ok) return initialized;
            if (!active) return denied();
            try {
              const records: DraftRecord[] = [];
              for (const grant of draftGrants.values()) {
                const record = draftRepository.read(grant.key);
                if (record) records.push(record);
              }
              return { ok: true, value: copyFrozen(records) };
            } catch (error) {
              return databaseFailure(error);
            }
          },
          async removeThrough(input, revision) {
            let key: DraftKey, through: number;
            try {
              key = parseDraftKey(input);
              through = draftRevision(revision);
            } catch {
              return localFailure('invalid-input', 'Некорректная граница очистки черновика');
            }
            const initialized = await ready;
            if (!initialized.ok) return initialized;
            if (!active) return denied();
            try {
              const claimed = claimDraft(key);
              if (!claimed.ok) return claimed;
              draftRepository.removeThrough(key, through);
              return { ok: true, value: undefined };
            } catch (error) {
              return databaseFailure(error);
            }
          },
        },
        events: {
          watch(ref, listener, onError) {
            let live = true,
              inner: (() => void) | null = null;
            let parsed: Result<string, PortError>;
            try {
              parsed = refId(ref);
            } catch {
              parsed = localFailure('invalid-input', 'Некорректная ссылка на ресурс');
            }
            const stop = () => {
              if (!live) return;
              live = false;
              inner?.();
              watchStops.delete(stop);
            };
            const notify = (error: PortError) => {
              if (live && active) {
                try {
                  onError(error);
                } catch {
                  /* Изоляция получателя. */
                }
              }
            };
            watchStops.add(stop);
            void ready
              .then((initialized) => {
                if (!live || !active) return;
                if (!initialized.ok) {
                  notify(initialized.error);
                  return;
                }
                if (!parsed.ok) {
                  notify(parsed.error);
                  return;
                }
                const record = resource(parsed.value);
                if (!record.ok) {
                  notify(record.error);
                  return;
                }
                inner = observer.watch(
                  parsed.value,
                  record.value.canonicalPath,
                  owner,
                  knownRevisions.get(parsed.value),
                  (event) => {
                    if (live && active) listener(event);
                  },
                  notify,
                );
              })
              .catch((error) => notify(databaseFailure(error).error));
            return stop;
          },
        },
        async registerPath(path, purpose) {
          if (!active) return denied();
          try {
            const initialized = await ready;
            if (!initialized.ok) return initialized;
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
          async save(input) {
            const parsed = parseSaveRequest(input);
            if (!parsed.ok) return { kind: 'not-written', error: parsed.error };
            const request = parsed.value;
            if (!authorized(request.target.ref.resourceId))
              return { kind: 'not-written', error: denied().error };
            try {
              const initialized = await ready;
              if (!initialized.ok) return { kind: 'not-written', error: initialized.error };
              return await resources.run(request.target.ref.resourceId, () =>
                writes.run('filesystem', async () => {
                  if (!authorized(request.target.ref.resourceId))
                    return { kind: 'not-written' as const, error: denied().error };
                  const result = await engine.save(request, () => {
                    if (!authorized(request.target.ref.resourceId)) return false;
                    operationOwners.set(request.operationId, {
                      owner,
                      resourceId: request.target.ref.resourceId,
                    });
                    return true;
                  });
                  sweepOperations(request.target.ref.resourceId);
                  return result;
                }),
              );
            } catch (error) {
              return {
                kind: 'unknown',
                operationId: request.operationId,
                error: databaseFailure(error).error,
              };
            }
          },
          async getOperation(id) {
            if (typeof id !== 'string' || !id)
              return localFailure('invalid-input', 'Некорректный идентификатор операции');
            const initialized = await ready;
            if (!initialized.ok) return initialized;
            if (!active) return denied();
            try {
              const operation = journal.get(id);
              if (!operation) return { ok: true, value: { kind: 'missing' } };
              if (!authorized(operation.request.target.ref.resourceId)) return denied();
              if (operation.phase === 'settled')
                return { ok: true, value: { kind: 'settled', outcome: operation.outcome! } };
              if (operation.phase === 'file-written')
                return {
                  ok: true,
                  value: {
                    kind: 'settled',
                    outcome: {
                      kind: 'history-pending',
                      receipt: operation.receipt!,
                      error: localFailure('io-error', 'История ожидает восстановления', true).error,
                    },
                  },
                };
              return { ok: true, value: { kind: 'pending' } };
            } catch (error) {
              return databaseFailure(error);
            }
          },
          async reconcile(id) {
            const unknown = (error: PortError): SaveResult => ({
              kind: 'unknown',
              operationId: typeof id === 'string' ? id : '',
              error,
            });
            if (typeof id !== 'string' || !id)
              return unknown(
                localFailure('invalid-input', 'Некорректный идентификатор операции').error,
              );
            try {
              const initialized = await ready;
              if (!initialized.ok) return unknown(initialized.error);
              const operation = journal.get(id);
              if (!operation)
                return unknown(localFailure('not-found', 'Операция не найдена').error);
              const resourceId = operation.request.target.ref.resourceId;
              if (!authorized(resourceId)) return unknown(denied().error);
              return await resources.run(resourceId, () =>
                writes.run('filesystem', async () => {
                  if (!authorized(resourceId)) return unknown(denied().error);
                  const result = await engine.reconcile(journal.get(id)!);
                  sweepOperations(resourceId);
                  return result;
                }),
              );
            } catch (error) {
              return unknown(databaseFailure(error).error);
            }
          },
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
              acknowledge(record.resourceId, read.value.storageRevision);
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
          for (const stop of [...watchStops]) stop();
          for (const key of draftGrants.keys())
            if (draftOwners.get(key) === owner) draftOwners.delete(key);
          for (const [id, origin] of operationOwners)
            if (origin.owner === owner) operationOwners.delete(id);
          draftGrants.clear();
          knownRevisions.clear();
          acknowledgers.delete(owner);
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
