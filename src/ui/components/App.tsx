import { useEffect, useState } from 'react';
import type { Result } from '../../core';
import styles from './App.module.css';

interface Diagnostics {
  getAppInfo(): Promise<Result<{ readonly appVersion: string }, { readonly message: string }>>;
  getStorageHealth(): Promise<
    Result<{ readonly schemaVersion: number }, { readonly message: string }>
  >;
}

export function App({ diagnostics }: { readonly diagnostics: Diagnostics }) {
  const [status, setStatus] = useState('Проверка приложения…');
  const [failed, setFailed] = useState(false);
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
      <header className={styles.header}>NewEditor</header>
      <main className={styles.empty}>
        <h1>Нет открытых документов</h1>
        <p>Каркас приложения готов. Редактирование TXT и Markdown появится на следующих этапах.</p>
      </main>
      <footer className={styles.status} role={failed ? 'alert' : 'status'}>
        {status}
      </footer>
    </div>
  );
}
