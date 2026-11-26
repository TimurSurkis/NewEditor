import { useEffect, useState } from 'react';
import type { Result } from '../../core';
import styles from './App.module.css';
import type { DocumentApplication, WorkspaceApplication } from '../../application';
import { MarkdownPrototype } from './MarkdownPrototype';
import { Workspace } from './Workspace';
import type { WorkspaceEditor } from '../editors/workspace-editor';

interface Diagnostics {
  getAppInfo(): Promise<Result<{ readonly appVersion: string }, { readonly message: string }>>;
  getStorageHealth(): Promise<
    Result<{ readonly schemaVersion: number }, { readonly message: string }>
  >;
}

export function App({
  diagnostics,
  application,
  workspace,
  editor,
}: {
  readonly diagnostics: Diagnostics;
  readonly application: DocumentApplication;
  readonly workspace: WorkspaceApplication;
  readonly editor: WorkspaceEditor;
}) {
  const [prototype, setPrototype] = useState(false);
  const [status, setStatus] = useState('Проверка приложения…');
  const [failed, setFailed] = useState(false);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([diagnostics.getAppInfo(), diagnostics.getStorageHealth()])
      .then(([info, storage]) => {
        if (!active) return;
        if (!info.ok || !storage.ok) {
          setFailed(true);
          setStatus(!info.ok ? info.error.message : !storage.ok ? storage.error.message : 'Ошибка');
          return;
        }
        setStatus(
          `Версия ${info.value.appVersion} · SQLite готова · схема ${storage.value.schemaVersion}`,
        );
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setStatus('Не удалось проверить приложение');
        }
      });
    return () => {
      active = false;
    };
  }, [diagnostics]);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        NewEditor{' '}
        <button
          disabled={switching}
          onClick={async () => {
            if (
              switching ||
              workspace.getSnapshot().transitioning ||
              workspace.getSnapshot().ending
            )
              return;
            setSwitching(true);
            try {
              const id = workspace.getSnapshot().activeId;
              if (!prototype && id) {
                const result = await editor.flush(id);
                if (!result.ok || workspace.getSnapshot().activeId !== id) return;
              }
              setPrototype(!prototype);
            } finally {
              setSwitching(false);
            }
          }}
        >
          {prototype ? 'Документы' : 'Прототип Markdown'}
        </button>
      </header>
      {prototype ? (
        <MarkdownPrototype application={application} />
      ) : (
        <Workspace workspace={workspace} editor={editor} />
      )}
      <footer className={styles.status} role={failed ? 'alert' : 'status'}>
        {status}
      </footer>
    </div>
  );
}
