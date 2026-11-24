import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../support/memory-store';
import { snapshot, value } from '../support/documents';
import type { DraftRecord, SaveRequest } from '../../src/ports';

const request = (operationId = 'save-1'): SaveRequest => ({
  operationId,
  documentId: 'doc',
  format: 'txt',
  target: { ref: { storageId: 'memory', resourceId: 'file' }, expectedRevision: null },
  snapshot: snapshot('A'),
  access: null,
});
const draft = (stateRevision = 1): DraftRecord => ({
  key: { documentId: 'doc', sessionId: 'session' },
  format: 'txt',
  location: null,
  snapshot: snapshot(`текст ${stateRevision}`),
  baseline: snapshot(),
  baseStorageRevision: null,
  stateRevision,
});

describe('контракт хранения в памяти MC-01–MC-05', () => {
  it('не перезаписывает существующий ресурс с null expectedRevision', async () => {
    const { storage, seed } = createMemoryStorage();
    const ref = seed('file', snapshot('original'));
    expect(await storage.documents.save(request())).toMatchObject({ kind: 'conflict' });
    expect(value(await storage.documents.load(ref, null)).snapshot.text).toBe('original');
  });
  it('повтор operationId идемпотентен даже с устаревшим expectedRevision, другой payload запрещён', async () => {
    const { storage } = createMemoryStorage();
    const input = request();
    const first = await storage.documents.save(input),
      repeated = await storage.documents.save(input);
    expect(first).toEqual(repeated);
    expect(first.kind).toBe('saved');
    expect(await storage.documents.save({ ...input, snapshot: snapshot('other') })).toMatchObject({
      kind: 'not-written',
      error: { code: 'invalid-input' },
    });
    expect(value(await storage.history.list(input.target.ref, null))).toHaveLength(1);
    expect(value(await storage.documents.getOperation(input.operationId))).toMatchObject({
      kind: 'settled',
      outcome: first,
    });
    expect(await storage.documents.reconcile(input.operationId)).toEqual(first);
    expect(value(await storage.documents.getOperation('missing'))).toEqual({ kind: 'missing' });
  });
  it('пять последних сохранений, без дубликата no-op; read не меняет ресурс', async () => {
    const { storage } = createMemoryStorage();
    let expectedRevision: string | null = null;
    let oldest = '';
    for (let i = 1; i <= 7; i++) {
      const input = {
        ...request(`save-${i}`),
        target: { ...request().target, expectedRevision },
        snapshot: snapshot(String(i)),
      };
      const saved = await storage.documents.save(input);
      if (saved.kind !== 'saved') throw new Error('fixture');
      expectedRevision = saved.receipt.storageRevision;
      if (i === 1) oldest = saved.receipt.versionId!;
    }
    const ref = request().target.ref,
      versions = value(await storage.history.list(ref, null));
    expect(versions).toHaveLength(5);
    expect(
      await Promise.all(
        versions.map(
          async (version) => value(await storage.history.read(ref, version.id, null)).text,
        ),
      ),
    ).toEqual(['7', '6', '5', '4', '3']);
    expect(await storage.history.read(ref, oldest, null)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    const unchanged = await storage.documents.save({
      ...request('unchanged'),
      target: { ref, expectedRevision },
      snapshot: snapshot('7'),
    });
    expect(unchanged).toMatchObject({
      kind: 'saved',
      receipt: { versionId: null, storageRevision: expectedRevision },
    });
    expect(value(await storage.history.list(ref, null))).toEqual(versions);
    expect(value(await storage.documents.load(ref, null)).snapshot.text).toBe('7');
  });
  it('копирует входной снимок и выдаёт immutable результат', async () => {
    const { storage } = createMemoryStorage();
    const input = {
      ...request(),
      snapshot: { text: 'A', fileMetadata: { encoding: 'utf-8' as const, bom: false } },
    };
    await storage.documents.save(input);
    input.snapshot.text = 'mutated';
    const loaded = value(await storage.documents.load(input.target.ref, null));
    expect(loaded.snapshot.text).toBe('A');
    expect(Object.isFrozen(loaded.snapshot)).toBe(true);
  });
  it('порядок черновиков, идемпотентность полного record и монотонная очистка', async () => {
    const { storage } = createMemoryStorage();
    const store = storage.drafts;
    expect(value(await store.put(draft(2))).accepted).toBe(true);
    expect(value(await store.put(draft(1))).accepted).toBe(false);
    expect(value(await store.put(draft(2))).accepted).toBe(true);
    expect(await store.put({ ...draft(2), baseline: snapshot('other') })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    value(await store.removeThrough(draft().key, 2));
    expect(value(await store.put(draft(2))).accepted).toBe(false);
    value(await store.put(draft(3)));
    value(await store.removeThrough(draft().key, 1));
    expect(value(await store.list())).toEqual([draft(3)]);
    const other = { ...draft(1), key: { ...draft().key, sessionId: 'reopened' } };
    expect(value(await store.put(other)).accepted).toBe(true);
    expect(value(await store.list())).toHaveLength(2);
  });
  it('отклоняет некорректные ревизии, Unicode и чужое хранилище', async () => {
    const { storage } = createMemoryStorage();
    expect(await storage.drafts.put(draft(-1))).toMatchObject({ ok: false });
    expect(await storage.drafts.removeThrough(draft().key, NaN)).toMatchObject({ ok: false });
    expect(
      await storage.documents.save({ ...request(), snapshot: snapshot('\ud800') }),
    ).toMatchObject({ kind: 'not-written' });
    expect(
      await storage.documents.load({ storageId: 'other', resourceId: 'file' }, null),
    ).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });
});
