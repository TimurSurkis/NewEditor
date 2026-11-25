import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Result, StorageRef } from '../../src/core';
import type { PortError } from '../../src/ports';
import { openServiceDatabase } from '../../src/platform/desktop/main/database';
import { createLocalReadServices } from '../../src/platform/desktop/main/persistence/local-read-services';
import type { LocalReadOptions } from '../../src/platform/desktop/main/persistence/local-read-services';
import { createFileReader } from '../../src/platform/desktop/main/persistence/file-reader';

function value<T>(result: Result<T, PortError>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}

function code(result: Result<unknown, PortError>, expected: PortError['code']) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, expected);
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  t: TestContext,
  options: LocalReadOptions = {},
  content: string | Buffer = 'A😀Б\r\nе\u0308\rnext\n',
) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'neweditor-local-')));
  const path = join(folder, 'Документ с пробелами.MARKDOWN');
  const databasePath = join(folder, 'service.sqlite');
  await writeFile(path, content);
  const databases: ReturnType<typeof openServiceDatabase>[] = [];
  const openDatabase = () => {
    const database = openServiceDatabase(databasePath);
    databases.push(database);
    return database;
  };
  const database = openDatabase();
  const services = createLocalReadServices(database, options);
  const owner = {};
  const client = services.createClient(owner);
  t.after(async () => {
    client.close();
    for (const db of databases) db.close();
    await rm(folder, { recursive: true, force: true });
  });
  const count = (table: 'local_resources' | 'saved_versions') => {
    const row = database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    return row.n;
  };
  return { folder, path, database, openDatabase, services, owner, client, count };
}

test('реестр/ФС/репозитории выполняются настоящим runtime Electron', () => {
  assert.ok(process.versions.electron);
  console.log(
    `Local persistence: Electron ${process.versions.electron}, ABI ${process.versions.modules}`,
  );
});

test('повторные/параллельные регистрации и символьная ссылка дают один непрозрачный ref', async (t) => {
  const f = await fixture(t);
  const alias = join(f.folder, 'alias.md');
  await symlink(f.path, alias);
  const refs = (
    await Promise.all([
      f.client.registerPath(f.path, 'open'),
      f.client.registerPath(alias, 'open'),
      f.client.registerPath(f.path, 'save-target'),
    ])
  ).map(value);
  assert.deepEqual(refs[0], refs[1]);
  assert.deepEqual(refs[1], refs[2]);
  assert.equal(refs[0]?.storageId, 'local');
  assert.match(refs[0]!.resourceId, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(refs).includes(f.folder));
  assert.equal(f.count('local_resources'), 1);
  assert.equal(f.count('saved_versions'), 0);
  assert.equal(value(await f.client.documents.load(refs[0]!, null)).format, 'markdown');
});

test('первое load атомарно фиксирует исходную историю и метаданные, повтор/внешнее чтение не дублируют её', async (t) => {
  const f = await fixture(t, { now: () => 123 });
  const bytes = await readFile(f.path);
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const loaded = value(await f.client.documents.load(ref, null));
  assert.deepEqual(loaded.snapshot, {
    text: bytes.toString('utf8'),
    fileMetadata: { encoding: 'utf-8', bom: false },
  });
  const history = value(await f.client.history.list(ref, null));
  assert.equal(history.length, 1);
  assert.equal(history[0]?.savedAt, 123);
  assert.deepEqual(value(await f.client.history.read(ref, history[0]!.id, null)), loaded.snapshot);
  assert.deepEqual(await readFile(f.path), bytes);
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.snapshot.fileMetadata));
  assert.deepEqual(value(await f.client.documents.load(ref, null)), loaded);
  await writeFile(f.path, 'Внешняя редакция\r\n');
  const external = value(await f.client.documents.load(ref, null));
  assert.notEqual(external.storageRevision, loaded.storageRevision);
  assert.equal(external.documentId, loaded.documentId);
  assert.equal(external.snapshot.text, 'Внешняя редакция\r\n');
  assert.deepEqual(value(await f.client.history.list(ref, null)), history);
  assert.deepEqual(value(await f.client.history.read(ref, history[0]!.id, null)), loaded.snapshot);
  const row = f.database.connection.prepare('SELECT * FROM local_resources').get() as Record<
    string,
    unknown
  >;
  assert.equal(row['next_version'], 2);
  assert.equal(row['last_revision'], external.storageRevision);
  assert.equal(
    row['representation_json'],
    JSON.stringify({ version: 1, fileMetadata: { encoding: 'utf-8', bom: false } }),
  );
});

test('реестр/DocumentId/история переживают переоткрытие, права владельца — нет', async (t) => {
  const f = await fixture(t);
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const loaded = value(await f.client.documents.load(ref, null));
  const history = value(await f.client.history.list(ref, null));
  f.client.close();
  f.database.close();
  const reopened = createLocalReadServices(f.openDatabase()).createClient({});
  code(await reopened.documents.load(ref, null), 'permission-denied');
  code(await reopened.history.list(ref, null), 'permission-denied');
  assert.deepEqual(value(await reopened.registerPath(f.path, 'open')), ref);
  assert.deepEqual(value(await reopened.documents.load(ref, null)), loaded);
  assert.deepEqual(value(await reopened.history.list(ref, null)), history);
  reopened.close();
});

test('отсутствующая save-target не создаёт файл/историю и не создаёт родительские каталоги', async (t) => {
  const f = await fixture(t);
  const target = join(f.folder, 'Новый.txt');
  const ref = value(await f.client.registerPath(target, 'save-target'));
  code(await f.client.documents.load(ref, null), 'not-found');
  assert.deepEqual(value(await f.client.history.list(ref, null)), []);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  code(
    await f.client.registerPath(join(f.folder, 'нет каталога', 'новый.txt'), 'save-target'),
    'not-found',
  );
  code(await f.client.registerPath(join(f.folder, 'отсутствует.txt'), 'open'), 'not-found');
  assert.equal(f.count('local_resources'), 1);
  assert.equal(f.count('saved_versions'), 0);
});

test('неподходящий путь/каталог/расширение и dangling symlink отклоняются без истории', async (t) => {
  const f = await fixture(t);
  for (const path of ['', 'relative.txt', `${f.path}\0suffix`])
    code(await f.client.registerPath(path, 'open'), 'invalid-input');
  code(await f.client.registerPath(f.folder, 'open'), 'unsupported');
  const binary = join(f.folder, 'unsupported.bin');
  await writeFile(binary, 'data');
  code(await f.client.registerPath(binary, 'open'), 'unsupported');
  code(await f.client.registerPath(join(f.folder, 'new.bin'), 'save-target'), 'unsupported');
  const dangling = join(f.folder, 'dangling.txt');
  await symlink(join(f.folder, 'missing.txt'), dangling);
  code(await f.client.registerPath(dangling, 'save-target'), 'not-found');
  const directoryLink = join(f.folder, 'directory.txt');
  await symlink(f.folder, directoryLink);
  code(await f.client.registerPath(directoryLink, 'open'), 'unsupported');
  assert.equal(f.count('local_resources'), 0);
  assert.equal(f.count('saved_versions'), 0);
});

test(
  'FIFO не открывается и не блокирует регистрацию/reader',
  { skip: process.platform === 'win32', timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const fifo = join(f.folder, 'pipe.txt');
    execFileSync('mkfifo', [fifo]);
    code(await f.client.registerPath(fifo, 'open'), 'unsupported');
    code(await createFileReader()(fifo), 'unsupported');
  },
);

test('права разных владельцев изолированы, закрытие идемпотентно и не наследуется новым клиентом', async (t) => {
  const f = await fixture(t);
  assert.equal(createLocalReadServices(f.database), f.services);
  assert.equal(f.services.createClient(f.owner), f.client);
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const other = f.services.createClient({});
  code(await other.documents.load(ref, null), 'permission-denied');
  code(await other.history.list(ref, null), 'permission-denied');
  assert.deepEqual(value(await other.registerPath(f.path, 'open')), ref);
  f.client.close();
  f.client.close();
  code(await f.client.documents.load(ref, null), 'permission-denied');
  const next = f.services.createClient(f.owner);
  assert.notEqual(next, f.client);
  code(await next.documents.load(ref, null), 'permission-denied');
  value(await other.documents.load(ref, null));
  other.close();
  next.close();
});

test('load/история отклоняют неправильные ref/access/versionId без файлового ввода', async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    readFile: async (...args) => {
      reads++;
      return createFileReader()(...args);
    },
  });
  for (const ref of [null, {}, [], { storageId: 'local', resourceId: '' }])
    code(await f.client.documents.load(ref as StorageRef, null), 'invalid-input');
  code(
    await f.client.documents.load({ storageId: 'memory', resourceId: 'x' }, null),
    'unsupported',
  );
  code(
    await f.client.documents.load({ storageId: 'local', resourceId: 'unknown' }, null),
    'permission-denied',
  );
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const arrayRef = Object.assign([], ref);
  code(await f.client.documents.load(arrayRef, null), 'invalid-input');
  const inherited = Object.create(ref) as StorageRef;
  code(await f.client.documents.load(inherited, null), 'invalid-input');
  const accessor = Object.defineProperty({ resourceId: ref.resourceId }, 'storageId', {
    get() {
      assert.fail('Getter не должен исполняться на границе ref');
    },
  }) as StorageRef;
  code(await f.client.documents.load(accessor, null), 'invalid-input');
  code(await f.client.documents.load(ref, { token: 'lease', expiresAt: 1 }), 'unsupported');
  code(await f.client.history.read(ref, '', null), 'invalid-input');
  assert.equal(reads, 0);
});

test('close во время чтения отзывает и выполняемое, и ожидающее чтение до SQLite-фиксации', async (t) => {
  const entered = gate();
  const blocked = gate();
  const reader = createFileReader();
  const f = await fixture(t, {
    readFile: async (...args) => {
      entered.resolve();
      await blocked.promise;
      return reader(...args);
    },
  });
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const first = f.client.documents.load(ref, null);
  await entered.promise;
  const second = f.client.documents.load(ref, null);
  const history = f.client.history.list(ref, null);
  f.client.close();
  blocked.resolve();
  for (const result of await Promise.all([first, second, history]))
    code(result, 'permission-denied');
  assert.equal(f.count('saved_versions'), 0);
  const row = f.database.connection
    .prepare('SELECT representation_json, next_version FROM local_resources')
    .get();
  assert.deepEqual(row, { representation_json: null, next_version: 1 });
});

test('close до старта регистрации не создаёт строку и не выдаёт разрешение', async (t) => {
  const f = await fixture(t);
  const registering = f.client.registerPath(f.path, 'open');
  f.client.close();
  code(await registering, 'permission-denied');
  assert.equal(f.count('local_resources'), 0);
});

test('ref захватывается до первого await и не подменяется caller-объектом', async (t) => {
  const f = await fixture(t);
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const mutable = { ...ref };
  const pending = f.client.documents.load(mutable, null);
  mutable.resourceId = 'other';
  assert.deepEqual(value(await pending).ref, ref);
});

test('два владельца разделяют очередь ресурса, но независимый ресурс не ждёт', async (t) => {
  const entered = gate();
  const blocked = gate();
  const reader = createFileReader();
  let slow = '';
  let calls = 0;
  const f = await fixture(t, {
    readFile: async (path, hint) => {
      if (path === slow) {
        calls++;
        if (calls === 1) {
          entered.resolve();
          await blocked.promise;
        }
      }
      return reader(path, hint);
    },
  });
  slow = f.path;
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const other = f.services.createClient({});
  value(await other.registerPath(f.path, 'open'));
  const first = f.client.documents.load(ref, null);
  await entered.promise;
  const second = other.documents.load(ref, null);
  const independentPath = join(f.folder, 'other.txt');
  await writeFile(independentPath, 'independent');
  const independent = value(await other.registerPath(independentPath, 'open'));
  assert.equal(value(await other.documents.load(independent, null)).snapshot.text, 'independent');
  assert.equal(calls, 1);
  blocked.resolve();
  assert.deepEqual(value(await first), value(await second));
  assert.equal(calls, 2);
  assert.equal(value(await other.history.list(ref, null)).length, 1);
  other.close();
});

test('отказ SQLite после INSERT исходной версии откатывает и версию, и метаданные', async (t) => {
  const f = await fixture(t);
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const bytes = await readFile(f.path);
  f.database.connection.exec(`CREATE TRIGGER fail_read BEFORE UPDATE ON local_resources
    BEGIN SELECT RAISE(ABORT, 'test transaction boundary'); END`);
  code(await f.client.documents.load(ref, null), 'io-error');
  assert.equal(f.count('saved_versions'), 0);
  assert.deepEqual(
    f.database.connection
      .prepare('SELECT next_version, representation_json FROM local_resources')
      .get(),
    { next_version: 1, representation_json: null },
  );
  assert.deepEqual(await readFile(f.path), bytes);
  f.database.connection.exec('DROP TRIGGER fail_read');
  value(await f.client.documents.load(ref, null));
  assert.equal(f.count('saved_versions'), 1);
});

test('активный журнал блокирует load до метаданных/исходной истории, но не читает файл', async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    readFile: async (...args) => {
      reads++;
      return createFileReader()(...args);
    },
  });
  const ref = value(await f.client.registerPath(f.path, 'open'));
  f.database.connection
    .prepare(
      `INSERT INTO save_operations
    (operation_id, resource_id, request_json, request_hash, phase, new_content_hash, created_at)
    VALUES ('pending', ?, '{}', 'hash', 'replacing', 'hash', 0)`,
    )
    .run(ref.resourceId);
  code(await f.client.documents.load(ref, null), 'busy');
  assert.equal(reads, 0);
  assert.equal(f.count('saved_versions'), 0);
  assert.deepEqual(value(await f.client.history.list(ref, null)), []);
});

test('история остаётся доступной после удаления файла и не выдаёт версию другого ресурса', async (t) => {
  const f = await fixture(t);
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const loaded = value(await f.client.documents.load(ref, null));
  const versions = value(await f.client.history.list(ref, null));
  await rm(f.path);
  code(await f.client.documents.load(ref, null), 'not-found');
  assert.deepEqual(value(await f.client.history.list(ref, null)), versions);
  assert.deepEqual(value(await f.client.history.read(ref, versions[0]!.id, null)), loaded.snapshot);
  const another = value(await f.client.registerPath(join(f.folder, 'new.txt'), 'save-target'));
  code(await f.client.history.read(another, versions[0]!.id, null), 'not-found');
});

test('замена inode по тому же пути сохраняет ref/DocumentId, внешний rename не переносит историю', async (t) => {
  const f = await fixture(t);
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const loaded = value(await f.client.documents.load(ref, null));
  const replacement = join(f.folder, 'replacement.md');
  await writeFile(replacement, 'replacement');
  await rename(replacement, f.path);
  assert.deepEqual(value(await f.client.registerPath(f.path, 'open')), ref);
  const updated = value(await f.client.documents.load(ref, null));
  assert.equal(updated.documentId, loaded.documentId);
  assert.notEqual(updated.storageRevision, loaded.storageRevision);
  const renamed = join(f.folder, 'renamed.md');
  await rename(f.path, renamed);
  const newRef = value(await f.client.registerPath(renamed, 'open'));
  assert.notDeepEqual(newRef, ref);
  assert.notEqual(value(await f.client.documents.load(newRef, null)).documentId, loaded.documentId);
  assert.equal(value(await f.client.history.list(ref, null)).length, 1);
});

test('hard links читаются как отдельные пути без разрушения связи', async (t) => {
  const f = await fixture(t);
  const hard = join(f.folder, 'hard.md');
  await link(f.path, hard);
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const alias = value(await f.client.registerPath(hard, 'open'));
  assert.notDeepEqual(alias, ref);
  assert.deepEqual(
    value(await f.client.documents.load(ref, null)).snapshot,
    value(await f.client.documents.load(alias, null)).snapshot,
  );
});

test('подмена канонического родителя ссылкой не даёт load следовать к новой цели', async (t) => {
  const f = await fixture(t);
  const parent = join(f.folder, 'parent');
  const moved = join(f.folder, 'moved');
  const replacement = join(f.folder, 'replacement');
  await mkdir(parent);
  await mkdir(replacement);
  const path = join(parent, 'doc.txt');
  await writeFile(path, 'original');
  const ref = value(await f.client.registerPath(path, 'open'));
  await rename(parent, moved);
  await writeFile(join(replacement, 'doc.txt'), 'foreign');
  await symlink(replacement, parent);
  code(await f.client.documents.load(ref, null), 'busy');
  assert.equal(f.count('saved_versions'), 0);
  assert.equal(await readFile(join(replacement, 'doc.txt'), 'utf8'), 'foreign');
});

test('повреждённый/неподдерживаемый файл не создаёт исходную версию', async (t) => {
  for (const [bytes, expected] of [
    [Buffer.from([0x98]), 'encoding-error'],
    [Buffer.from('a\0b'), 'unsupported'],
  ] as const) {
    await t.test(expected, async (t) => {
      const f = await fixture(t, {}, bytes);
      const ref = value(await f.client.registerPath(f.path, 'open'));
      code(await f.client.documents.load(ref, null), expected);
      assert.equal(f.count('saved_versions'), 0);
      assert.deepEqual(await readFile(f.path), bytes);
    });
  }
});

test('достоверная подсказка сохраняет CP1251 ASCII и начальный обычный U+FEFF', async (t) => {
  const f = await fixture(t, {}, 'ASCII');
  const ref = value(await f.client.registerPath(f.path, 'open'));
  const update = f.database.connection.prepare(
    'UPDATE local_resources SET representation_json = ?, content_hash = ? WHERE resource_id = ?',
  );
  update.run(
    JSON.stringify({ version: 1, fileMetadata: { encoding: 'windows-1251', bom: false } }),
    createHash('sha256').update('ASCII').digest('hex'),
    ref.resourceId,
  );
  assert.equal(
    value(await f.client.documents.load(ref, null)).snapshot.fileMetadata.encoding,
    'windows-1251',
  );
  const content = '\uFEFFtext\r\n';
  await writeFile(f.path, content);
  update.run(
    JSON.stringify({ version: 1, fileMetadata: { encoding: 'utf-8', bom: false } }),
    createHash('sha256').update(content).digest('hex'),
    ref.resourceId,
  );
  assert.equal(value(await f.client.documents.load(ref, null)).snapshot.text, content);
  await writeFile(f.path, 'changed bytes');
  assert.equal(value(await f.client.documents.load(ref, null)).snapshot.text, 'changed bytes');
});

test('неизвестная версия/неверные типы representation JSON не перезаписываются загрузкой', async (t) => {
  for (const representation of [
    { version: 2, fileMetadata: { encoding: 'utf-8', bom: false } },
    { version: 1, fileMetadata: { encoding: 'windows-1251', bom: true } },
    { version: 1, fileMetadata: { encoding: 'utf-8', bom: 'false' } },
  ]) {
    await t.test(JSON.stringify(representation), async (t) => {
      const f = await fixture(t);
      const ref = value(await f.client.registerPath(f.path, 'open'));
      const payload = JSON.stringify(representation);
      f.database.connection
        .prepare('UPDATE local_resources SET representation_json = ?, content_hash = ?')
        .run(payload, '0'.repeat(64));
      code(await f.client.documents.load(ref, null), 'io-error');
      assert.deepEqual(
        f.database.connection.prepare('SELECT representation_json FROM local_resources').get(),
        { representation_json: payload },
      );
      assert.equal(f.count('saved_versions'), 0);
    });
  }
});

test('порча snapshot/hash истории даёт ошибку, не пустую/новую историю', async (t) => {
  for (const payload of [
    JSON.stringify({
      version: 2,
      snapshot: { text: 'text', fileMetadata: { encoding: 'utf-8', bom: false } },
    }),
    JSON.stringify({
      version: 1,
      snapshot: { text: '\uD800', fileMetadata: { encoding: 'utf-8', bom: false } },
    }),
    JSON.stringify({
      version: 1,
      snapshot: {
        text: 'иной текст с неверным hash',
        fileMetadata: { encoding: 'utf-8', bom: false },
      },
    }),
  ]) {
    await t.test(payload, async (t) => {
      const f = await fixture(t);
      const ref = value(await f.client.registerPath(f.path, 'open'));
      value(await f.client.documents.load(ref, null));
      const versions = value(await f.client.history.list(ref, null));
      f.database.connection.prepare('UPDATE saved_versions SET snapshot_json = ?').run(payload);
      code(await f.client.history.list(ref, null), 'io-error');
      code(await f.client.history.read(ref, versions[0]!.id, null), 'io-error');
      code(await f.client.documents.load(ref, null), 'io-error');
      assert.equal(f.count('saved_versions'), 1);
      assert.deepEqual(
        f.database.connection.prepare('SELECT snapshot_json FROM saved_versions').get(),
        { snapshot_json: payload },
      );
    });
  }
});

test('UTF-8 BOM и Windows-1251 читаются нативно без изменения байтов/переводов строк', async (t) => {
  for (const sample of [
    {
      bytes: Buffer.from('efbbbfd09fd180d0b8d0b2d0b5d1820d0a', 'hex'),
      text: 'Привет\r\n',
      metadata: { encoding: 'utf-8', bom: true },
    },
    {
      bytes: Buffer.from('cff0e8e2e5f20d0a', 'hex'),
      text: 'Привет\r\n',
      metadata: { encoding: 'windows-1251', bom: false },
    },
  ]) {
    await t.test(sample.metadata.encoding, async (t) => {
      const f = await fixture(t, {}, sample.bytes);
      const ref = value(await f.client.registerPath(f.path, 'open'));
      const loaded = value(await f.client.documents.load(ref, null));
      assert.deepEqual(loaded.snapshot, { text: sample.text, fileMetadata: sample.metadata });
      assert.deepEqual(await readFile(f.path), sample.bytes);
      const versions = value(await f.client.history.list(ref, null));
      assert.deepEqual(
        value(await f.client.history.read(ref, versions[0]!.id, null)),
        loaded.snapshot,
      );
    });
  }
});

test('реестр не делает безусловный lowercase и учитывает фактическую идентичность файловой системы', async (t) => {
  const f = await fixture(t);
  const upper = join(f.folder, 'CASE.txt');
  const lower = join(f.folder, 'case.txt');
  await writeFile(upper, 'upper');
  await writeFile(lower, 'lower');
  const upperRef = value(await f.client.registerPath(upper, 'open'));
  const lowerRef = value(await f.client.registerPath(lower, 'open'));
  const upperStat = await lstat(upper, { bigint: true });
  const lowerStat = await lstat(lower, { bigint: true });
  if (upperStat.dev === lowerStat.dev && upperStat.ino === lowerStat.ino) {
    assert.deepEqual(upperRef, lowerRef);
  } else {
    assert.notDeepEqual(upperRef, lowerRef);
    assert.equal(value(await f.client.documents.load(upperRef, null)).snapshot.text, 'upper');
    assert.equal(value(await f.client.documents.load(lowerRef, null)).snapshot.text, 'lower');
  }
});

test('чтение списка использует sequence, а не часы; ошибка времени не превращается в пустой список', async (t) => {
  const f = await fixture(t, { now: () => 100 });
  const ref = value(await f.client.registerPath(f.path, 'open'));
  value(await f.client.documents.load(ref, null));
  const snapshot = { text: 'вторая версия', fileMetadata: { encoding: 'utf-8', bom: false } };
  f.database.connection
    .prepare(
      `INSERT INTO saved_versions
    (version_id, resource_id, sequence, saved_at, origin, snapshot_json, content_hash)
    VALUES ('second', ?, 2, 1, 'save', ?, ?)`,
    )
    .run(
      ref.resourceId,
      JSON.stringify({ version: 1, snapshot }),
      createHash('sha256').update(snapshot.text).digest('hex'),
    );
  f.database.connection
    .prepare('UPDATE local_resources SET next_version = 3 WHERE resource_id = ?')
    .run(ref.resourceId);
  const versions = value(await f.client.history.list(ref, null));
  assert.equal(versions[0]?.id, 'second');
  assert.equal(versions[1]?.savedAt, 100);
  assert.deepEqual(value(await f.client.history.read(ref, 'second', null)), snapshot);
  f.database.connection
    .prepare("UPDATE saved_versions SET saved_at = 9007199254740992 WHERE version_id = 'second'")
    .run();
  code(await f.client.history.list(ref, null), 'io-error');
  code(await f.client.history.read(ref, 'second', null), 'io-error');
  code(await f.client.documents.load(ref, null), 'io-error');
  assert.equal(f.count('saved_versions'), 2);
});
