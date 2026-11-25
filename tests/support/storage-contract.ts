import assert from 'node:assert/strict';
import type { DocumentSnapshot, Result, StorageRef } from '../../src/core';
import type {
  DraftRecord,
  PortError,
  SaveRequest,
  SaveResult,
  StorageServices,
} from '../../src/ports';

export interface StorageFixture {
  readonly storage: StorageServices;
  existing(snapshot: DocumentSnapshot): Promise<StorageRef>;
  absent(): Promise<StorageRef>;
  externalWrite(ref: StorageRef, snapshot: DocumentSnapshot): Promise<void>;
  close(): Promise<void>;
}
export function value<T>(result: Result<T, PortError>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}
export const snapshot = (text = ''): DocumentSnapshot => ({
  text,
  fileMetadata: { encoding: 'utf-8', bom: false },
});
function saved(result: SaveResult) {
  if (result.kind !== 'saved') assert.fail(JSON.stringify(result));
  return result.receipt;
}
function request(
  ref: StorageRef,
  text = '',
  expectedRevision: string | null = null,
  operationId = 'operation',
): SaveRequest {
  return {
    operationId,
    documentId: 'document',
    format: 'txt',
    target: { ref, expectedRevision },
    snapshot: snapshot(text),
    access: null,
  };
}
function draft(stateRevision = 1): DraftRecord {
  return {
    key: { documentId: 'document', sessionId: 'session' },
    format: 'txt',
    location: null,
    snapshot: snapshot('working😀\0'),
    baseline: snapshot('baseline'),
    baseStorageRevision: null,
    stateRevision,
  };
}

export const storageCases: readonly {
  readonly name: string;
  readonly run: (f: StorageFixture) => Promise<void>;
}[] = [
  {
    name: 'новый пустой документ создаётся с исходной ревизией null',
    async run(f) {
      const ref = await f.absent(),
        receipt = saved(await f.storage.documents.save(request(ref)));
      const loaded = value(await f.storage.documents.load(ref, null));
      assert.deepEqual(loaded.snapshot, snapshot());
      assert.equal(loaded.documentId, 'document');
      assert.equal(loaded.storageRevision, receipt.storageRevision);
      assert.equal(value(await f.storage.history.list(ref, null)).length, 1);
    },
  },
  {
    name: 'load/save сохраняют точный Unicode, BOM и смешанные переводы строк',
    async run(f) {
      const initial = snapshot('😀Б\r\nе\u0308\r\tlast\n'),
        ref = await f.existing(initial);
      const loaded = value(await f.storage.documents.load(ref, null));
      assert.deepEqual(loaded.snapshot, initial);
      const next = {
        text: '\uFEFFcontent\r',
        fileMetadata: { encoding: 'utf-8' as const, bom: true },
      };
      const input = {
        ...request(ref, '', loaded.storageRevision),
        documentId: loaded.documentId,
        snapshot: next,
      };
      const receipt = saved(await f.storage.documents.save(input));
      assert.deepEqual(value(await f.storage.documents.load(ref, null)).snapshot, next);
      assert.notEqual(receipt.storageRevision, loaded.storageRevision);
    },
  },
  {
    name: 'null и устаревшая ревизия не перезаписывают чужое состояние',
    async run(f) {
      const ref = await f.existing(snapshot('old')),
        old = value(await f.storage.documents.load(ref, null));
      const nullResult = await f.storage.documents.save(request(ref));
      assert.equal(nullResult.kind, 'conflict');
      await f.externalWrite(ref, snapshot('external'));
      const stale = await f.storage.documents.save(
        request(ref, 'ours', old.storageRevision, 'stale'),
      );
      assert.equal(stale.kind, 'conflict');
      assert.equal(value(await f.storage.documents.load(ref, null)).snapshot.text, 'external');
    },
  },
  {
    name: 'повтор operationId идемпотентен даже после внешнего изменения',
    async run(f) {
      const ref = await f.absent(),
        input = request(ref, 'ours');
      const first = await f.storage.documents.save(input);
      saved(first);
      await f.externalWrite(ref, snapshot('external'));
      assert.deepEqual(await f.storage.documents.save(input), first);
      assert.deepEqual(value(await f.storage.documents.getOperation('operation')), {
        kind: 'settled',
        outcome: first,
      });
      assert.deepEqual(await f.storage.documents.reconcile('operation'), first);
      assert.equal(value(await f.storage.documents.load(ref, null)).snapshot.text, 'external');
    },
  },
  {
    name: 'старый operationId с другим payload отклоняется без изменения исхода',
    async run(f) {
      const ref = await f.absent(),
        input = request(ref, 'first');
      const first = await f.storage.documents.save(input);
      saved(first);
      const bad = await f.storage.documents.save({ ...input, snapshot: snapshot('different') });
      assert.equal(bad.kind, 'not-written');
      if (bad.kind === 'not-written') assert.equal(bad.error.code, 'invalid-input');
      assert.deepEqual(await f.storage.documents.save(input), first);
      assert.equal(value(await f.storage.documents.load(ref, null)).snapshot.text, 'first');
    },
  },
  {
    name: 'no-op не создаёт версию и не меняет ревизию',
    async run(f) {
      const ref = await f.absent(),
        input = request(ref, 'A');
      const first = saved(await f.storage.documents.save(input)),
        history = value(await f.storage.history.list(ref, null));
      const next = saved(
        await f.storage.documents.save({
          ...input,
          operationId: 'noop',
          target: { ref, expectedRevision: first.storageRevision },
        }),
      );
      assert.equal(next.storageRevision, first.storageRevision);
      assert.equal(next.versionId, null);
      assert.deepEqual(value(await f.storage.history.list(ref, null)), history);
    },
  },
  {
    name: 'пять состояний включают последнее, A → B → A не дедуплицируется глобально',
    async run(f) {
      const ref = await f.absent();
      let revision: string | null = null;
      for (const [i, text] of ['A', 'B', 'A', 'D', 'E', 'F', 'G'].entries())
        revision = saved(
          await f.storage.documents.save(request(ref, text, revision, `save-${i}`)),
        ).storageRevision;
      const versions = value(await f.storage.history.list(ref, null));
      assert.equal(versions.length, 5);
      const states = await Promise.all(
        versions.map(
          async (version) => value(await f.storage.history.read(ref, version.id, null)).text,
        ),
      );
      assert.deepEqual(states, ['G', 'F', 'E', 'D', 'A']);
    },
  },
  {
    name: 'Save As сохраняет DocumentId и не меняет старый ресурс/историю',
    async run(f) {
      const old = await f.absent();
      saved(await f.storage.documents.save(request(old, 'old')));
      const oldLoaded = value(await f.storage.documents.load(old, null)),
        history = value(await f.storage.history.list(old, null));
      const next = await f.absent();
      saved(
        await f.storage.documents.save({
          ...request(next, 'copy', null, 'copy'),
          documentId: oldLoaded.documentId,
        }),
      );
      assert.equal(
        value(await f.storage.documents.load(next, null)).documentId,
        oldLoaded.documentId,
      );
      assert.deepEqual(value(await f.storage.documents.load(old, null)), oldLoaded);
      assert.deepEqual(value(await f.storage.history.list(old, null)), history);
    },
  },
  {
    name: 'черновики монотонны и равная ревизия сравнивает полный record',
    async run(f) {
      value(await f.storage.drafts.put(draft(4)));
      assert.deepEqual(value(await f.storage.drafts.put(draft(3))), { accepted: false });
      assert.deepEqual(value(await f.storage.drafts.put(draft(4))), { accepted: true });
      const different = await f.storage.drafts.put({ ...draft(4), baseline: snapshot('other') });
      assert.equal(different.ok, false);
      if (!different.ok) assert.equal(different.error.code, 'invalid-input');
      assert.deepEqual(value(await f.storage.drafts.list()), [draft(4)]);
    },
  },
  {
    name: 'Save As поверх одинакового снимка меняет идентичность и защищающую её ревизию',
    async run(f) {
      const source = await f.absent();
      saved(await f.storage.documents.save(request(source, 'same')));
      const sourceLoaded = value(await f.storage.documents.load(source, null));
      const target = await f.existing(snapshot('same'));
      const before = value(await f.storage.documents.load(target, null));
      assert.notEqual(before.documentId, sourceLoaded.documentId);
      const receipt = saved(
        await f.storage.documents.save(request(target, 'same', before.storageRevision, 'save-as')),
      );
      const after = value(await f.storage.documents.load(target, null));
      assert.equal(after.documentId, sourceLoaded.documentId);
      assert.notEqual(receipt.storageRevision, before.storageRevision);
      assert.deepEqual(after.snapshot, before.snapshot);
      assert.deepEqual(value(await f.storage.documents.load(source, null)), sourceLoaded);
      assert.equal(
        (await f.storage.documents.save(request(target, 'stale', before.storageRevision, 'stale')))
          .kind,
        'conflict',
      );
    },
  },
  {
    name: 'clearance не воскрешает старый put и не удаляет новый/чужую сессию',
    async run(f) {
      value(await f.storage.drafts.put(draft(5)));
      value(await f.storage.drafts.removeThrough(draft().key, 3));
      assert.deepEqual(value(await f.storage.drafts.list()), [draft(5)]);
      const other = { ...draft(1), key: { ...draft().key, sessionId: 'other' } };
      value(await f.storage.drafts.put(other));
      value(await f.storage.drafts.removeThrough(draft().key, 5));
      value(await f.storage.drafts.removeThrough(draft().key, 1));
      assert.deepEqual(value(await f.storage.drafts.put(draft(4))), { accepted: false });
      assert.deepEqual(value(await f.storage.drafts.list()), [other]);
    },
  },
  {
    name: 'вход и возвращаемый снимок не разделяют изменяемые объекты',
    async run(f) {
      const ref = await f.absent(),
        input = request(ref, 'immutable');
      saved(await f.storage.documents.save(input));
      Object.assign(input.snapshot, { text: 'mutated' });
      const loaded = value(await f.storage.documents.load(ref, null));
      assert.equal(loaded.snapshot.text, 'immutable');
      assert.ok(Object.isFrozen(loaded.snapshot.fileMetadata));
      const record = draft();
      value(await f.storage.drafts.put(record));
      Object.assign(record.snapshot, { text: 'mutated' });
      assert.deepEqual(value(await f.storage.drafts.list()), [draft()]);
    },
  },
];
