import { expect, it, vi } from 'vitest';
import { createWorkspaceApplication } from '../../src/application';
import type { OpenDialogResult } from '../../src/application';
import type { PortError } from '../../src/ports';
import type { Result } from '../../src/core';
import { deferred, setup, snapshot, transaction, value } from '../support/documents';

const cancelled = async () => ({ ok: true as const, value: null });
it('создаёт монотонные имена, выбирает соседей и возвращает пустой экран', async () => {
  const { app } = setup(),
    workspace = createWorkspaceApplication(app, cancelled);
  const first = workspace.getSnapshot();
  expect(workspace.getSnapshot()).toBe(first);
  workspace.create('txt');
  workspace.create('markdown');
  workspace.create('txt');
  const [a, b, c] = workspace.getSnapshot().tabs;
  expect(workspace.getSnapshot().tabs.map((tab) => tab.name)).toEqual([
    'Без имени 1.txt',
    'Без имени 2.md',
    'Без имени 3.txt',
  ]);
  workspace.select(b!.id);
  await workspace.close(a!.id);
  expect(workspace.getSnapshot().activeId).toBe(b!.id);
  await workspace.close(b!.id);
  expect(workspace.getSnapshot().activeId).toBe(c!.id);
  await workspace.close(c!.id);
  expect(workspace.getSnapshot().activeId).toBeNull();
  workspace.create('txt');
  expect(workspace.getSnapshot().tabs[0]?.name).toBe('Без имени 4.txt');
  expect(Object.isFrozen(workspace.getSnapshot().tabs[0])).toBe(true);
  workspace.dispose();
});

it('отмена не создаёт вкладок, одновременный диалог разделяется, dispose игнорирует поздний ответ', async () => {
  const { app, seed } = setup(),
    picked = deferred<Result<OpenDialogResult | null, PortError>>(),
    pick = vi.fn(() => picked.promise);
  const workspace = createWorkspaceApplication(app, pick),
    a = workspace.open(),
    b = workspace.open();
  expect(a).toBe(b);
  await Promise.resolve();
  expect(pick).toHaveBeenCalledTimes(1);
  picked.resolve({ ok: true, value: null });
  await a;
  expect(workspace.getSnapshot().tabs).toEqual([]);
  const late = deferred<Result<OpenDialogResult | null, PortError>>();
  pick.mockImplementation(() => late.promise);
  const opening = workspace.open();
  await Promise.resolve();
  workspace.dispose();
  late.resolve({
    ok: true,
    value: {
      documents: [{ ref: seed('late', snapshot('text')), displayName: 'late.txt' }],
      errors: [],
    },
  });
  await opening;
  expect(workspace.getSnapshot().tabs).toEqual([]);
});

it('ошибка одного файла не мешает остальным; повтор/алиас активирует прежнюю вкладку', async () => {
  const { app, seed } = setup(),
    ref = seed('file', snapshot('A'));
  const workspace = createWorkspaceApplication(app, async () => ({
    ok: true,
    value: {
      documents: [
        { ref, displayName: 'file.txt' },
        { ref: { storageId: 'memory', resourceId: 'missing' }, displayName: 'missing.txt' },
        { ref, displayName: 'alias.txt' },
      ],
      errors: [
        {
          displayName: 'bad.exe',
          error: { code: 'unsupported', message: 'format', retryable: false },
        },
      ],
    },
  }));
  await workspace.open();
  expect(workspace.getSnapshot().tabs).toHaveLength(1);
  expect(workspace.getSnapshot().tabs[0]?.name).toBe('file.txt');
  expect(workspace.getSnapshot().errors).toHaveLength(2);
  await workspace.open();
  expect(workspace.getSnapshot().tabs).toHaveLength(1);
  workspace.clearErrors();
  expect(workspace.getSnapshot().errors).toEqual([]);
  workspace.dispose();
});

it('dirty-индикатор следует единственной сессии, dirty не закрывается молча', async () => {
  const { app } = setup(),
    workspace = createWorkspaceApplication(app, cancelled);
  workspace.create('txt');
  const id = workspace.getSnapshot().activeId!,
    edit = app.getSnapshot(id)!.edit;
  value(app.apply(id, transaction(edit, { changes: [{ from: 0, to: 0, insert: 'A' }] })));
  expect(workspace.getSnapshot().tabs[0]?.view.isDirty).toBe(true);
  await workspace.close(id);
  expect(workspace.getSnapshot().tabs).toHaveLength(1);
  expect(workspace.getSnapshot().errors).toHaveLength(1);
  value(app.undo(id));
  await workspace.close(id);
  expect(workspace.getSnapshot().tabs).toEqual([]);
  workspace.dispose();
});

it('ошибка очистки оставляет вкладку, повтор закрытия работает; подписчики изолированы', async () => {
  const { app, storage } = setup(),
    workspace = createWorkspaceApplication(app, cancelled),
    listener = vi.fn();
  workspace.subscribe(() => {
    throw new Error('listener');
  });
  const stop = workspace.subscribe(listener);
  workspace.create('txt');
  const id = workspace.getSnapshot().activeId!;
  const clear = vi.spyOn(storage.drafts, 'removeThrough').mockResolvedValueOnce({
    ok: false,
    error: { code: 'io-error', message: 'clear failed', retryable: true },
  });
  await workspace.close(id);
  expect(workspace.getSnapshot().tabs[0]?.closing).toBe(false);
  expect(workspace.getSnapshot().errors).toContain('clear failed');
  expect(clear).toHaveBeenCalledTimes(1);
  await workspace.close(id);
  expect(workspace.getSnapshot().tabs).toEqual([]);
  stop();
  stop();
  listener.mockClear();
  workspace.create('txt');
  expect(listener).not.toHaveBeenCalled();
  workspace.dispose();
});

it('синхронная новая правка на уведомлении closing не отбрасывается', async () => {
  const { app } = setup(),
    workspace = createWorkspaceApplication(app, cancelled);
  workspace.create('txt');
  const id = workspace.getSnapshot().activeId!;
  let inserted = false;
  workspace.subscribe(() => {
    if (!inserted && workspace.getSnapshot().tabs[0]?.closing) {
      inserted = true;
      value(
        app.apply(
          id,
          transaction(app.getSnapshot(id)!.edit, { changes: [{ from: 0, to: 0, insert: 'new' }] }),
        ),
      );
    }
  });
  await workspace.close(id);
  expect(workspace.getSnapshot().tabs[0]?.view.edit.document.text).toBe('new');
  expect(workspace.getSnapshot().tabs[0]?.closing).toBe(false);
  workspace.dispose();
});

it('dispose отписывается от сессии, исключение диалога снимает busy', async () => {
  const { app } = setup(),
    workspace = createWorkspaceApplication(app, async () => {
      throw new Error('dialog');
    });
  await workspace.open();
  expect(workspace.getSnapshot().opening).toBe(false);
  expect(workspace.getSnapshot().errors).toHaveLength(1);
  workspace.create('txt');
  const id = workspace.getSnapshot().activeId!,
    before = workspace.getSnapshot();
  workspace.dispose();
  value(
    app.apply(
      id,
      transaction(app.getSnapshot(id)!.edit, { changes: [{ from: 0, to: 0, insert: 'x' }] }),
    ),
  );
  expect(workspace.getSnapshot()).toBe(before);
});

it('переход ожидает guard/IME, повторное намерение не создаёт вкладку', async () => {
  const { app } = setup(),
    flush = deferred<Result<void, PortError>>();
  let block = false;
  const workspace = createWorkspaceApplication(app, cancelled, () =>
    block ? flush.promise : Promise.resolve({ ok: true, value: undefined }),
  );
  await workspace.create('txt');
  const first = workspace.getSnapshot().activeId;
  block = true;
  const creating = workspace.create('markdown');
  expect(workspace.getSnapshot().transitioning).toBe(true);
  await workspace.create('txt');
  expect(workspace.getSnapshot().activeId).toBe(first);
  expect(workspace.getSnapshot().tabs).toHaveLength(1);
  flush.resolve({ ok: true, value: undefined });
  await creating;
  expect(workspace.getSnapshot().tabs).toHaveLength(2);
  expect(workspace.getSnapshot().transitioning).toBe(false);
  workspace.dispose();
});

it('поздний open повторно проверяет flush и оставляет новый файл фоновым при отказе', async () => {
  const { app, seed } = setup(),
    selected = deferred<Result<OpenDialogResult | null, PortError>>(),
    entered = deferred<void>();
  let blocked = false;
  const workspace = createWorkspaceApplication(
    app,
    () => {
      entered.resolve();
      return selected.promise;
    },
    async () =>
      blocked
        ? { ok: false, error: { code: 'busy', message: 'pending input', retryable: false } }
        : { ok: true, value: undefined },
  );
  await workspace.create('txt');
  const first = workspace.getSnapshot().activeId;
  const opening = workspace.open();
  await entered.promise;
  blocked = true;
  selected.resolve({
    ok: true,
    value: {
      documents: [{ ref: seed('late', snapshot('A')), displayName: 'late.txt' }],
      errors: [],
    },
  });
  await opening;
  expect(workspace.getSnapshot().tabs).toHaveLength(2);
  expect(workspace.getSnapshot().activeId).toBe(first);
  expect(workspace.getSnapshot().errors).toContain('pending input');
  workspace.dispose();
});

it('отказ flush при закрытии не удаляет чистую вкладку', async () => {
  const { app } = setup();
  let blocked = false;
  const workspace = createWorkspaceApplication(app, cancelled, async () =>
    blocked
      ? { ok: false, error: { code: 'busy', message: 'composition', retryable: false } }
      : { ok: true, value: undefined },
  );
  await workspace.create('txt');
  const id = workspace.getSnapshot().activeId!;
  blocked = true;
  await workspace.close(id);
  expect(workspace.getSnapshot().tabs).toHaveLength(1);
  expect(app.getSnapshot(id)).toBeDefined();
  expect(workspace.getSnapshot().errors).toContain('composition');
  workspace.dispose();
});
