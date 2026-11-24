import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openServiceDatabase } from '../../src/platform/desktop/main/database.ts';

test('проверки выполняются нативным runtime Electron', () => {
  assert.ok(process.versions.electron);
  console.log(
    `Electron ${process.versions.electron}; Node ${process.versions.node}; ABI ${process.versions.modules}`,
  );
});

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'neweditor-native-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, 'служебная база.sqlite');
}

test('миграция, повторное открытие, health, commit и rollback', (t) => {
  const path = fixture(t);
  const service = openServiceDatabase(path);
  assert.deepEqual(service.health(), { schemaVersion: 1 });
  assert.deepEqual(service.health(), { schemaVersion: 1 });
  service.close();
  service.close();
  const reopened = openServiceDatabase(path);
  assert.deepEqual(reopened.health(), { schemaVersion: 1 });
  reopened.close();
  const db = new Database(path);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1);
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
