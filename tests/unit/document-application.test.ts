import { describe, expect, it, vi } from 'vitest';
import { createDocumentApplication } from '../../src/application';
import type { DocumentApplication } from '../../src/application';
import type { LoadedDocument, PortError, SaveRequest, SaveResult } from '../../src/ports';
import type { Result } from '../../src/core';
import { deferred, selection, setup, snapshot, transaction, value } from '../support/documents';

const target = (name = 'new') => ({
  ref: { storageId: 'memory', resourceId: name },
  expectedRevision: null,
});
const ioError: PortError = { code: 'io-error', message: 'сбой', retryable: true };
function append(app: DocumentApplication, id: string, text: string, group: string | null = null) {
  const edit = app.getSnapshot(id)!.edit,
    at = edit.document.text.length;
  return value(
    app.apply(
      id,
      transaction(
        edit,
        { changes: [{ from: at, to: at, insert: text }] },
        selection(at),
        selection(at + text.length),
        group,
      ),
    ),
  );
}

describe('сессии и общая история DM-01–DM-07', () => {
  it('открывает точный исходник чистым; параллельный и повторный open не дублируются', async () => {
    const { app, seed, storage } = setup();
    const ref = seed('file', snapshot('_текст_\r\n'));
    const load = vi.spyOn(storage.documents, 'load');
    const [a, b] = await Promise.all([app.open(ref), app.open(ref)]);
    expect(value(a)).toBe(value(b));
    expect(load).toHaveBeenCalledTimes(1);
    expect(value(await app.open(ref))).toBe(value(a));
    expect(load).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot(value(a))).toMatchObject({
      isDirty: false,
      edit: { document: { text: '_текст_\r\n' } },
    });
  });
  it('новый пустой документ сохраняется без dirty; отсутствие цели — отдельный результат', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    expect(app.getSnapshot(id)?.isDirty).toBe(false);
    expect(await app.save(id)).toMatchObject({
      kind: 'not-written',
      error: { code: 'target-required' },
    });
    expect(await app.save(id, target())).toMatchObject({ kind: 'saved' });
    expect(value(await storage.documents.load(target().ref, null)).snapshot.text).toBe('');
    expect(app.getSnapshot(id)?.edit.document.location).toEqual(target().ref);
  });
  it('undo до baseline снимает dirty, сохранение не очищает undo', async () => {
    const { app } = setup();
    const id = app.create('markdown');
    append(app, id, 'A');
    await app.save(id, target());
    append(app, id, 'B');
    expect(value(app.undo(id)).view.isDirty).toBe(false);
    expect(value(app.undo(id)).view.edit.document.text).toBe('');
    expect(app.getSnapshot(id)?.isDirty).toBe(true);
    value(app.redo(id));
    expect(app.getSnapshot(id)?.isDirty).toBe(false);
  });
  it('metadata-only правка сохраняется и отменяется отдельно от текста', () => {
    const { app } = setup();
    const id = app.create('txt'),
      edit = app.getSnapshot(id)!.edit;
    const changed = value(
      app.apply(
        id,
        transaction(edit, { changes: [], fileMetadata: { encoding: 'windows-1251', bom: false } }),
      ),
    );
    expect(changed.view).toMatchObject({
      isDirty: true,
      edit: { stateRevision: 1, document: { sourceRevision: 0 } },
    });
    expect(value(app.undo(id)).view.isDirty).toBe(false);
  });
  it('снимки стабильны, глубоко frozen, подписка и отписка идемпотентны', () => {
    const { app } = setup();
    const id = app.create('txt'),
      initial = app.getSnapshot(id)!;
    const listener = vi.fn();
    const stop = app.subscribe(id, listener);
    value(app.apply(id, transaction(initial.edit, { changes: [] })));
    expect(app.getSnapshot(id)).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(Object.isFrozen(initial.baseline.fileMetadata)).toBe(true);
    append(app, id, 'x');
    expect(listener).toHaveBeenCalledTimes(1);
    const current = app.getSnapshot(id)!;
    expect(app.apply(id, transaction(initial.edit, { changes: [] }))).toMatchObject({
      ok: false,
      error: { code: 'stale-revision' },
    });
    expect(app.getSnapshot(id)).toBe(current);
    stop();
    stop();
    append(app, id, 'y');
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('группирует смежный ввод до 500 мс, но не после паузы/смены режима/курсора', () => {
    const { app, tick } = setup();
    const id = app.create('txt');
    append(app, id, 'a', 'typing');
    tick(500);
    append(app, id, 'b', 'typing');
    tick(501);
    append(app, id, 'c', 'typing');
    value(app.undo(id));
    expect(app.getSnapshot(id)?.edit.document.text).toBe('ab');
    value(app.undo(id));
    expect(app.getSnapshot(id)?.edit.document.text).toBe('');
    value(app.redo(id));
    value(app.redo(id));
    app.breakUndoGroup(id);
    append(app, id, 'd', 'typing');
    value(app.setSelection(id, selection(0)));
    value(app.setSelection(id, selection(4)));
    append(app, id, 'e', 'typing');
    value(app.undo(id));
    expect(app.getSnapshot(id)?.edit.document.text).toBe('abcd');
  });
  it('IME одной транзакцией — одна группа; no-op и ошибки не уничтожают redo', () => {
    const { app } = setup();
    const id = app.create('txt');
    append(app, id, '日本語😀');
    value(app.undo(id));
    const edit = app.getSnapshot(id)!.edit;
    value(app.apply(id, transaction(edit, { changes: [] })));
    app.apply(id, transaction(edit, { changes: [{ from: -1, to: 0, insert: 'x' }] }));
    expect(value(app.redo(id)).view.edit.document.text).toBe('日本語😀');
  });
  it('ошибка слушателя не превращает подтверждённое сохранение в unknown', async () => {
    const onError = vi.fn(),
      { app } = setup({ onError });
    const id = app.create('txt');
    app.subscribe(id, () => {
      throw new Error('listener');
    });
    append(app, id, 'x');
    expect(await app.save(id, target())).toMatchObject({ kind: 'saved' });
    expect(onError).toHaveBeenCalled();
  });
  it('неизвестная сессия и неподходящий адаптер дают данные ошибки', async () => {
    const { app, storage } = setup();
    expect(app.undo('missing')).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await app.open({ storageId: 'other', resourceId: 'file' })).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    const cloud = createDocumentApplication({
      storage: { ...storage, access: { acquire: vi.fn(), renew: vi.fn(), release: vi.fn() } },
      now: () => 0,
      newId: () => 'id',
    });
    expect(await cloud.open(target().ref)).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
  });
});

describe('сохранение и конкурентные операции DM-08–DM-11', () => {
  it('обновляет expectedRevision собственной записи у повторной явно указанной цели', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    const original = storage.documents.save,
      gate = deferred<void>();
    const spy = vi.spyOn(storage.documents, 'save').mockImplementation(async (request) => {
      await gate.promise;
      return original(request);
    });
    const first = app.save(id, target());
    append(app, id, 'B');
    const next = app.save(id, target());
    gate.resolve();
    expect(await first).toMatchObject({ kind: 'saved' });
    expect(await next).toMatchObject({ kind: 'saved' });
    expect(spy.mock.calls[1]?.[0].target.expectedRevision).not.toBeNull();
    expect(app.getSnapshot(id)?.baseline.text).toBe('AB');
  });
  it('последняя явная цель следующего намерения побеждает, обычный save её не стирает', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    const original = storage.documents.save,
      gate = deferred<void>();
    vi.spyOn(storage.documents, 'save').mockImplementation(async (request) => {
      await gate.promise;
      return original(request);
    });
    const first = app.save(id, target('first')),
      next = app.save(id, target('second'));
    expect(app.save(id, target('third'))).toBe(next);
    expect(app.save(id)).toBe(next);
    gate.resolve();
    await first;
    await next;
    expect(app.getSnapshot(id)?.edit.document.location).toEqual(target('third').ref);
    expect(await storage.documents.load(target('second').ref, null)).toMatchObject({ ok: false });
  });
  it('конфликт альтернативной цели не помечает исходный документ внешне изменённым', async () => {
    const { app, seed } = setup();
    const ref = seed('source', snapshot('A'));
    seed('occupied', snapshot('другой документ'));
    const id = value(await app.open(ref));
    append(app, id, 'B');
    expect(await app.save(id, target('occupied'))).toMatchObject({ kind: 'conflict' });
    expect(app.getSnapshot(id)?.conflict.kind).toBe('none');
    expect(await app.save(id)).toMatchObject({ kind: 'saved' });
  });
  it('pending в журнале запускает reconcile той же операции; ошибки выяснения оставляют unknown', async () => {
    const { app, storage } = setup();
    const id = app.create('txt'),
      save = storage.documents.save;
    vi.spyOn(storage.documents, 'save').mockImplementation(async (request) => {
      await save(request);
      return { kind: 'unknown', operationId: request.operationId, error: ioError };
    });
    await app.save(id, target());
    const status = vi
      .spyOn(storage.documents, 'getOperation')
      .mockResolvedValueOnce({ ok: false, error: ioError })
      .mockResolvedValueOnce({ ok: true, value: { kind: 'pending' } });
    expect(await app.reconcileSave(id)).toMatchObject({ kind: 'unknown' });
    const reconcile = vi.spyOn(storage.documents, 'reconcile');
    expect(await app.reconcileSave(id)).toMatchObject({ kind: 'saved' });
    expect(status).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledWith(status.mock.calls[0]?.[0]);
  });
  it('подтверждает A, не заменяя более новый B; очищает только черновик A', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    const originalSave = storage.documents.save,
      gate = deferred<void>();
    vi.spyOn(storage.documents, 'save').mockImplementation(async (request) => {
      await gate.promise;
      return originalSave(request);
    });
    const saving = app.save(id, target());
    append(app, id, 'B');
    await app.flushDraft(id);
    gate.resolve();
    expect(await saving).toMatchObject({ kind: 'saved' });
    expect(app.getSnapshot(id)).toMatchObject({
      baseline: { text: 'A' },
      isDirty: true,
      edit: { document: { text: 'AB' } },
    });
    expect(value(await storage.drafts.list())).toMatchObject([
      { snapshot: { text: 'AB' }, stateRevision: 2 },
    ]);
    expect(value(await storage.documents.load(target().ref, null)).snapshot.text).toBe('A');
  });
  it('не теряет смену encoding во время сохранения и повторяет тот же draft record', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    const originalSave = storage.documents.save,
      gate = deferred<void>();
    vi.spyOn(storage.documents, 'save').mockImplementation(async (request) => {
      await gate.promise;
      return originalSave(request);
    });
    const saving = app.save(id, target());
    const edit = app.getSnapshot(id)!.edit;
    value(
      app.apply(
        id,
        transaction(edit, { changes: [], fileMetadata: { encoding: 'windows-1251', bom: false } }),
      ),
    );
    await app.flushDraft(id);
    const record = value(await storage.drafts.list())[0];
    gate.resolve();
    await saving;
    await app.flushDraft(id);
    expect(value(await storage.drafts.list())[0]).toEqual(record);
    expect(app.getSnapshot(id)).toMatchObject({
      isDirty: true,
      edit: {
        stateRevision: 1,
        document: { sourceRevision: 0, fileMetadata: { encoding: 'windows-1251' } },
      },
    });
  });
  it('объединяет следующие save; снимок следующего запроса создаётся при старте', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    const save = storage.documents.save,
      gate = deferred<void>(),
      requests: SaveRequest[] = [];
    vi.spyOn(storage.documents, 'save').mockImplementation(async (request) => {
      requests.push(request);
      if (requests.length === 1) await gate.promise;
      return save(request);
    });
    const first = app.save(id, target());
    append(app, id, 'B');
    const second = app.save(id),
      third = app.save(id);
    append(app, id, 'C');
    expect(second).toBe(third);
    expect(requests).toHaveLength(1);
    gate.resolve();
    await first;
    await second;
    expect(requests.map((r) => r.snapshot.text)).toEqual(['A', 'ABC']);
    expect(requests[1]?.target.expectedRevision).not.toBeNull();
    expect(app.getSnapshot(id)?.isDirty).toBe(false);
    expect(value(await storage.history.list(target().ref, null))).toHaveLength(2);
  });
  it('ошибка записи сохраняет baseline/undo/dirty, ожидающие не повторяют запрос автоматически', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    const gate = deferred<SaveResult>();
    const save = vi.spyOn(storage.documents, 'save').mockImplementation(() => gate.promise);
    const first = app.save(id, target()),
      next = app.save(id);
    gate.resolve({ kind: 'not-written', error: ioError });
    expect(await first).toEqual(await next);
    expect(save).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot(id)).toMatchObject({
      baseline: { text: '' },
      isDirty: true,
      canUndo: true,
      save: { kind: 'failed' },
    });
  });
  it('потеря ответа выясняется по тому же operationId без второй версии', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    const save = storage.documents.save;
    const spy = vi.spyOn(storage.documents, 'save').mockImplementation(async (request) => {
      await save(request);
      return { kind: 'unknown', operationId: request.operationId, error: ioError };
    });
    expect(await app.save(id, target())).toMatchObject({ kind: 'unknown' });
    expect(app.getSnapshot(id)?.baseline.text).toBe('');
    expect(await app.reconcileSave(id)).toMatchObject({ kind: 'saved' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot(id)?.baseline.text).toBe('A');
    expect(value(await storage.history.list(target().ref, null))).toHaveLength(1);
  });
  it('исключение после начала save — unknown; missing повторяет исходный запрос неизменным', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    const save = storage.documents.save;
    const spy = vi
      .spyOn(storage.documents, 'save')
      .mockRejectedValueOnce(new Error('транспорт'))
      .mockImplementation(save);
    expect(await app.save(id, target())).toMatchObject({ kind: 'unknown' });
    append(app, id, 'B');
    expect(await app.reconcileSave(id)).toMatchObject({ kind: 'saved' });
    expect(spy.mock.calls[1]?.[0]).toEqual(spy.mock.calls[0]?.[0]);
    expect(Object.isFrozen(spy.mock.calls[0]?.[0].snapshot.fileMetadata)).toBe(true);
    expect(app.getSnapshot(id)).toMatchObject({
      baseline: { text: 'A' },
      edit: { document: { text: 'AB' } },
      isDirty: true,
    });
  });
  it('history-pending подтверждает файл, но блокирует следующий save до reconcile', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    const save = storage.documents.save;
    vi.spyOn(storage.documents, 'save')
      .mockImplementationOnce(async (request) => {
        const result = await save(request);
        if (result.kind !== 'saved') throw new Error('fixture');
        return { kind: 'history-pending', receipt: result.receipt, error: ioError };
      })
      .mockImplementation(save);
    expect(await app.save(id, target())).toMatchObject({ kind: 'history-pending' });
    expect(app.getSnapshot(id)).toMatchObject({
      baseline: { text: 'A' },
      isDirty: false,
      save: { kind: 'history-pending' },
    });
    append(app, id, 'B');
    let finished = false;
    const queued = app.save(id).then((r) => {
      finished = true;
      return r;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    await app.reconcileSave(id);
    expect(await queued).toMatchObject({ kind: 'saved' });
    expect(app.getSnapshot(id)?.baseline.text).toBe('AB');
  });
  it('отклоняет чужой receipt как unknown и восстанавливается по настоящему', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    const save = storage.documents.save;
    vi.spyOn(storage.documents, 'save').mockImplementation(async (request) => {
      const result = await save(request);
      return result.kind === 'saved'
        ? { ...result, receipt: { ...result.receipt, documentId: 'wrong' } }
        : result;
    });
    expect(await app.save(id, target())).toMatchObject({ kind: 'unknown' });
    expect(app.getSnapshot(id)?.edit.document.location).toBeNull();
    expect(await app.reconcileSave(id)).toMatchObject({ kind: 'saved' });
  });
  it('не перезаписывает файл без expectedRevision; конфликт независим от ошибки', async () => {
    const { app, storage, seed, externalWrite } = setup();
    const ref = seed('file', snapshot('old'));
    const id = value(await app.open(ref));
    append(app, id, '+local');
    externalWrite(ref, snapshot('external'));
    expect(await app.save(id)).toMatchObject({ kind: 'conflict' });
    expect(app.getSnapshot(id)?.edit.document.text).toBe('old+local');
    expect(await app.save(id)).toMatchObject({ kind: 'not-written', error: { code: 'busy' } });
    expect(value(await storage.documents.load(ref, null)).snapshot.text).toBe('external');
    expect(await app.save(id, target('copy'))).toMatchObject({ kind: 'saved' });
    expect(app.getSnapshot(id)?.conflict.kind).toBe('none');
  });
  it('не сохраняет в ресурс другой сессии и резервирует новую цель до исхода', async () => {
    const { app, storage, seed } = setup();
    const ref = seed('file', snapshot('old')),
      first = value(await app.open(ref));
    const second = app.create('txt');
    expect(
      await app.save(second, { ref, expectedRevision: app.getSnapshot(first)!.storageRevision }),
    ).toMatchObject({ kind: 'not-written', error: { code: 'busy' } });
    const save = storage.documents.save,
      gate = deferred<void>();
    vi.spyOn(storage.documents, 'save').mockImplementation(async (request) => {
      await gate.promise;
      return save(request);
    });
    const pending = app.save(second, target());
    expect(await app.open(target().ref)).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await app.save(first, target())).toMatchObject({
      kind: 'not-written',
      error: { code: 'busy' },
    });
    gate.resolve();
    await pending;
  });
});

describe('черновики, перечитывание и закрытие DM-09/DM-11/DM-12', () => {
  it('ошибка очистки черновика не меняет успех файла; закрытие при ошибке остаётся открытым', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    const clear = vi
      .spyOn(storage.drafts, 'removeThrough')
      .mockResolvedValue({ ok: false, error: ioError });
    expect(await app.save(id, target())).toMatchObject({ kind: 'saved' });
    expect(app.getSnapshot(id)).toMatchObject({
      isDirty: false,
      draftError: ioError,
      save: { kind: 'idle' },
    });
    expect(await app.close(id, 'discard')).toMatchObject({ ok: false });
    expect(app.getSnapshot(id)).toBeDefined();
    clear.mockRestore();
    expect(value(await app.close(id, 'discard')).closed).toBe(true);
  });
  it('flush после undo до чистого состояния очищает старый dirty-черновик', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    await app.flushDraft(id);
    value(app.undo(id));
    await app.flushDraft(id);
    expect(value(await storage.drafts.list())).toEqual([]);
  });
  it('поздний put после закрытия не воскрешает черновик; новая сессия имеет свой ключ', async () => {
    const { app, storage, seed } = setup();
    const ref = seed('file', snapshot());
    const id = value(await app.open(ref));
    append(app, id, 'A');
    const put = storage.drafts.put,
      gate = deferred<void>();
    vi.spyOn(storage.drafts, 'put').mockImplementation(async (draft) => {
      await gate.promise;
      return put(draft);
    });
    const flushing = app.flushDraft(id);
    await app.close(id, 'discard');
    const reopened = value(await app.open(ref));
    expect(reopened).not.toBe(id);
    gate.resolve();
    await flushing;
    expect(value(await storage.drafts.list())).toEqual([]);
    expect(app.getSnapshot(reopened)?.edit.document.text).toBe('');
  });
  it('закрытие с save не теряет ввод во время ожидания', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    append(app, id, 'A');
    const save = storage.documents.save,
      gate = deferred<void>();
    vi.spyOn(storage.documents, 'save').mockImplementation(async (r) => {
      await gate.promise;
      return save(r);
    });
    const closing = app.close(id, 'save', target());
    append(app, id, 'B');
    expect(await app.close(id, 'discard')).toMatchObject({ ok: false, error: { code: 'busy' } });
    gate.resolve();
    expect(value(await closing).closed).toBe(false);
    expect(app.getSnapshot(id)?.edit.document.text).toBe('AB');
  });
  it('блокирует правки только на финальной очистке и уведомляет о закрытии', async () => {
    const { app, storage } = setup();
    const id = app.create('txt');
    const initial = app.getSnapshot(id)!;
    const clear = storage.drafts.removeThrough,
      gate = deferred<void>();
    vi.spyOn(storage.drafts, 'removeThrough').mockImplementation(async (key, rev) => {
      await gate.promise;
      return clear(key, rev);
    });
    const listener = vi.fn();
    app.subscribe(id, listener);
    expect(value(await app.close(id, 'cancel')).closed).toBe(false);
    const closing = app.close(id, 'discard');
    expect(
      app.apply(id, transaction(initial.edit, { changes: [{ from: 0, to: 0, insert: 'late' }] })),
    ).toMatchObject({ ok: false, error: { code: 'busy' } });
    gate.resolve();
    expect(value(await closing).closed).toBe(true);
    expect(app.getSnapshot(id)).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });
  it('чистый внешний файл перечитывается; dirty получает сравнение; удаление сохраняет рабочий текст', async () => {
    const { app, seed, externalWrite, remove } = setup();
    const ref = seed('file', snapshot('A')),
      id = value(await app.open(ref));
    externalWrite(ref, snapshot('B'));
    value(await app.reload(id, 'if-clean'));
    expect(app.getSnapshot(id)).toMatchObject({
      isDirty: false,
      canUndo: false,
      edit: { document: { text: 'B', sourceRevision: 1 } },
    });
    append(app, id, '+local');
    externalWrite(ref, snapshot('C'));
    value(await app.reload(id, 'if-clean'));
    expect(app.getSnapshot(id)).toMatchObject({
      edit: { document: { text: 'B+local' } },
      conflict: { kind: 'changed', observed: { snapshot: { text: 'C' } } },
    });
    value(await app.reload(id, 'discard-local'));
    expect(app.getSnapshot(id)?.edit.document.text).toBe('C');
    remove(ref);
    expect(await app.reload(id, 'if-clean')).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    expect(app.getSnapshot(id)).toMatchObject({
      conflict: { kind: 'deleted' },
      edit: { document: { text: 'C' } },
    });
  });
  it.each(['if-clean', 'discard-local'] as const)(
    'старое чтение %s не заменяет новый ввод',
    async (intent) => {
      const { app, storage, seed, externalWrite } = setup();
      const ref = seed('file', snapshot('A')),
        id = value(await app.open(ref));
      externalWrite(ref, snapshot('B'));
      const gate = deferred<Result<LoadedDocument, PortError>>();
      vi.spyOn(storage.documents, 'load').mockReturnValueOnce(gate.promise);
      const reload = app.reload(id, intent);
      append(app, id, '+local');
      gate.resolve({
        ok: true,
        value: {
          documentId: app.getSnapshot(id)!.edit.document.id,
          format: 'txt',
          ref,
          snapshot: snapshot('B'),
          storageRevision: 'new',
        },
      });
      expect(await reload).toMatchObject({ ok: false, error: { code: 'busy' } });
      expect(app.getSnapshot(id)?.edit.document.text).toBe('A+local');
    },
  );
  it('ответ закрытой сессии не меняет повторно открытую с тем же DocumentId', async () => {
    const { app, storage, seed } = setup();
    const ref = seed('file', snapshot('A')),
      id = value(await app.open(ref));
    const load = storage.documents.load,
      captured = await load(ref, null),
      gate = deferred<Result<LoadedDocument, PortError>>();
    vi.spyOn(storage.documents, 'load').mockReturnValueOnce(gate.promise).mockImplementation(load);
    const pending = app.reload(id, 'discard-local');
    await app.close(id, 'discard');
    const next = value(await app.open(ref));
    append(app, next, '+new');
    gate.resolve(captured);
    expect(await pending).toMatchObject({ ok: false });
    expect(app.getSnapshot(next)?.edit.document.text).toBe('A+new');
  });
  it('последний запрос перечитывания побеждает более ранний', async () => {
    const { app, storage, seed } = setup();
    const ref = seed('file', snapshot('A')),
      id = value(await app.open(ref));
    const first = deferred<Result<LoadedDocument, PortError>>(),
      second = deferred<Result<LoadedDocument, PortError>>();
    vi.spyOn(storage.documents, 'load')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const a = app.reload(id, 'if-clean'),
      b = app.reload(id, 'if-clean');
    const loaded = (text: string): Result<LoadedDocument, PortError> => ({
      ok: true,
      value: {
        documentId: app.getSnapshot(id)!.edit.document.id,
        format: 'txt',
        ref,
        snapshot: snapshot(text),
        storageRevision: text,
      },
    });
    second.resolve(loaded('C'));
    value(await b);
    first.resolve(loaded('B'));
    expect(await a).toMatchObject({ ok: false });
    expect(app.getSnapshot(id)?.edit.document.text).toBe('C');
  });
  it('сохранение инвалидирует старое чтение даже без новых текстовых ревизий', async () => {
    const { app, storage, seed } = setup();
    const ref = seed('file', snapshot('A')),
      id = value(await app.open(ref));
    const original = await storage.documents.load(ref, null),
      gate = deferred<Result<LoadedDocument, PortError>>();
    vi.spyOn(storage.documents, 'load').mockReturnValueOnce(gate.promise);
    const pending = app.reload(id, 'if-clean');
    await app.save(id);
    gate.resolve(original);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'busy' } });
  });
});
