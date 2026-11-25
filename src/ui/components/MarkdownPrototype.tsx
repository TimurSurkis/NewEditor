import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DocumentApplication } from '../../application';
import { PrototypeController } from '../editors/prototype-controller';
import './MarkdownPrototype.css';

const demo =
  '# Прототип Markdown\n\nОдин исходник, **два режима** и общая отмена.\n\n- [ ] Проверить задачу\n\n| Режим | Редактор |\n| --- | --- |\n| Исходный | CodeMirror |\n| Визуальный | ProseMirror |\n';
export function MarkdownPrototype({ application }: { readonly application: DocumentApplication }) {
  const [controller, setController] = useState<PrototypeController | null>(null);
  useEffect(() => {
    const next = new PrototypeController(application, demo);
    setController(next);
    return () => next.destroy();
  }, [application]);
  return controller ? <PrototypeView controller={controller} /> : <p>Подготовка прототипа…</p>;
}
function PrototypeView({ controller }: { readonly controller: PrototypeController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const container = useRef<HTMLDivElement>(null);
  const [seed, setSeed] = useState(demo),
    [alt, setAlt] = useState('');
  const [jsonInput, setJsonInput] = useState(false),
    [seedError, setSeedError] = useState(false);
  useEffect(() => {
    if (container.current) controller.mount(container.current);
    return () => controller.detach();
  }, [controller]);
  useEffect(() => {
    setAlt(state.imageAlt ?? '');
  }, [state.imageAlt]);
  const keepSelection = (event: React.MouseEvent) => event.preventDefault();
  return (
    <section className="markdown-prototype" aria-label="Прототип Markdown">
      <h1>Прототип Markdown</h1>
      <p>
        Проверочный стенд в памяти. Текст не записывается в файлы и не восстанавливается после
        закрытия приложения.
      </p>
      <details>
        <summary>Загрузить тестовый текст</summary>
        <label>
          <input
            type="checkbox"
            aria-label="JSON-строка"
            checked={jsonInput}
            onChange={(event) => {
              if (event.target.checked) setSeed(JSON.stringify(seed));
              else {
                try {
                  setSeed(String(JSON.parse(seed)));
                } catch {
                  setSeedError(true);
                }
              }
              setJsonInput(event.target.checked);
            }}
          />
          Точные переводы строк (JSON-строка)
        </label>
        <label>
          Исходный текст для проверки
          <textarea
            aria-label="Исходный текст для проверки"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
          />
        </label>
        <button
          onClick={() => {
            try {
              const text: unknown = jsonInput ? JSON.parse(seed) : seed;
              if (typeof text !== 'string') throw new Error('Ожидается строка');
              setSeedError(false);
              void controller.load(text);
            } catch {
              setSeedError(true);
            }
          }}
        >
          Загрузить текст
        </button>
        {seedError && <p role="alert">Ожидается корректная JSON-строка</p>}
      </details>
      <div className="prototype-toolbar" onMouseDown={keepSelection}>
        <button
          aria-pressed={state.mode === 'source'}
          onClick={() => void controller.switchMode('source')}
        >
          Исходный режим
        </button>
        <button
          aria-pressed={state.mode === 'visual'}
          onClick={() => void controller.switchMode('visual')}
        >
          Визуальный режим
        </button>
        <button disabled={!state.canUndo} onClick={() => void controller.history()}>
          Отменить
        </button>
        <button disabled={!state.canRedo} onClick={() => void controller.history(true)}>
          Повторить
        </button>
        <button
          onClick={() =>
            void controller.format({ kind: 'set-inline', mark: 'strong', enabled: true })
          }
        >
          Жирный
        </button>
        <button
          onClick={() =>
            void controller.format({ kind: 'set-inline', mark: 'emphasis', enabled: true })
          }
        >
          Курсив
        </button>
        <button
          onClick={() =>
            void controller.format({ kind: 'set-inline', mark: 'strike', enabled: true })
          }
        >
          Зачёркнутый
        </button>
        <button onClick={() => void controller.format({ kind: 'set-heading', level: 2 })}>
          Заголовок 2
        </button>
        <button onClick={() => void controller.capture()}>Проверить снимок</button>
      </div>
      <div className="prototype-meta">
        <span data-testid="mode">{state.mode}</span> · Ревизии{' '}
        <span data-testid="revision">{state.revision}</span> · Выделение{' '}
        <span data-testid="selection">{JSON.stringify(state.selection)}</span>
        {state.composing && ' · Композиция'} · Разбор, мс:{' '}
        <span data-testid="parse-ms">{state.parseMs.toFixed(1)}</span> · Создание редактора, мс:{' '}
        <span data-testid="editor-ms">{state.editorMs.toFixed(1)}</span>
      </div>
      <div className="prototype-meta">
        Текстовых dispatch: <span data-testid="dispatches">{state.dispatches}</span>
      </div>
      {state.error && (
        <div role="alert">
          {state.error}
          {state.pending !== null && (
            <>
              <label>
                Неподтверждённый ввод
                <textarea aria-label="Неподтверждённый ввод" readOnly value={state.pending} />
              </label>
              <button onClick={() => controller.discardPending()}>
                Отбросить неподтверждённый ввод
              </button>
            </>
          )}
        </div>
      )}
      <div className="prototype-editor" ref={container} />
      {state.imageAlt !== null && (
        <div>
          <label>
            Описание изображения
            <input
              aria-label="Описание изображения"
              value={alt}
              onChange={(event) => setAlt(event.target.value)}
            />
          </label>
          <button
            onClick={() => void controller.format({ kind: 'replace-image-alt', insert: alt })}
          >
            Применить описание
          </button>
        </div>
      )}
      <details open>
        <summary>Точный исходник документа</summary>
        <textarea aria-label="Исходник документа" readOnly value={state.source} />
        <pre data-testid="source-json">{JSON.stringify(state.source)}</pre>
      </details>
      {state.captured !== null && (
        <label>
          Снимок после flush
          <textarea aria-label="Снимок после flush" readOnly value={state.captured} />
        </label>
      )}
      <details>
        <summary>Проверка конкурентного изменения</summary>
        <button onMouseDown={keepSelection} onClick={() => controller.externalEdit()}>
          Имитировать внешнюю правку
        </button>
        <button onMouseDown={keepSelection} onClick={() => controller.metadataEdit()}>
          Сменить BOM (тест)
        </button>
      </details>
    </section>
  );
}
