import { expect, it, vi } from 'vitest';
import { createWorkspaceApplication } from '../../src/application';
import type { CommandError, WorkspaceDialogs } from '../../src/application';
import type { ResourceEvent, ResourceEvents, PortError, SaveResult } from '../../src/ports';
import type { Result } from '../../src/core';
import { deferred, setup, snapshot, transaction, value } from '../support/documents';

async function fixture() {
  const f = setup(),
    ref = f.seed('file', snapshot('old'));
  const subscriptions: {
    ref: ResourceEvent['ref'];
    event: (event: ResourceEvent) => void;
    error: (error: PortError) => void;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const events: ResourceEvents = {
    watch(ref, event, error) {
      const stop = vi.fn();
      subscriptions.push({ ref, event, error, stop });
      return stop;
    },
  };
  const dialogs: WorkspaceDialogs = {
    pickSave: vi.fn(async () => ({
      ok: true as const,
      value: {
        target: { ref: { storageId: 'memory', resourceId: 'copy' }, expectedRevision: null },
        displayName: 'copy.txt',
      },
    })),
    confirmClose: vi.fn(async () => ({ ok: true as const, value: 'cancel' as const })),
  };
  const flush = vi.fn<(id: string) => Promise<Result<void, CommandError>>>(async () => ({
    ok: true,
    value: undefined,
  }));
  const workspace = createWorkspaceApplication(
    f.app,
    async () => ({
      ok: true,
      value: { documents: [{ ref, displayName: 'file.txt' }], errors: [] },
    }),
    flush,
    dialogs,
    events,
  );
  await workspace.open();
  await workspace.refreshExternal();
  const id = workspace.getSnapshot().activeId!;
  const edit = (text: string) => {
    const state = f.app.getSnapshot(id)!.edit;
    value(
      f.app.apply(
        id,
        transaction(state, {
          changes: [
            { from: state.document.text.length, to: state.document.text.length, insert: text },
          ],
        }),
      ),
    );
  };
  const signal = (kind: ResourceEvent['kind'] = 'changed') =>
    subscriptions.at(-1)!.event({ ref: subscriptions.at(-1)!.ref, kind });
  const expected = () => {
    const view = f.app.getSnapshot(id)!;
    if (view.conflict.kind !== 'changed' || !view.conflict.observed) throw new Error('comparison');
    return {
      stateRevision: view.edit.stateRevision,
      storageRevision: view.conflict.observed.storageRevision,
    };
  };
  return {
    ...f,
    workspace,
    id,
    ref,
    events,
    subscriptions,
    dialogs,
    flush,
    edit,
    signal,
    expected,
  };
}

it('внешнее изменение чистой сессии обновляет текст/metadata и baseline без dirty', async () => {
  const f = await fixture();
  f.externalWrite(f.ref, { text: 'new\r\n', fileMetadata: { encoding: 'utf-8', bom: true } });
  f.signal();
  await f.workspace.refreshExternal();
  expect(f.app.getSnapshot(f.id)).toMatchObject({
    isDirty: false,
    canUndo: false,
    edit: { document: { text: 'new\r\n', fileMetadata: { bom: true } } },
    baseline: { text: 'new\r\n' },
    conflict: { kind: 'none' },
  });
  f.workspace.dispose();
  expect(f.subscriptions[0]!.stop).toHaveBeenCalledOnce();
});

it('dirty-сессия сохраняет undo/ревизию и сравнение; принятие явно очищает историю', async () => {
  const f = await fixture(),
    oldRevision = f.app.getSnapshot(f.id)!.storageRevision;
  f.edit('ours');
  f.externalWrite(f.ref, snapshot('theirs'));
  f.signal();
  await f.workspace.refreshExternal();
  expect(f.app.getSnapshot(f.id)).toMatchObject({
    storageRevision: oldRevision,
    isDirty: true,
    canUndo: true,
    edit: { document: { text: 'oldours' } },
    conflict: { kind: 'changed', observed: { snapshot: { text: 'theirs' } } },
  });
  await f.workspace.acceptExternal(f.id, f.expected());
  expect(f.app.getSnapshot(f.id)).toMatchObject({
    isDirty: false,
    canUndo: false,
    conflict: { kind: 'none' },
    edit: { document: { text: 'theirs' } },
  });
  f.workspace.dispose();
});

it.each(['local', 'external'] as const)(
  'устаревшее разрешение discard (%s) не меняет рабочий текст',
  async (kind) => {
    const f = await fixture();
    f.edit('ours');
    f.externalWrite(f.ref, snapshot('theirs'));
    await f.workspace.refreshExternal();
    const expected = f.expected();
    if (kind === 'local') f.edit('new');
    else f.externalWrite(f.ref, snapshot('new external'));
    await f.workspace.acceptExternal(f.id, expected);
    await f.workspace.refreshExternal();
    expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe(
      kind === 'local' ? 'oldoursnew' : 'oldours',
    );
    expect(f.app.getSnapshot(f.id)?.conflict.kind).toBe('changed');
    f.workspace.dispose();
  },
);

it('чтение после нового ввода отклоняется и повторяется как dirty-сравнение', async () => {
  const f = await fixture(),
    entered = deferred<void>(),
    release = deferred<void>(),
    load = f.storage.documents.load.bind(f.storage.documents);
  vi.spyOn(f.storage.documents, 'load').mockImplementationOnce(async (...args) => {
    const result = await load(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  f.externalWrite(f.ref, snapshot('external'));
  f.signal();
  await entered.promise;
  f.edit('new');
  release.resolve();
  await f.workspace.refreshExternal();
  expect(f.app.getSnapshot(f.id)).toMatchObject({
    edit: { document: { text: 'oldnew' } },
    conflict: { kind: 'changed', observed: { snapshot: { text: 'external' } } },
  });
  f.workspace.dispose();
});

it('IME/flush ожидается перед проверкой, неподтверждённый ввод не затирается', async () => {
  const f = await fixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  f.flush.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    f.edit('IME');
    return { ok: true, value: undefined };
  });
  f.externalWrite(f.ref, snapshot('external'));
  f.signal();
  await entered.promise;
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('old');
  release.resolve();
  await f.workspace.refreshExternal();
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('oldIME');
  expect(f.app.getSnapshot(f.id)?.conflict.kind).toBe('changed');
  f.workspace.dispose();
});

it.each([false, true])(
  'удалённая копия (dirty=%s) остаётся в памяти и требует решения при закрытии',
  async (dirty) => {
    const f = await fixture();
    if (dirty) f.edit('ours');
    f.remove(f.ref);
    f.signal('deleted');
    await f.workspace.refreshExternal();
    expect(f.app.getSnapshot(f.id)).toMatchObject({
      isDirty: dirty,
      edit: { document: { text: dirty ? 'oldours' : 'old' } },
      conflict: { kind: 'deleted' },
    });
    await f.workspace.close(f.id);
    expect(f.dialogs.confirmClose).toHaveBeenCalledWith('file.txt');
    expect(f.workspace.getSnapshot().tabs).toHaveLength(1);
    await f.workspace.save(f.id, true);
    expect(
      value(await f.storage.documents.load({ storageId: 'memory', resourceId: 'copy' }, null))
        .snapshot.text,
    ).toBe(dirty ? 'oldours' : 'old');
    expect(f.subscriptions[0]!.stop).toHaveBeenCalledOnce();
    expect(f.subscriptions.at(-1)!.ref.resourceId).toBe('copy');
    f.workspace.dispose();
  },
);

it.each(['unknown', 'history-pending'] as const)(
  'событие ждёт %s и обрабатывается после reconcile без новой записи',
  async (kind) => {
    const f = await fixture(),
      save = f.storage.documents.save.bind(f.storage.documents);
    const spy = vi.spyOn(f.storage.documents, 'save').mockImplementationOnce(async (request) => {
      const result = await save(request);
      if (result.kind !== 'saved') throw new Error('save');
      const error: PortError = { code: 'io-error', message: 'pending', retryable: true };
      return (
        kind === 'unknown'
          ? { kind, operationId: request.operationId, error }
          : { kind, receipt: result.receipt, error }
      ) satisfies SaveResult;
    });
    f.edit('ours');
    await f.workspace.save(f.id);
    f.externalWrite(f.ref, snapshot('after pending'));
    f.signal();
    await f.workspace.refreshExternal();
    expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('oldours');
    await f.workspace.reconcile(f.id);
    await f.workspace.refreshExternal();
    expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('after pending');
    expect(spy).toHaveBeenCalledTimes(1);
    f.workspace.dispose();
  },
);

it('отказ flush сохраняет pending-ввод; явная проверка после исправления повторяет чтение', async () => {
  const f = await fixture();
  f.flush.mockResolvedValueOnce({
    ok: false,
    error: { code: 'busy', message: 'pending input', retryable: false },
  });
  f.externalWrite(f.ref, snapshot('external'));
  f.signal();
  await f.workspace.refreshExternal();
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('old');
  expect(f.workspace.getSnapshot().tabs[0]?.externalError).toBe('pending input');
  await f.workspace.refreshExternal();
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('external');
  f.workspace.dispose();
});

it('событие во время save откладывается до ответа; внешний текст затем доступен для сравнения', async () => {
  const f = await fixture(),
    entered = deferred<void>(),
    release = deferred<void>(),
    save = f.storage.documents.save.bind(f.storage.documents);
  vi.spyOn(f.storage.documents, 'save').mockImplementationOnce(async (request) => {
    const result = await save(request);
    entered.resolve();
    await release.promise;
    return result;
  });
  f.edit('ours');
  const saving = f.workspace.save(f.id);
  await entered.promise;
  f.externalWrite(f.ref, snapshot('after save'));
  f.signal();
  f.edit('new');
  release.resolve();
  await saving;
  await f.workspace.refreshExternal();
  expect(f.app.getSnapshot(f.id)).toMatchObject({
    baseline: { text: 'oldours' },
    edit: { document: { text: 'oldoursnew' } },
    conflict: { kind: 'changed', observed: { snapshot: { text: 'after save' } } },
  });
  f.workspace.dispose();
});

it('ошибка чтения блокирует исходник без потери текста; повтор восстанавливает наблюдение', async () => {
  const f = await fixture();
  vi.spyOn(f.storage.documents, 'load').mockResolvedValueOnce({
    ok: false,
    error: { code: 'encoding-error', message: 'bad encoding', retryable: false },
  });
  f.signal();
  await f.workspace.refreshExternal();
  expect(f.workspace.getSnapshot().tabs[0]?.externalError).toBe('bad encoding');
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('old');
  expect(f.app.getSnapshot(f.id)?.conflict).toEqual({ kind: 'changed', observed: null });
  f.externalWrite(f.ref, snapshot('valid'));
  await f.workspace.refreshExternal();
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('valid');
  expect(f.workspace.getSnapshot().tabs[0]?.externalError).toBeNull();
  f.workspace.dispose();
});

it('dispose/смена location отменяет подписку и игнорирует позднее событие/ошибку', async () => {
  const f = await fixture(),
    old = f.subscriptions[0]!;
  await f.workspace.save(f.id, true);
  await f.workspace.refreshExternal();
  old.event({ ref: f.ref, kind: 'deleted' });
  old.error({ code: 'io-error', message: 'late', retryable: true });
  expect(f.app.getSnapshot(f.id)?.conflict.kind).toBe('none');
  expect(f.workspace.getSnapshot().tabs[0]?.externalError).toBeNull();
  f.workspace.dispose();
  expect(f.subscriptions.every((sub) => sub.stop.mock.calls.length === 1)).toBe(true);
});

it('новая правка во время повторного чтения для discard не заменяется внешним снимком', async () => {
  const f = await fixture();
  f.edit('ours');
  f.externalWrite(f.ref, snapshot('theirs'));
  await f.workspace.refreshExternal();
  const entered = deferred<void>(),
    release = deferred<void>(),
    load = f.storage.documents.load.bind(f.storage.documents);
  vi.spyOn(f.storage.documents, 'load').mockImplementationOnce(async (...args) => {
    const result = await load(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  const accepting = f.workspace.acceptExternal(f.id, f.expected());
  await entered.promise;
  f.edit('new');
  release.resolve();
  await accepting;
  await f.workspace.refreshExternal();
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('oldoursnew');
  expect(f.app.getSnapshot(f.id)?.conflict.kind).toBe('changed');
  f.workspace.dispose();
});
