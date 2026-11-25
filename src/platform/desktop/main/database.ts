import Database from 'better-sqlite3';

export const schemaVersion = 2;

const migrations = [
  {
    version: 1,
    name: 'bootstrap',
    sql: 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)',
  },
  {
    version: 2,
    name: 'local-persistence',
    sql: `
      CREATE TABLE local_resources (
        resource_id TEXT PRIMARY KEY NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        document_id TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('txt', 'markdown')),
        representation_json TEXT CHECK (representation_json IS NULL OR json_valid(representation_json)),
        content_hash TEXT,
        last_revision TEXT,
        next_version INTEGER NOT NULL CHECK (next_version > 0),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE saved_versions (
        version_id TEXT PRIMARY KEY NOT NULL,
        resource_id TEXT NOT NULL REFERENCES local_resources(resource_id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        saved_at INTEGER NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('initial', 'before-overwrite', 'save')),
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        content_hash TEXT NOT NULL,
        UNIQUE (resource_id, sequence)
      ) STRICT;
      CREATE INDEX saved_versions_order ON saved_versions(resource_id, sequence DESC);
      CREATE TABLE save_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        resource_id TEXT NOT NULL REFERENCES local_resources(resource_id),
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        request_hash TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('prepared', 'replacing', 'file-written', 'settled', 'needs-attention')),
        old_revision TEXT,
        old_snapshot_json TEXT CHECK (old_snapshot_json IS NULL OR json_valid(old_snapshot_json)),
        new_content_hash TEXT NOT NULL,
        temp_name TEXT,
        receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
        outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
        created_at INTEGER NOT NULL,
        CHECK (phase <> 'settled' OR outcome_json IS NOT NULL),
        CHECK (phase <> 'file-written' OR receipt_json IS NOT NULL)
      ) STRICT;
      CREATE INDEX save_operations_resource ON save_operations(resource_id, phase);
      CREATE UNIQUE INDEX save_operations_active ON save_operations(resource_id) WHERE phase <> 'settled';
      CREATE TABLE draft_records (
        document_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        PRIMARY KEY (document_id, session_id)
      ) STRICT;
      CREATE TABLE draft_clearance (
        document_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        through_revision INTEGER NOT NULL CHECK (through_revision >= 0),
        PRIMARY KEY (document_id, session_id)
      ) STRICT;
    `,
  },
] as const;

function validateMigrations(db: Database.Database, through: number): void {
  const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  if (
    rows.length !== through ||
    rows.some((row, index) => {
      const migration = migrations[index];
      const value = row as { version: unknown; name: unknown };
      return !migration || value.version !== migration.version || value.name !== migration.name;
    })
  )
    throw new Error('Служебная база имеет некорректную схему');
}

export interface ServiceDatabase {
  health(): { readonly schemaVersion: number };
  close(): void;
}

export function openServiceDatabase(filePath: string): ServiceDatabase {
  const db = new Database(filePath);
  try {
    const current = db.pragma('user_version', { simple: true });
    if (
      typeof current !== 'number' ||
      !Number.isSafeInteger(current) ||
      current < 0 ||
      current > schemaVersion
    ) {
      throw new Error('Версия служебной базы новее поддерживаемой');
    }
    if (current > 0) validateMigrations(db, current);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
          migration.version,
          migration.name,
        );
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
    validateMigrations(db, schemaVersion);
    // Проверяем наличие всех столбцов до выдачи соединения сервисам.
    db.prepare(
      'SELECT resource_id, canonical_path, document_id, format, representation_json, content_hash, last_revision, next_version, created_at FROM local_resources LIMIT 0',
    ).all();
    db.prepare(
      'SELECT version_id, resource_id, sequence, saved_at, origin, snapshot_json, content_hash FROM saved_versions LIMIT 0',
    ).all();
    db.prepare(
      'SELECT operation_id, resource_id, request_json, request_hash, phase, old_revision, old_snapshot_json, new_content_hash, temp_name, receipt_json, outcome_json, created_at FROM save_operations LIMIT 0',
    ).all();
    db.prepare(
      'SELECT document_id, session_id, state_revision, record_json FROM draft_records LIMIT 0',
    ).all();
    db.prepare(
      'SELECT document_id, session_id, through_revision FROM draft_clearance LIMIT 0',
    ).all();
    db.exec('CREATE TEMP TABLE health_probe (value TEXT NOT NULL)');
    const probe = db.transaction(() => {
      if (
        db.pragma('synchronous', { simple: true }) !== 2 ||
        db.pragma('foreign_keys', { simple: true }) !== 1 ||
        db.pragma('busy_timeout', { simple: true }) !== 5000
      )
        throw new Error('Небезопасные параметры служебной SQLite');
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
