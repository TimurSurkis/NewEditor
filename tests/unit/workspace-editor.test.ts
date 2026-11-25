import { expect, it } from 'vitest';
import { WorkspaceEditor } from '../../src/ui/editors/workspace-editor';
import type { EditorFactory, EditorFrame, EditorHost } from '../../src/ui/editors/contracts';
import type { CommandError } from '../../src/application';
import type { Result } from '../../src/core';
import { deferred, setup, transaction, value } from '../support/documents';

function fixture() {
  const memory = setup(),
    id = memory.app.create('txt');
  let host!: EditorHost, frame!: EditorFrame;
  let flush = async (): Promise<Result<void, CommandError>> => ({ ok: true, value: undefined });
  let destroyed = 0;
  const factory: EditorFactory = {
    mode: 'source',
    mount(_element, next, initial) {
      host = next;
      frame = initial;
      return {
        render(next) {
          frame = next;
        },
        flush: () => flush(),
        focus() {},
        destroy() {
          destroyed++;
        },
      };
    },
  };
  const editor = new WorkspaceEditor(memory.app, factory);
  editor.synchronize([id], id);
  editor.mount(id, {} as HTMLElement);
  const type = (text: string) => {
    const edit = memory.app.getSnapshot(id)!.edit,
      end = edit.document.text.length;
    return host.dispatch(
      transaction(
        edit,
        { changes: [{ from: end, to: end, insert: text }] },
        { anchor: end, head: end },
        { anchor: end + text.length, head: end + text.length },
      ),
    );
  };
  return {
    ...memory,
    id,
    editor,
    type,
    host: () => host,
    frame: () => frame,
    destroyed: () => destroyed,
    flush: (next: typeof flush) => {
      flush = next;
    },
  };
}

it('общие undo/redo, выделение и история сохраняются при пересоздании редактора', async () => {
  const f = fixture();
  value(f.type('A😀'));
  f.host().selectionChanged({ anchor: 1, head: 3 });
  f.editor.detach(f.id);
  f.editor.mount(f.id, {} as HTMLElement);
  expect(f.frame().selection).toEqual({ anchor: 1, head: 3 });
  await f.editor.history(f.id);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('');
  await f.editor.history(f.id, true);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('A😀');
  await f.editor.selectAll(f.id);
  expect(f.editor.getSnapshot(f.id).selection).toEqual({ anchor: 0, head: 3 });
  f.editor.destroy();
});

it('next/previous цикличны, replace требует выделение, replace-all отменяется одним действием', async () => {
  const f = fixture();
  value(f.type('A a A'));
  f.host().selectionChanged({ anchor: 0, head: 0 });
  f.editor.setSearch(f.id, { query: 'a', replacement: '$1', searchOpen: true });
  expect(f.editor.getSnapshot(f.id).matches).toBe(3);
  await f.editor.replace(f.id);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('A a A');
  expect(f.editor.getSnapshot(f.id).current).toBe(1);
  await f.editor.replace(f.id);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('$1 a A');
  await f.editor.history(f.id);
  await f.editor.find(f.id, true);
  expect(f.editor.getSnapshot(f.id).current).toBe(3);
  await f.editor.find(f.id);
  expect(f.editor.getSnapshot(f.id).current).toBe(1);
  await f.editor.replace(f.id, true);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('$1 $1 $1');
  await f.editor.history(f.id);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('A a A');
  f.editor.destroy();
});

it('параметры поиска/выделение двух вкладок независимы, поиск не меняет ревизию', async () => {
  const f = fixture(),
    second = f.app.create('txt');
  f.editor.synchronize([f.id, second], f.id);
  value(f.type('a a'));
  const revision = f.app.getSnapshot(f.id)!.edit.stateRevision;
  f.editor.setSearch(f.id, { query: 'a', matchCase: true });
  await f.editor.find(f.id);
  expect(f.app.getSnapshot(f.id)?.edit.stateRevision).toBe(revision);
  f.editor.synchronize([f.id, second], second);
  f.editor.setSearch(second, { query: 'B' });
  expect(f.editor.getSnapshot(f.id).query).toBe('a');
  expect(f.editor.getSnapshot(second).query).toBe('B');
  f.editor.destroy();
});

it('команда после ожидающего flush не меняет уже неактивную сессию', async () => {
  const f = fixture(),
    pending = deferred<Result<void, CommandError>>(),
    second = f.app.create('txt');
  value(f.type('A'));
  f.flush(() => pending.promise);
  const undo = f.editor.history(f.id);
  f.editor.synchronize([f.id, second], second);
  f.editor.synchronize([f.id, second], f.id); // ABA: прежняя SessionId снова активна, команда всё равно устарела.
  pending.resolve({ ok: true, value: undefined });
  await undo;
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('A');
  expect(f.editor.getSnapshot(f.id).busy).toBe(false);
  f.editor.destroy();
});

it('stale-ввод сохраняется отдельно, flush отказывает; discard не удаляет актуальный текст', async () => {
  const f = fixture(),
    old = f.app.getSnapshot(f.id)!.edit;
  value(f.type('new'));
  const stale = f
    .host()
    .dispatch(transaction(old, { changes: [{ from: 0, to: 0, insert: 'stale' }] }));
  expect(stale.ok).toBe(false);
  if (stale.ok) return;
  f.host().reportError(stale.error, 'stale');
  f.flush(async () => stale);
  expect((await f.editor.flush(f.id)).ok).toBe(false);
  expect(f.editor.getSnapshot(f.id).pending).toBe('stale');
  expect(f.editor.hasPending()).toBe(true);
  f.editor.discardPending(f.id);
  expect(f.editor.getSnapshot(f.id).pending).toBeNull();
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('new');
  expect(f.destroyed()).toBe(1);
  f.editor.destroy();
});

it('финальное закрытие блокирует редактор/команды и восстанавливает их после отказа', async () => {
  const f = fixture();
  value(f.type('A'));
  f.editor.synchronize([f.id], f.id, [f.id]);
  expect(f.frame().editable).toBe(false);
  await f.editor.history(f.id);
  expect(f.host().undo().ok).toBe(false);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('A');
  f.editor.synchronize([f.id], f.id);
  expect(f.frame().editable).toBe(true);
  await f.editor.history(f.id);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('');
  f.editor.destroy();
});
