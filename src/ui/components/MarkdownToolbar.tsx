import type { SourceView, WorkspaceEditor } from '../editors/workspace-editor';
import type { InlineStyle } from '../../formats';

export function MarkdownToolbar({
  id,
  editor,
  state,
}: {
  readonly id: string;
  readonly editor: WorkspaceEditor;
  readonly state: SourceView;
}) {
  const disabled = state.busy || !state.editable || state.pending !== null;
  return (
    <>
      <div className="source-toolbar" aria-label="Режим Markdown">
        <button
          disabled={disabled}
          aria-pressed={state.mode === 'source'}
          onClick={() => void editor.switchMode(id, 'source')}
        >
          Исходный режим
        </button>
        <button
          disabled={disabled}
          aria-pressed={state.mode === 'visual'}
          onClick={() => void editor.switchMode(id, 'visual')}
        >
          Визуальный режим
        </button>
      </div>
      <div
        className="source-toolbar"
        aria-label="Базовое форматирование Markdown"
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) event.preventDefault();
        }}
      >
        <select
          aria-label="Стиль блока Markdown"
          value=""
          disabled={disabled || state.composing}
          onChange={(event) => {
            const level = Number(event.target.value) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
            void editor.format(id, { kind: 'heading', level });
          }}
        >
          <option value="" disabled>
            Стиль блока…
          </option>
          <option value="0">Абзац</option>
          {[1, 2, 3, 4, 5, 6].map((level) => (
            <option key={level} value={level}>
              Заголовок {level}
            </option>
          ))}
        </select>
        {(
          [
            ['strong', 'Жирный'],
            ['emphasis', 'Курсив'],
            ['strike', 'Зачёркнутый'],
            ['code', 'Код в строке'],
          ] as const
        ).map(([style, label]: readonly [InlineStyle, string]) => (
          <button
            key={style}
            aria-pressed={state.inline[style]}
            title={state.selection.anchor === state.selection.head ? 'Выделите текст' : undefined}
            disabled={
              disabled || state.composing || state.selection.anchor === state.selection.head
            }
            onClick={() => void editor.format(id, { kind: 'toggle-inline', style })}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="source-warning">
        P6.2 в работе: подключены режимы, базовые стили и разделение/соединение непустых абзацев.
        Enter на краю блока, списки/таблицы, диалоги ссылок и оптимизация visual ещё не завершены.
        Изображения пока показаны метками, без загрузки.
      </p>
    </>
  );
}
