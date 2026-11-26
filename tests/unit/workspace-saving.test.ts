import { expect, it, vi } from 'vitest';
import { createWorkspaceApplication } from '../../src/application';
import type { CloseDecision, WorkspaceDialogs, SaveDialogResult } from '../../src/application';
import type { SaveRequest, PortError } from '../../src/ports';
import type { Result } from '../../src/core';
import { deferred, setup, transaction, value } from '../support/documents';

function fixture() {
  const f = setup();
  const target = { ref: { storageId: 'memory', resourceId: 'new' }, expectedRevision: null };
  const dialogs: WorkspaceDialogs = {
    pickSave: vi.fn<WorkspaceDialogs['pickSave']>(async () => ({
      ok: true,
      value: { target, displayName: 'new.txt' },
    })),
    confirmClose: vi.fn<WorkspaceDialogs['confirmClose']>(async () => ({
      ok: true,
      value: 'cancel',
    })),
  };
  const workspace = createWorkspaceApplication(
    f.app,
    async () => ({ ok: true, value: null }),
    undefined,
    dialogs,
  );
  const edit = (id: string, text: string) => {
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
  return { ...f, workspace, dialogs, target, edit };
}

it('новый пустой save, имя/DocumentId и отмена Save As без записи', async () => {
  const f = fixture();
  await f.workspace.create('txt');
  const id = f.workspace.getSnapshot().activeId!,
    doc = f.app.getSnapshot(id)!.edit.document.id;
  vi.mocked(f.dialogs.pickSave).mockResolvedValueOnce({ ok: true, value: null });
  expect(await f.workspace.save(id)).toBeNull();
  expect(value(await f.storage.documents.getOperation('operation-3')).kind).toBe('missing');
  expect((await f.workspace.save(id))?.kind).toBe('saved');
  expect(f.workspace.getSnapshot().tabs[0]?.name).toBe('new.txt');
  expect(f.app.getSnapshot(id)?.edit.document.id).toBe(doc);
  expect(value(await f.storage.documents.load(f.target.ref, null)).snapshot.text).toBe('');
  f.workspace.dispose();
});

it('новый ввод во время save остаётся dirty; повтор команды разделяет попытку', async () => {
  const f = fixture(),
    entered = deferred<SaveRequest>(),
    release = deferred<void>(),
    save = f.storage.documents.save.bind(f.storage.documents);
  vi.spyOn(f.storage.documents, 'save').mockImplementation(async (request) => {
    entered.resolve(request);
    await release.promise;
    return save(request);
  });
  await f.workspace.create('txt');
  const id = f.workspace.getSnapshot().activeId!;
  f.edit(id, 'A');
  const a = f.workspace.save(id),
    b = f.workspace.save(id);
  expect(a).toBe(b);
  const captured = await entered.promise;
  f.edit(id, 'B');
  release.resolve();
  expect((await a)?.kind).toBe('saved');
  expect(captured.snapshot.text).toBe('A');
  expect(f.app.getSnapshot(id)).toMatchObject({
    isDirty: true,
    baseline: { text: 'A' },
    edit: { document: { text: 'AB' } },
  });
  expect(f.dialogs.pickSave).toHaveBeenCalledTimes(1);
  f.workspace.dispose();
});

it('Save при закрытии не закрывает новые правки после захваченного снимка', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    release = deferred<void>(),
    save = f.storage.documents.save.bind(f.storage.documents);
  vi.mocked(f.dialogs.confirmClose).mockResolvedValue({ ok: true, value: 'save' });
  vi.spyOn(f.storage.documents, 'save').mockImplementation(async (request) => {
    entered.resolve();
    await release.promise;
    return save(request);
  });
  await f.workspace.create('txt');
  const id = f.workspace.getSnapshot().activeId!;
  f.edit(id, 'A');
  const closing = f.workspace.close(id);
  await entered.promise;
  f.edit(id, 'B');
  release.resolve();
  await closing;
  expect(f.workspace.getSnapshot().tabs).toHaveLength(1);
  expect(f.app.getSnapshot(id)?.edit.document.text).toBe('AB');
  expect(f.app.getSnapshot(id)?.isDirty).toBe(true);
  f.workspace.dispose();
});

it('старое разрешение discard не отбрасывает ввод, появившийся в диалоге', async () => {
  const f = fixture(),
    answer = deferred<Result<CloseDecision, PortError>>(),
    entered = deferred<void>();
  vi.mocked(f.dialogs.confirmClose).mockImplementation(() => {
    entered.resolve();
    return answer.promise;
  });
  await f.workspace.create('txt');
  const id = f.workspace.getSnapshot().activeId!;
  f.edit(id, 'A');
  const closing = f.workspace.close(id);
  await entered.promise;
  f.edit(id, 'B');
  answer.resolve({ ok: true, value: 'discard' });
  await closing;
  expect(f.workspace.getSnapshot().tabs).toHaveLength(1);
  expect(f.app.getSnapshot(id)?.edit.document.text).toBe('AB');
  f.workspace.dispose();
});

it.each(['cancel', 'discard', 'save'] as const)(
  'решение закрытия %s выполняет только выбранное действие',
  async (decision) => {
    const f = fixture();
    vi.mocked(f.dialogs.confirmClose).mockResolvedValue({ ok: true, value: decision });
    await f.workspace.create('txt');
    const id = f.workspace.getSnapshot().activeId!;
    f.edit(id, 'A');
    await f.workspace.close(id);
    expect(f.workspace.getSnapshot().tabs).toHaveLength(decision === 'cancel' ? 1 : 0);
    expect(f.dialogs.pickSave).toHaveBeenCalledTimes(decision === 'save' ? 1 : 0);
    f.workspace.dispose();
  },
);

it('отмена выбора цели при close/save оставляет dirty-сессию', async () => {
  const f = fixture();
  vi.mocked(f.dialogs.confirmClose).mockResolvedValue({ ok: true, value: 'save' });
  vi.mocked(f.dialogs.pickSave).mockResolvedValue({ ok: true, value: null });
  await f.workspace.create('txt');
  const id = f.workspace.getSnapshot().activeId!;
  f.edit(id, 'A');
  await f.workspace.close(id);
  expect(f.workspace.getSnapshot().tabs).toHaveLength(1);
  expect(f.app.getSnapshot(id)?.isDirty).toBe(true);
  f.workspace.dispose();
});

it.each(['unknown', 'history-pending'] as const)(
  '%s блокирует close и разрешается без второй записи',
  async (kind) => {
    const f = fixture(),
      save = f.storage.documents.save.bind(f.storage.documents);
    const spy = vi.spyOn(f.storage.documents, 'save').mockImplementation(async (request) => {
      const saved = await save(request);
      if (saved.kind !== 'saved') throw new Error('save');
      const error: PortError = { code: 'io-error', message: 'pending', retryable: true };
      return kind === 'unknown'
        ? { kind, operationId: request.operationId, error }
        : { kind, receipt: saved.receipt, error };
    });
    await f.workspace.create('txt');
    const id = f.workspace.getSnapshot().activeId!;
    f.edit(id, 'A');
    expect((await f.workspace.save(id))?.kind).toBe(kind);
    await f.workspace.close(id);
    expect(f.dialogs.confirmClose).not.toHaveBeenCalled();
    expect(f.workspace.getSnapshot().tabs).toHaveLength(1);
    await f.workspace.reconcile(id);
    expect(f.app.getSnapshot(id)?.save.kind).toBe('idle');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(f.workspace.getSnapshot().tabs[0]?.name).toBe('new.txt');
    f.workspace.dispose();
  },
);

it('имя неудачной Save As не переносится на последующий обычный save', async () => {
  const f = fixture();
  await f.workspace.create('txt');
  const id = f.workspace.getSnapshot().activeId!;
  f.edit(id, 'A');
  await f.workspace.save(id);
  const bad: SaveDialogResult = {
    target: { ref: f.target.ref, expectedRevision: 'stale' },
    displayName: 'wrong.txt',
  };
  vi.mocked(f.dialogs.pickSave).mockResolvedValue({ ok: true, value: bad });
  f.edit(id, 'B');
  expect((await f.workspace.save(id, true))?.kind).toBe('conflict');
  // Та же цель дала прикладной conflict; для отдельной альтернативной цели он не блокирует исходник.
  const alternative = {
    ref: { storageId: 'memory', resourceId: 'alternative' },
    expectedRevision: 'stale',
  };
  const fresh = fixture();
  await fresh.workspace.create('txt');
  const next = fresh.workspace.getSnapshot().activeId!;
  fresh.edit(next, 'A');
  await fresh.workspace.save(next);
  vi.mocked(fresh.dialogs.pickSave).mockResolvedValue({
    ok: true,
    value: { target: alternative, displayName: 'wrong.txt' },
  });
  fresh.edit(next, 'B');
  expect((await fresh.workspace.save(next, true))?.kind).toBe('conflict');
  expect((await fresh.workspace.save(next))?.kind).toBe('saved');
  expect(fresh.workspace.getSnapshot().tabs[0]?.name).toBe('new.txt');
  f.workspace.dispose();
  fresh.workspace.dispose();
});

it('closeAll ждёт открытие, отключает создание новых вкладок и останавливается на отмене', async () => {
  const f = setup(),
    picked = deferred<Result<import('../../src/application').OpenDialogResult | null, PortError>>(),
    entered = deferred<void>();
  const workspace = createWorkspaceApplication(f.app, () => {
    entered.resolve();
    return picked.promise;
  });
  await workspace.create('txt');
  const opening = workspace.open();
  await entered.promise;
  const closing = workspace.closeAll();
  expect(workspace.getSnapshot().ending).toBe(true);
  await workspace.create('txt');
  expect(workspace.getSnapshot().tabs).toHaveLength(1);
  picked.resolve({ ok: true, value: null });
  await opening;
  expect(await closing).toBe(true);
  expect(workspace.getSnapshot().tabs).toHaveLength(0);
  expect(workspace.getSnapshot().ending).toBe(false);
  workspace.dispose();
});

it('Save As после переключения сохраняет исходную сессию и её новые правки', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    answer = deferred<Result<SaveDialogResult | null, PortError>>();
  vi.mocked(f.dialogs.pickSave).mockImplementation(() => {
    entered.resolve();
    return answer.promise;
  });
  await f.workspace.create('txt');
  const first = f.workspace.getSnapshot().activeId!;
  f.edit(first, 'A');
  const saving = f.workspace.save(first);
  await entered.promise;
  await f.workspace.create('txt');
  const second = f.workspace.getSnapshot().activeId!;
  f.edit(second, 'second');
  f.edit(first, 'B');
  answer.resolve({ ok: true, value: { target: f.target, displayName: 'first.txt' } });
  expect((await saving)?.kind).toBe('saved');
  expect(value(await f.storage.documents.load(f.target.ref, null)).snapshot.text).toBe('AB');
  expect(f.workspace.getSnapshot().activeId).toBe(second);
  expect(f.app.getSnapshot(second)?.edit.document.location).toBeNull();
  expect(f.workspace.getSnapshot().tabs.map((tab) => tab.name)).toEqual([
    'first.txt',
    'Без имени 2.txt',
  ]);
  f.workspace.dispose();
});

it('closeAll после отмены сохраняет оставшиеся вкладки и разрешает следующую попытку', async () => {
  const f = fixture();
  await f.workspace.create('txt');
  await f.workspace.create('txt');
  const dirty = f.workspace.getSnapshot().activeId!;
  f.edit(dirty, 'keep');
  await f.workspace.create('txt');
  expect(await f.workspace.closeAll()).toBe(false);
  expect(f.workspace.getSnapshot().tabs.map((tab) => tab.name)).toEqual([
    'Без имени 2.txt',
    'Без имени 3.txt',
  ]);
  expect(f.app.getSnapshot(dirty)?.edit.document.text).toBe('keep');
  vi.mocked(f.dialogs.confirmClose).mockResolvedValue({ ok: true, value: 'discard' });
  expect(await f.workspace.closeAll()).toBe(true);
  expect(f.workspace.getSnapshot().ending).toBe(false);
  f.workspace.dispose();
});
