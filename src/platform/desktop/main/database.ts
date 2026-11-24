import Database from 'better-sqlite3';

export const schemaVersion = 1;

export interface ServiceDatabase {
  health(): { readonly schemaVersion: number };
  close(): void;
}

export function openServiceDatabase(filePath: string): ServiceDatabase {
  const db = new Database(filePath);
  try {
    const current = db.pragma('user_version', { simple: true });
    if (typeof current !== 'number' || current > schemaVersion) {
      throw new Error('Версия служебной базы новее поддерживаемой');
    }
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (current === 0) {
      db.transaction(() => {
        db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)');
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
          1,
          'bootstrap',
        );
        db.pragma('user_version = 1');
      })();
    }
    const migration = db.prepare('SELECT name FROM schema_migrations WHERE version = ?').get(1);
    if (!migration || (migration as { name: unknown }).name !== 'bootstrap') {
      throw new Error('Служебная база имеет некорректную схему');
    }
    db.exec('CREATE TEMP TABLE health_probe (value TEXT NOT NULL)');
    const probe = db.transaction(() => {
      db.prepare('INSERT INTO health_probe (value) VALUES (?)').run('sqlite-ready');
      const row = db.prepare('SELECT value FROM health_probe').get() as
        { value: string } | undefined;
      if (row?.value !== 'sqlite-ready') throw new Error('Проверка SQLite не пройдена');
      db.prepare('DELETE FROM health_probe').run();
      return { schemaVersion };
    });
    return {
      health: () => probe(),
      close: () => {
        if (db.open) db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
