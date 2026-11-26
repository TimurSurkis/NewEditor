import { useSyncExternalStore } from 'react';
import type { WorkspaceApplication } from '../../application';
import './Workspace.css';
import type { WorkspaceEditor } from '../editors/workspace-editor';
import { SourcePanel } from './SourcePanel';

export function Workspace({
  workspace,
  editor,
}: {
  readonly workspace: WorkspaceApplication;
  readonly editor: WorkspaceEditor;
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  return (
    <main
      className="workspace"
      aria-label="Документы"
      onKeyDown={(event) => {
        if (event.defaultPrevented || !active || state.ending) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (event.key.toLowerCase() === 's' || event.code === 'KeyS')
        ) {
          event.preventDefault();
          void workspace.save(active.id, event.shiftKey);
          return;
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (['f', 'h'].includes(event.key.toLowerCase()) || ['KeyF', 'KeyH'].includes(event.code))
        ) {
          event.preventDefault();
          editor.setSearch(active.id, { searchOpen: true });
          event.currentTarget
            .querySelector<HTMLTextAreaElement>('textarea[aria-label="Найти"]')
            ?.focus();
        } else if (event.key === 'F3') {
          event.preventDefault();
          void editor.find(active.id, event.shiftKey);
        }
      }}
    >
      <div className="workspace-toolbar" aria-label="Команды документов">
        <button
          disabled={state.transitioning || state.ending}
          onClick={() => void workspace.create('txt')}
        >
          Новый TXT
        </button>
        <button
          disabled={state.transitioning || state.ending}
          onClick={() => void workspace.create('markdown')}
        >
          Новый Markdown
        </button>
        <button
          disabled={state.opening || state.transitioning || state.ending}
          onClick={() => void workspace.open()}
        >
          {state.opening ? 'Открытие…' : 'Открыть…'}
        </button>
        {active && (
          <>
            <button
              disabled={
                active.saving ||
                active.closing ||
                state.ending ||
                state.transitioning ||
                ['unknown', 'history-pending'].includes(active.view.save.kind)
              }
              onClick={() => void workspace.save(active.id)}
            >
              Сохранить
            </button>
            <button
              disabled={
                active.saving ||
                active.closing ||
                state.ending ||
                state.transitioning ||
                ['unknown', 'history-pending'].includes(active.view.save.kind)
              }
              onClick={() => void workspace.save(active.id, true)}
            >
              Сохранить как…
            </button>
            {['unknown', 'history-pending'].includes(active.view.save.kind) && (
              <button onClick={() => void workspace.reconcile(active.id)}>
                Проверить сохранение
              </button>
            )}
          </>
        )}
      </div>
      {state.transitioning && <p role="status">Ожидание подтверждения ввода…</p>}
      {state.errors.length > 0 && (
        <section role="alert" className="workspace-errors">
          <ul>
            {state.errors.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
          <button onClick={workspace.clearErrors}>Скрыть ошибки</button>
        </section>
      )}
      {state.tabs.length > 0 ? (
        <>
          <div role="tablist" aria-label="Вкладки документов" className="workspace-tabs">
            {state.tabs.map((tab, index) => (
              <div className="workspace-tab" key={tab.id}>
                <button
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={tab.id === state.activeId}
                  aria-controls={`panel-${tab.id}`}
                  tabIndex={tab.id === state.activeId ? 0 : -1}
                  disabled={tab.closing || state.transitioning || state.ending}
                  title={`${tab.name} · ${tab.view.edit.document.location?.resourceId ?? 'Новый документ'}`}
                  onClick={() => void workspace.select(tab.id)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === 'ArrowRight'
                        ? (index + 1) % state.tabs.length
                        : event.key === 'ArrowLeft'
                          ? (index + state.tabs.length - 1) % state.tabs.length
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? state.tabs.length - 1
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    const target = state.tabs[next]!;
                    void workspace.select(target.id);
                    document.getElementById(`tab-${target.id}`)?.focus();
                  }}
                >
                  {tab.name}
                  {tab.view.isDirty && <span aria-label="Есть несохранённые изменения"> ●</span>}
                </button>
                <button
                  aria-label={`Закрыть ${tab.name}`}
                  disabled={tab.closing || tab.saving || state.transitioning || state.ending}
                  onClick={() => void workspace.close(tab.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {active && (
            <section
              role="tabpanel"
              id={`panel-${active.id}`}
              aria-labelledby={`tab-${active.id}`}
              className="workspace-panel"
            >
              <div className="workspace-metadata">
                {active.view.edit.document.format === 'txt' ? 'TXT' : 'Markdown'} ·{' '}
                {active.view.edit.document.fileMetadata.encoding}
                {active.view.edit.document.fileMetadata.bom ? ' · BOM' : ''} · Исходный режим
                <label>
                  Кодировка
                  <select
                    aria-label="Кодировка"
                    value={active.view.edit.document.fileMetadata.encoding}
                    disabled={active.closing || state.ending}
                    onChange={(event) =>
                      void editor.changeMetadata(active.id, {
                        encoding: event.target.value === 'windows-1251' ? 'windows-1251' : 'utf-8',
                        bom:
                          event.target.value === 'windows-1251'
                            ? false
                            : active.view.edit.document.fileMetadata.bom,
                      })
                    }
                  >
                    <option value="utf-8">UTF-8</option>
                    <option value="windows-1251">Windows-1251</option>
                  </select>
                </label>
                <label>
                  <input
                    aria-label="UTF-8 BOM"
                    type="checkbox"
                    checked={active.view.edit.document.fileMetadata.bom}
                    disabled={
                      active.closing ||
                      state.ending ||
                      active.view.edit.document.fileMetadata.encoding !== 'utf-8'
                    }
                    onChange={(event) =>
                      void editor.changeMetadata(active.id, {
                        encoding: 'utf-8',
                        bom: event.target.checked,
                      })
                    }
                  />
                  UTF-8 BOM
                </label>
              </div>
              <p data-testid="save-state">
                {active.saving
                  ? 'Сохранение…'
                  : active.view.save.kind === 'unknown'
                    ? 'Исход записи неизвестен — проверьте сохранение'
                    : active.view.save.kind === 'history-pending'
                      ? 'Файл записан; история ожидает завершения'
                      : active.view.save.kind === 'failed'
                        ? `Файл не записан: ${active.view.save.error.message}`
                        : active.view.conflict.kind !== 'none'
                          ? 'Конфликт: исходный файл изменён или удалён'
                          : active.view.isDirty
                            ? 'Есть несохранённые изменения'
                            : active.view.edit.document.location
                              ? 'Сохранено'
                              : 'Новый документ'}
              </p>
              {active.view.draftError && (
                <p role="alert">
                  Файл и очистка черновика — отдельные результаты: {active.view.draftError.message}
                </p>
              )}
              <SourcePanel key={active.id} id={active.id} editor={editor} />
            </section>
          )}
        </>
      ) : (
        <section className="workspace-empty">
          <h1>Нет открытых документов</h1>
          <p>Создайте TXT или Markdown либо откройте локальный файл.</p>
        </section>
      )}
    </main>
  );
}
