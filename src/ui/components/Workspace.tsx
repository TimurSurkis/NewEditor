import { useSyncExternalStore } from 'react';
import type { WorkspaceApplication } from '../../application';
import './Workspace.css';

export function Workspace({ workspace }: { readonly workspace: WorkspaceApplication }) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  return (
    <main className="workspace" aria-label="Документы">
      <div className="workspace-toolbar" aria-label="Команды документов">
        <button onClick={() => workspace.create('txt')}>Новый TXT</button>
        <button onClick={() => workspace.create('markdown')}>Новый Markdown</button>
        <button disabled={state.opening} onClick={() => void workspace.open()}>
          {state.opening ? 'Открытие…' : 'Открыть…'}
        </button>
      </div>
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
                  disabled={tab.closing}
                  title={`${tab.name} · ${tab.view.edit.document.location?.resourceId ?? 'Новый документ'}`}
                  onClick={() => workspace.select(tab.id)}
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
                    workspace.select(target.id);
                    document.getElementById(`tab-${target.id}`)?.focus();
                  }}
                >
                  {tab.name}
                  {tab.view.isDirty && <span aria-label="Есть несохранённые изменения"> ●</span>}
                </button>
                <button
                  aria-label={`Закрыть ${tab.name}`}
                  disabled={tab.closing}
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
                {active.view.edit.document.fileMetadata.bom ? ' · BOM' : ''} · Только чтение
                (редактирование — P5.2)
              </div>
              <pre aria-label="Исходный текст" tabIndex={0}>
                {active.view.edit.document.text}
              </pre>
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
