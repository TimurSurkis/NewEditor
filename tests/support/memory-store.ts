import { copyFrozen, equalSnapshots, validateSnapshot } from '../../src/core';
import type { DocumentFormat, DocumentSnapshot, Result, StorageRef } from '../../src/core';
import type {
  CommitOutcome,
  DraftKey,
  DraftRecord,
  LoadedDocument,
  PortError,
  SaveRequest,
  StorageServices,
  VersionSummary,
} from '../../src/ports';

const ok = <T>(value: T): Result<T, PortError> => ({ ok: true, value });
const failure = (code: PortError['code']): { readonly ok: false; readonly error: PortError } => ({
  ok: false,
  error: { code, message: code, retryable: false },
});
const refKey = (ref: StorageRef) => JSON.stringify([ref.storageId, ref.resourceId]);
const draftKey = (key: DraftKey) => JSON.stringify([key.documentId, key.sessionId]);
const snapshotKey = (snapshot: DocumentSnapshot) => [
  snapshot.text,
  snapshot.fileMetadata.encoding,
  snapshot.fileMetadata.bom,
];
const requestKey = (request: SaveRequest) =>
  JSON.stringify([
    request.operationId,
    request.documentId,
    request.format,
    request.target.ref.storageId,
    request.target.ref.resourceId,
    request.target.expectedRevision,
    snapshotKey(request.snapshot),
    request.access,
  ]);
const recordKey = (record: DraftRecord) =>
  JSON.stringify([
    record.key.documentId,
    record.key.sessionId,
    record.format,
    record.location && refKey(record.location),
    snapshotKey(record.snapshot),
    snapshotKey(record.baseline),
    record.baseStorageRevision,
    record.stateRevision,
  ]);

export function createMemoryStorage() {
  let serial = 0;
  const resources = new Map<string, LoadedDocument>();
  const versions = new Map<string, { summary: VersionSummary; snapshot: DocumentSnapshot }[]>();
  const operations = new Map<string, { request: string; outcome: CommitOutcome }>();
  const drafts = new Map<string, DraftRecord>();
  const cleared = new Map<string, number>();
  const next = () => String(++serial);
  const validRef = (ref: StorageRef) => ref.storageId === 'memory' && ref.resourceId.length > 0;
  const seed = (
    resourceId: string,
    snapshot: DocumentSnapshot,
    documentId = `doc-${resourceId}`,
    format: DocumentFormat = 'txt',
  ): StorageRef => {
    const ref = copyFrozen({ storageId: 'memory', resourceId });
    resources.set(
      refKey(ref),
      copyFrozen({ documentId, ref, format, snapshot, storageRevision: next() }),
    );
    return ref;
  };
  const storage: StorageServices = {
    id: 'memory',
    assets: null,
    events: null,
    access: null,
    documents: {
      async load(ref) {
        const loaded = resources.get(refKey(ref));
        return !validRef(ref) ? failure('unsupported') : loaded ? ok(loaded) : failure('not-found');
      },
      async save(request) {
        if (
          !validRef(request.target.ref) ||
          !request.operationId ||
          validateSnapshot(request.snapshot)
        )
          return { kind: 'not-written', error: failure('invalid-input').error };
        const cached = operations.get(request.operationId),
          fingerprint = requestKey(request);
        if (cached)
          return cached.request === fingerprint
            ? cached.outcome
            : {
                kind: 'not-written',
                error: {
                  code: 'invalid-input',
                  message: 'Другой payload для operationId',
                  retryable: false,
                },
              };
        const resource = refKey(request.target.ref),
          current = resources.get(resource);
        let outcome: CommitOutcome;
        if ((current?.storageRevision ?? null) !== request.target.expectedRevision)
          outcome = { kind: 'conflict', actualRevision: current?.storageRevision ?? null };
        else {
          const changed = !current || !equalSnapshots(current.snapshot, request.snapshot);
          const revision = changed ? next() : current.storageRevision;
          let versionId: string | null = null;
          if (changed) {
            versionId = `version-${next()}`;
            versions.set(
              resource,
              [
                {
                  summary: { id: versionId, savedAt: serial },
                  snapshot: copyFrozen(request.snapshot),
                },
                ...(versions.get(resource) ?? []),
              ].slice(0, 5),
            );
          }
          resources.set(
            resource,
            copyFrozen({
              documentId: request.documentId,
              format: request.format,
              ref: request.target.ref,
              snapshot: request.snapshot,
              storageRevision: revision,
            }),
          );
          outcome = {
            kind: 'saved',
            receipt: {
              operationId: request.operationId,
              documentId: request.documentId,
              format: request.format,
              ref: request.target.ref,
              storageRevision: revision,
              versionId,
            },
          };
        }
        const frozen = copyFrozen(outcome);
        operations.set(request.operationId, { request: fingerprint, outcome: frozen });
        return frozen;
      },
      async getOperation(id) {
        const operation = operations.get(id);
        return ok(
          operation ? { kind: 'settled', outcome: operation.outcome } : { kind: 'missing' },
        );
      },
      async reconcile(id) {
        return (
          operations.get(id)?.outcome ?? {
            kind: 'unknown',
            operationId: id,
            error: { code: 'io-error', message: 'Неизвестная операция', retryable: true },
          }
        );
      },
    },
    history: {
      async list(ref) {
        return !validRef(ref)
          ? failure('unsupported')
          : !resources.has(refKey(ref))
            ? failure('not-found')
            : ok(copyFrozen((versions.get(refKey(ref)) ?? []).map((version) => version.summary)));
      },
      async read(ref, id) {
        if (!validRef(ref)) return failure('unsupported');
        const version = versions.get(refKey(ref))?.find((version) => version.summary.id === id);
        return version ? ok(version.snapshot) : failure('not-found');
      },
    },
    drafts: {
      async put(record) {
        if (
          !record.key.documentId ||
          !record.key.sessionId ||
          !Number.isSafeInteger(record.stateRevision) ||
          record.stateRevision < 0 ||
          validateSnapshot(record.snapshot) ||
          validateSnapshot(record.baseline)
        )
          return failure('invalid-input');
        const key = draftKey(record.key),
          previous = drafts.get(key);
        if (
          record.stateRevision <= (cleared.get(key) ?? -1) ||
          (previous && record.stateRevision < previous.stateRevision)
        )
          return ok({ accepted: false });
        if (previous && record.stateRevision === previous.stateRevision)
          return recordKey(record) === recordKey(previous)
            ? ok({ accepted: true })
            : failure('invalid-input');
        drafts.set(key, copyFrozen(record));
        return ok({ accepted: true });
      },
      async list() {
        return ok(copyFrozen([...drafts.values()]));
      },
      async removeThrough(key, revision) {
        if (!Number.isSafeInteger(revision) || revision < 0) return failure('invalid-input');
        const id = draftKey(key),
          through = Math.max(cleared.get(id) ?? -1, revision);
        cleared.set(id, through);
        if ((drafts.get(id)?.stateRevision ?? Infinity) <= through) drafts.delete(id);
        return ok(undefined);
      },
    },
  };
  return {
    storage,
    seed,
    externalWrite(ref: StorageRef, snapshot: DocumentSnapshot) {
      const previous = resources.get(refKey(ref));
      if (!previous) throw new Error('Нет ресурса');
      resources.set(refKey(ref), copyFrozen({ ...previous, snapshot, storageRevision: next() }));
    },
    remove(ref: StorageRef) {
      resources.delete(refKey(ref));
    },
  };
}
