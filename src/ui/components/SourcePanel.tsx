import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { WorkspaceEditor } from '../editors/workspace-editor';

export function SourcePanel({
  id,
  editor,
}: {
  readonly id: string;
  readonly editor: WorkspaceEditor;
}) {
  const state = useSyncExternalStore(
    useCallback((listener) => editor.subscribe(id, listener), [editor, id]),
    useCallback(() => editor.getSnapshot(id), [editor, id]),
  );
  const element = useRef<HTMLDivElement>(null),
    query = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (element.current) editor.mount(id, element.current);
    return () => editor.detach(id);
  }, [id, editor]);
  useEffect(() => {
    if (state.searchOpen) query.current?.focus();
  }, [state.searchOpen]);
  return (
    <div
      className="source-panel"
      onKeyDownCapture={(event) => {
        const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
        if (
          mod &&
          (['f', 'h'].includes(event.key.toLowerCase()) || ['KeyF', 'KeyH'].includes(event.code))
        ) {
          event.preventDefault();
          editor.setSearch(id, { searchOpen: true });
          query.current?.focus();
        } else if (event.key === 'F3') {
          event.preventDefault();
          void editor.find(id, event.shiftKey);
        } else if (event.key === 'Escape' && state.searchOpen) {
          event.preventDefault();
          editor.setSearch(id, { searchOpen: false });
        }
      }}
    >
      <div
        className="source-toolbar"
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) event.preventDefault();
        }}
      >
        <button
          disabled={!state.canUndo || state.busy || !state.editable}
          onClick={() => void editor.history(id)}
        >
          Отменить
        </button>
        <button
          disabled={!state.canRedo || state.busy || !state.editable}
          onClick={() => void editor.history(id, true)}
        >
          Повторить
        </button>
        <button disabled={state.busy || !state.editable} onClick={() => void editor.selectAll(id)}>
          Выделить всё
        </button>
        <button onClick={() => editor.setSearch(id, { searchOpen: !state.searchOpen })}>
          Поиск и замена
        </button>
        {state.composing && <span role="status">Композиция: завершите ввод для перехода</span>}
      </div>
      <p className="source-warning">
        Изменения только в памяти. Сохранение появится на следующем этапе P5.3.
      </p>
      {state.searchOpen && (
        <section className="source-search" aria-label="Поиск и замена">
          <label>
            Найти
            <textarea
              rows={1}
              ref={query}
              aria-label="Найти"
              value={state.query}
              onChange={(event) => editor.setSearch(id, { query: event.target.value })}
            />
          </label>
          <label>
            Заменить на
            <textarea
              rows={1}
              aria-label="Заменить на"
              value={state.replacement}
              onChange={(event) => editor.setSearch(id, { replacement: event.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.matchCase}
              onChange={(event) => editor.setSearch(id, { matchCase: event.target.checked })}
            />
            Учитывать регистр
          </label>
          <output aria-label="Совпадения">
            {state.current} / {state.matches}
          </output>
          <button
            disabled={!state.matches || state.busy || !state.editable}
            onClick={() => void editor.find(id, true)}
          >
            Предыдущее
          </button>
          <button
            disabled={!state.matches || state.busy || !state.editable}
            onClick={() => void editor.find(id)}
          >
            Следующее
          </button>
          <button
            disabled={!state.matches || state.busy || !state.editable}
            onClick={() => void editor.replace(id)}
          >
            Заменить
          </button>
          <button
            disabled={!state.matches || state.busy || !state.editable}
            onClick={() => void editor.replace(id, true)}
          >
            Заменить всё
          </button>
        </section>
      )}
      {state.error && (
        <section role="alert">
          <p>{state.error}</p>
          {state.pending !== null && (
            <>
              <label>
                Неподтверждённый ввод
                <textarea aria-label="Неподтверждённый ввод" readOnly value={state.pending} />
              </label>
              <button onClick={() => editor.discardPending(id)}>
                Отбросить неподтверждённый ввод
              </button>
            </>
          )}
        </section>
      )}
      <div className="workspace-source-editor" ref={element} />
    </div>
  );
}
