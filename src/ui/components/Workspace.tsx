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
        if (event.defaultPrevented || !active) return;
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
        <button disabled={state.transitioning} onClick={() => void workspace.create('txt')}>
          Новый TXT
        </button>
        <button disabled={state.transitioning} onClick={() => void workspace.create('markdown')}>
          Новый Markdown
        </button>
        <button
          disabled={state.opening || state.transitioning}
          onClick={() => void workspace.open()}
        >
          {state.opening ? 'Открытие…' : 'Открыть…'}
        </button>
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
                  disabled={tab.closing || state.transitioning}
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
                  disabled={tab.closing || state.transitioning}
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
              </div>
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
