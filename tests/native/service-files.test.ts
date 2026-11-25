import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { openServiceDatabase } from '../../src/platform/desktop/main/database';
import { prepareServiceProfile } from '../../src/platform/desktop/main/service-files';

const posix = process.platform !== 'win32';
function folder(t: TestContext) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'neweditor-private-')));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
test(
  'POSIX: umask 000 не раскрывает профиль, SQLite/WAL/SHM и не меняется глобально',
  { skip: !posix },
  (t) => {
    assert.ok(process.versions.electron);
    const parent = folder(t),
      profile = join(parent, 'profile'),
      mask = process.umask(0);
    let database: ReturnType<typeof openServiceDatabase> | undefined;
    try {
      prepareServiceProfile(profile);
      const path = join(profile, 'service.sqlite');
      database = openServiceDatabase(path);
      assert.equal(lstatSync(profile).mode & 0o777, 0o700);
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        assert.ok(existsSync(file));
        assert.equal(lstatSync(file).mode & 0o777, 0o600);
      }
      assert.equal(process.umask(), 0);
    } finally {
      database?.close();
      process.umask(mask);
    }
  },
);

test(
  'POSIX: старые широкие права сужаются без изменения сохранённых данных',
  { skip: !posix },
  (t) => {
    const profile = folder(t),
      path = join(profile, 'service.sqlite');
    const first = openServiceDatabase(path);
    first.connection.exec(
      "CREATE TABLE preserved (text TEXT); INSERT INTO preserved VALUES ('секрет😀');",
    );
    first.close();
    const keeper = new Database(path);
    keeper.pragma('journal_mode = WAL');
    keeper.prepare('SELECT * FROM preserved').all();
    try {
      chmodSync(profile, 0o755);
      for (const file of [path, `${path}-wal`, `${path}-shm`])
        if (existsSync(file)) chmodSync(file, 0o666);
      assert.throws(() => openServiceDatabase(path), /приватного/);
      prepareServiceProfile(profile);
      const reopened = openServiceDatabase(path);
      try {
        assert.deepEqual(reopened.connection.prepare('SELECT * FROM preserved').all(), [
          { text: 'секрет😀' },
        ]);
        for (const file of [path, `${path}-wal`, `${path}-shm`])
          assert.equal(lstatSync(file).mode & 0o777, 0o600);
      } finally {
        reopened.close();
      }
    } finally {
      keeper.close();
    }
  },
);

test('POSIX: профиль-ссылка не меняет права целевого каталога', { skip: !posix }, (t) => {
  const parent = folder(t),
    target = join(parent, 'target'),
    alias = join(parent, 'alias');
  mkdirSync(target);
  chmodSync(target, 0o755);
  symlinkSync(target, alias);
  assert.throws(() => prepareServiceProfile(alias), /Небезопасный/);
  assert.equal(lstatSync(target).mode & 0o777, 0o755);
});

test(
  'POSIX: ссылки БД/sidecars отклоняются до SQLite, чужая цель не меняется',
  { skip: !posix },
  async (t) => {
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      await t.test(suffix || 'database', (t) => {
        const profile = folder(t),
          path = join(profile, 'service.sqlite'),
          target = join(profile, 'target');
        if (suffix) {
          const database = openServiceDatabase(path);
          database.close();
        }
        writeFileSync(target, 'чужие данные', { mode: 0o644 });
        symlinkSync(target, path + suffix);
        const before = suffix ? readFileSync(path) : null;
        assert.throws(() => openServiceDatabase(path), /Небезопасный/);
        assert.equal(readFileSync(target, 'utf8'), 'чужие данные');
        assert.equal(lstatSync(target).mode & 0o777, 0o644);
        if (before) assert.deepEqual(readFileSync(path), before);
        assert.ok(lstatSync(path + suffix).isSymbolicLink());
      });
  },
);

test('POSIX: hard link и FIFO БД не открываются и не меняются', { skip: !posix }, (t) => {
  const profile = folder(t),
    path = join(profile, 'service.sqlite'),
    alias = join(profile, 'alias');
  writeFileSync(path, 'not a database', { mode: 0o644 });
  linkSync(path, alias);
  assert.throws(() => openServiceDatabase(path), /Небезопасный/);
  assert.equal(lstatSync(path).mode & 0o777, 0o644);
  assert.equal(readFileSync(alias, 'utf8'), 'not a database');
  rmSync(path);
  execFileSync('mkfifo', [path]);
  assert.throws(() => openServiceDatabase(path), /Небезопасный/);
  assert.ok(lstatSync(path).isFIFO());
});
