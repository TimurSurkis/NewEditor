import { expect, it } from 'vitest';
import { WorkspaceEditor } from '../../src/ui/editors/workspace-editor';
import type { EditorFactory, EditorFrame, EditorHost } from '../../src/ui/editors/contracts';
import type { CommandError } from '../../src/application';
import type { DocumentFormat, Result } from '../../src/core';
import { deferred, setup, transaction, value } from '../support/documents';

function fixture(format: DocumentFormat = 'txt') {
  const memory = setup(),
    id = memory.app.create(format);
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
  const visual = { ...factory, mode: 'visual' as const };
  const editor = new WorkspaceEditor(memory.app, factory, visual);
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
    visual,
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

it('MD: mode/выделение/metadata-кеш не меняют исходник, общая история остаётся одной', async () => {
  const f = fixture('markdown');
  value(f.type('**A😀** e\u0301\r\n'));
  f.host().selectionChanged({ anchor: 2, head: 5 });
  const before = f.app.getSnapshot(f.id)!,
    revision = before.edit.stateRevision;
  expect(f.frame().markdown).toBeUndefined();
  await f.editor.switchMode(f.id, 'visual');
  const parsed = f.frame().markdown;
  expect(parsed?.text).toBe(before.edit.document.text);
  expect(f.frame().selection).toEqual({ anchor: 2, head: 5 });
  await f.editor.switchMode(f.id, 'source');
  await f.editor.switchMode(f.id, 'visual');
  expect(f.frame().markdown).toBe(parsed);
  expect(f.app.getSnapshot(f.id)?.edit.stateRevision).toBe(revision);
  await f.editor.changeMetadata(f.id, { encoding: 'utf-8', bom: true });
  expect(f.frame().markdown).toBe(parsed);
  await f.editor.format(f.id, { kind: 'toggle-inline', style: 'strong' });
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('A😀 e\u0301\r\n');
  await f.editor.switchMode(f.id, 'source');
  await f.editor.history(f.id);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('**A😀** e\u0301\r\n');
  f.editor.destroy();
});

it('TXT не получает visual/Markdown-правки; source-кадры MD не содержат обязательного parse', async () => {
  const f = fixture();
  value(f.type('text'));
  f.host().selectionChanged({ anchor: 0, head: 4 });
  await f.editor.switchMode(f.id, 'visual');
  await f.editor.format(f.id, { kind: 'heading', level: 2 });
  expect(f.editor.getSnapshot(f.id).mode).toBe('source');
  expect(f.frame().markdown).toBeUndefined();
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('text');
  f.editor.destroy();
  const md = fixture('markdown');
  value(md.type('source'));
  expect(md.frame().markdown).toBeUndefined();
  await md.editor.switchMode(md.id, 'visual');
  const parsed = md.frame().markdown;
  await md.editor.switchMode(md.id, 'source');
  value(md.type('new'));
  expect(md.frame().markdown).toBeUndefined();
  await md.editor.switchMode(md.id, 'visual');
  expect(md.frame().markdown).not.toBe(parsed);
  md.editor.destroy();
});

it('mode ожидает IME/flush до уничтожения прежнего движка', async () => {
  const f = fixture('markdown'),
    pending = deferred<Result<void, CommandError>>();
  f.host().compositionChanged(true);
  f.flush(() => pending.promise);
  const switching = f.editor.switchMode(f.id, 'visual');
  expect(f.destroyed()).toBe(0);
  expect(f.editor.getSnapshot(f.id).mode).toBe('source');
  value(f.type('日本語'));
  f.host().compositionChanged(false);
  pending.resolve({ ok: true, value: undefined });
  await switching;
  expect(f.editor.getSnapshot(f.id).mode).toBe('visual');
  expect(f.frame().markdown?.text).toBe('日本語');
  f.editor.destroy();
});

it('pending/ABA не разрешают смену движка и не теряют новый текст', async () => {
  const f = fixture('markdown');
  value(f.type('new'));
  f.host().reportError({ code: 'busy', message: 'pending', retryable: true }, 'pending');
  await f.editor.switchMode(f.id, 'visual');
  expect(f.destroyed()).toBe(0);
  expect(f.editor.getSnapshot(f.id).pending).toBe('pending');
  f.editor.discardPending(f.id);
  const pending = deferred<Result<void, CommandError>>(),
    second = f.app.create('markdown');
  f.flush(() => pending.promise);
  const switching = f.editor.switchMode(f.id, 'visual');
  f.editor.synchronize([f.id, second], second);
  f.editor.synchronize([f.id, second], f.id);
  pending.resolve({ ok: true, value: undefined });
  await switching;
  expect(f.editor.getSnapshot(f.id).mode).toBe('source');
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('new');
  f.editor.destroy();
});

it('visual-find сохраняет видимый match; скрытый match и replace переходят в source', async () => {
  const f = fixture('markdown'),
    text = '**word** [label](https://example.test/)';
  value(f.type(text));
  await f.editor.switchMode(f.id, 'visual');
  f.editor.setSearch(f.id, { query: 'word', replacement: '$1' });
  await f.editor.find(f.id);
  expect(f.editor.getSnapshot(f.id).mode).toBe('visual');
  f.editor.setSearch(f.id, { query: 'https' });
  await f.editor.find(f.id);
  expect(f.editor.getSnapshot(f.id).mode).toBe('source');
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe(text);
  await f.editor.switchMode(f.id, 'visual');
  f.editor.setSearch(f.id, { query: 'word' });
  await f.editor.replace(f.id, true);
  expect(f.editor.getSnapshot(f.id).mode).toBe('source');
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('**$1** [label](https://example.test/)');
  await f.editor.history(f.id);
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe(text);
  f.editor.destroy();
});

it('requestSource меняет режим; ошибка visual-mount возвращает сохранённый source', async () => {
  const f = fixture('markdown');
  value(f.type('<div>raw</div>'));
  await f.editor.switchMode(f.id, 'visual');
  const done = deferred<void>(),
    stop = f.editor.subscribe(f.id, () => {
      if (f.editor.getSnapshot(f.id).mode === 'source') done.resolve();
    });
  f.host().requestSource({ anchor: 5, head: 8 });
  await done.promise;
  stop();
  expect(f.frame().selection).toEqual({ anchor: 5, head: 8 });
  f.visual.mount = () => {
    throw new Error('projection failed');
  };
  await f.editor.switchMode(f.id, 'visual');
  expect(f.editor.getSnapshot(f.id).mode).toBe('source');
  expect(f.editor.getSnapshot(f.id).error).toContain('исходник сохранён');
  expect(f.frame().state.document.text).toBe('<div>raw</div>');
  f.editor.destroy();
});

it('mode/parse-кеши двух MD изолированы, финальное closing блокирует visual-команды', async () => {
  const f = fixture('markdown');
  value(f.type('first'));
  await f.editor.switchMode(f.id, 'visual');
  const first = f.frame().markdown;
  const second = f.app.create('markdown');
  f.editor.detach(f.id);
  f.editor.synchronize([f.id, second], second);
  f.editor.mount(second, {} as HTMLElement);
  const state = f.app.getSnapshot(second)!.edit;
  value(f.host().dispatch(transaction(state, { changes: [{ from: 0, to: 0, insert: 'second' }] })));
  await f.editor.switchMode(second, 'visual');
  expect(f.frame().markdown).not.toBe(first);
  expect(f.editor.getSnapshot(f.id).mode).toBe('visual');
  f.editor.detach(second);
  f.editor.synchronize([f.id, second], f.id);
  f.editor.mount(f.id, {} as HTMLElement);
  expect(f.frame().markdown).toBe(first);
  f.editor.synchronize([f.id, second], f.id, [f.id]);
  expect(f.frame().editable).toBe(false);
  await f.editor.format(f.id, { kind: 'heading', level: 2 });
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('first');
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

it('кодировка/BOM меняются отменяемой metadata-only транзакцией', async () => {
  const f = fixture();
  value(f.type('A'));
  const revision = f.app.getSnapshot(f.id)!.edit.document.sourceRevision;
  await f.editor.changeMetadata(f.id, { encoding: 'windows-1251', bom: false });
  expect(f.app.getSnapshot(f.id)?.edit.document.fileMetadata.encoding).toBe('windows-1251');
  expect(f.app.getSnapshot(f.id)?.edit.document.sourceRevision).toBe(revision);
  await f.editor.history(f.id);
  expect(f.app.getSnapshot(f.id)?.edit.document.fileMetadata).toEqual({
    encoding: 'utf-8',
    bom: false,
  });
  expect(f.app.getSnapshot(f.id)?.edit.document.text).toBe('A');
  await f.editor.changeMetadata(f.id, { encoding: 'utf-8', bom: true });
  expect(f.app.getSnapshot(f.id)?.edit.document.fileMetadata.bom).toBe(true);
  f.editor.destroy();
});
