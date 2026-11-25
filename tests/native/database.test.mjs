import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openServiceDatabase, schemaVersion } from '../../src/platform/desktop/main/database.ts';

test('проверки выполняются нативным runtime Electron', () => {
  assert.ok(process.versions.electron);
  console.log(
    `Electron ${process.versions.electron}; Node ${process.versions.node}; ABI ${process.versions.modules}`,
  );
});

function fixture(t, beforeRemove = () => {}) {
  const folder = mkdtempSync(join(tmpdir(), 'neweditor-native-'));
  t.after(() => {
    beforeRemove();
    rmSync(folder, { recursive: true, force: true });
  });
  return join(folder, 'служебная база.sqlite');
}

test('миграция, повторное открытие, health, commit и rollback', (t) => {
  const path = fixture(t);
  const service = openServiceDatabase(path);
  assert.deepEqual(service.health(), { schemaVersion });
  assert.deepEqual(service.health(), { schemaVersion });
  service.close();
  service.close();
  const reopened = openServiceDatabase(path);
  assert.deepEqual(reopened.health(), { schemaVersion });
  reopened.close();
  const db = new Database(path);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), schemaVersion);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 2);
    db.exec('CREATE TABLE transaction_test (value TEXT NOT NULL)');
    db.transaction(() => db.prepare('INSERT INTO transaction_test VALUES (?)').run('commit'))();
    assert.throws(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO transaction_test VALUES (?)').run('rollback');
        throw new Error('прерывание');
      })(),
    );
    assert.deepEqual(db.prepare('SELECT value FROM transaction_test').all(), [{ value: 'commit' }]);
  } finally {
    db.close();
  }
});

test('более новая схема отклоняется без изменения данных', (t) => {
  const path = fixture(t);
  const db = new Database(path);
  db.pragma('user_version = 99');
  db.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('не менять')");
  db.close();
  assert.throws(() => openServiceDatabase(path), /новее/);
  const check = new Database(path);
  try {
    assert.equal(check.pragma('user_version', { simple: true }), 99);
    assert.deepEqual(check.prepare('SELECT value FROM preserved').all(), [{ value: 'не менять' }]);
  } finally {
    check.close();
  }
});

test('ошибка миграции не повышает версию схемы', (t) => {
  const path = fixture(t);
  const db = new Database(path);
  db.exec('CREATE TABLE schema_migrations (legacy TEXT)');
  db.close();
  assert.throws(() => openServiceDatabase(path));
  const check = new Database(path);
  try {
    assert.equal(check.pragma('user_version', { simple: true }), 0);
  } finally {
    check.close();
  }
});

function createV1(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 'bootstrap');
    PRAGMA user_version = 1;
    CREATE TABLE preserved (value TEXT);
    INSERT INTO preserved VALUES ('исходные данные');
  `);
  return db;
}

function migrated(t) {
  let db;
  const path = fixture(t, () => {
    if (db?.open) db.close();
  });
  openServiceDatabase(path).close();
  db = new Database(path);
  db.pragma('foreign_keys = ON');
  return { path, db };
}

function resource(db, id = 'resource', path = '/documents/text.txt') {
  db.prepare(
    `INSERT INTO local_resources
    (resource_id, canonical_path, document_id, format, next_version, created_at)
    VALUES (?, ?, 'document', 'txt', 1, 0)`,
  ).run(id, path);
}

test('v1 → v2 сохраняет существующие данные и применяется ровно один раз', (t) => {
  assert.equal(schemaVersion, 2);
  const path = fixture(t);
  createV1(path).close();
  const service = openServiceDatabase(path);
  assert.deepEqual(service.health(), { schemaVersion: 2 });
  service.close();
  openServiceDatabase(path).close();
  const db = new Database(path);
  try {
    assert.deepEqual(db.prepare('SELECT * FROM preserved').all(), [{ value: 'исходные данные' }]);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), [
      { version: 1, name: 'bootstrap' },
      { version: 2, name: 'local-persistence' },
    ]);
    for (const table of [
      'local_resources',
      'saved_versions',
      'save_operations',
      'draft_records',
      'draft_clearance',
    ])
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  } finally {
    db.close();
  }
});

test('сбой позднего SQL миграции v2 откатывает все её таблицы и номер версии', (t) => {
  const path = fixture(t);
  const original = createV1(path);
  original.exec(
    "CREATE TABLE draft_records (legacy TEXT); INSERT INTO draft_records VALUES ('не менять')",
  );
  original.close();
  assert.throws(() => openServiceDatabase(path), /already exists/);
  const check = new Database(path);
  try {
    assert.equal(check.pragma('user_version', { simple: true }), 1);
    assert.deepEqual(check.prepare('SELECT * FROM schema_migrations').all(), [
      { version: 1, name: 'bootstrap' },
    ]);
    assert.deepEqual(check.prepare('SELECT * FROM draft_records').all(), [{ legacy: 'не менять' }]);
    assert.equal(
      check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'local_resources'").get()
        .n,
      0,
    );
  } finally {
    check.close();
  }
});

test('некорректная запись v1 отвергается до применения миграции v2', (t) => {
  const path = fixture(t);
  const original = createV1(path);
  original.exec("UPDATE schema_migrations SET name = 'unknown'");
  original.close();
  assert.throws(() => openServiceDatabase(path), /некорректную схему/);
  const check = new Database(path);
  try {
    assert.equal(check.pragma('user_version', { simple: true }), 1);
    assert.equal(
      check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'local_resources'").get()
        .n,
      0,
    );
    assert.deepEqual(check.prepare('SELECT * FROM preserved').all(), [
      { value: 'исходные данные' },
    ]);
  } finally {
    check.close();
  }
});

test('объявленная v2 с отсутствующей таблицей не восстанавливается пустой автоматически', (t) => {
  const { db, path } = migrated(t);
  db.exec('DROP TABLE draft_records');
  assert.throws(() => openServiceDatabase(path), /no such table/);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'draft_records'").get().n,
    0,
  );
});

test('ресурсы, история и операции имеют FK, монотонные sequence и одну активную запись', (t) => {
  const { db } = migrated(t);
  resource(db);
  assert.throws(() => resource(db, 'other'), /UNIQUE/);
  resource(db, 'copy', '/documents/copy.txt'); // Один documentId может иметь несколько ресурсов.
  const version = db.prepare(`INSERT INTO saved_versions
    (version_id, resource_id, sequence, saved_at, origin, snapshot_json, content_hash)
    VALUES (?, ?, ?, 0, ?, ?, 'hash')`);
  version.run('v1', 'resource', 1, 'initial', '{}');
  assert.throws(() => version.run('v2', 'resource', 1, 'save', '{}'), /UNIQUE/);
  assert.throws(() => version.run('v3', 'missing', 1, 'save', '{}'), /FOREIGN KEY/);
  assert.throws(() => version.run('v4', 'resource', 0, 'save', '{}'), /CHECK/);
  assert.throws(() => version.run('v5', 'resource', 2, 'unknown', '{}'), /CHECK/);
  assert.throws(() => version.run('v6', 'resource', 2, 'save', 'broken JSON'), /CHECK/);
  const operation = db.prepare(`INSERT INTO save_operations
    (operation_id, resource_id, request_json, request_hash, phase, new_content_hash, created_at)
    VALUES (?, ?, '{}', 'request', ?, 'content', 0)`);
  operation.run('op1', 'resource', 'prepared');
  assert.throws(() => operation.run('op2', 'resource', 'replacing'), /UNIQUE/);
  assert.throws(() => operation.run('op3', 'missing', 'prepared'), /FOREIGN KEY/);
  assert.throws(() => operation.run('op4', 'copy', 'settled'), /CHECK/);
  assert.throws(() => operation.run('op5', 'copy', 'file-written'), /CHECK/);
  db.prepare(
    "UPDATE save_operations SET phase = 'settled', outcome_json = '{}' WHERE operation_id = 'op1'",
  ).run();
  operation.run('op2', 'resource', 'prepared');
  assert.throws(
    () => db.prepare("DELETE FROM local_resources WHERE resource_id = 'resource'").run(),
    /FOREIGN KEY/,
  );
});

test('история, журнал и независимая граница очистки черновика переживают переоткрытие', (t) => {
  const { path, db } = migrated(t);
  resource(db);
  db.prepare(
    "INSERT INTO saved_versions VALUES ('v1', 'resource', 1, 0, 'initial', '{}', 'hash')",
  ).run();
  db.prepare("INSERT INTO draft_records VALUES ('document', 'session', 7, '{}')").run();
  db.prepare("INSERT INTO draft_clearance VALUES ('document', 'session', 5)").run();
  db.prepare(
    `INSERT INTO save_operations
    (operation_id, resource_id, request_json, request_hash, phase, new_content_hash, created_at)
    VALUES ('op', 'resource', '{}', 'request', 'replacing', 'content', 0)`,
  ).run();
  assert.throws(
    () => db.prepare("INSERT INTO draft_records VALUES ('document', 'bad', -1, '{}')").run(),
    /CHECK/,
  );
  assert.throws(
    () => db.prepare("INSERT INTO draft_clearance VALUES ('document', 'bad', -1)").run(),
    /CHECK/,
  );
  db.close();
  const service = openServiceDatabase(path);
  assert.deepEqual(service.health(), { schemaVersion: 2 });
  service.close();
  const reopened = new Database(path);
  try {
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM saved_versions').get().n, 1);
    assert.equal(reopened.prepare('SELECT phase FROM save_operations').get().phase, 'replacing');
    assert.equal(
      reopened.prepare('SELECT state_revision FROM draft_records').get().state_revision,
      7,
    );
    assert.equal(
      reopened.prepare('SELECT through_revision FROM draft_clearance').get().through_revision,
      5,
    );
  } finally {
    reopened.close();
  }
});
