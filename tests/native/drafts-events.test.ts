import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Result } from '../../src/core';
import type { DraftRecord, PortError, ResourceEvent, SaveRequest } from '../../src/ports';
import { openServiceDatabase } from '../../src/platform/desktop/main/database';
import { createLocalServices } from '../../src/platform/desktop/main/persistence/local-services';
import type { LocalOptions } from '../../src/platform/desktop/main/persistence/local-services';
import { createFileWriter } from '../../src/platform/desktop/main/persistence/file-writer';
import { createWatchSignals } from '../../src/platform/desktop/main/persistence/resource-observer';
import { ManualSignals } from '../helpers/watch-signals';

function value<T>(result: Result<T, PortError>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}
function code(result: Result<unknown, PortError>, expected: PortError['code']) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, expected);
}
function draft(stateRevision = 1): DraftRecord {
  return {
    key: { documentId: 'document', sessionId: 'session' },
    format: 'txt',
    location: null,
    snapshot: { text: '😀\0\r\nе\u0308', fileMetadata: { encoding: 'windows-1251', bom: false } },
    baseline: { text: 'baseline\r', fileMetadata: { encoding: 'utf-8', bom: true } },
    baseStorageRevision: null,
    stateRevision,
  };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, options: LocalOptions = {}) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'neweditor-drafts-events-')));
  const path = join(folder, 'Документ.txt'),
    databasePath = join(folder, 'service.sqlite');
  await writeFile(path, 'initial');
  const database = openServiceDatabase(databasePath),
    signals = new ManualSignals();
  const services = createLocalServices(database, { signals, ...options });
  const databases = [database],
    stores = [services];
  value(await services.ready);
  const client = services.createClient({});
  t.after(async () => {
    for (const store of stores) store.close();
    for (const db of databases) db.close();
    await rm(folder, { recursive: true, force: true });
  });
  const ref = value(await client.registerPath(path, 'open'));
  const loaded = value(await client.documents.load(ref, null));
  const request = (text = 'ours', operationId = 'operation'): SaveRequest => ({
    operationId,
    documentId: loaded.documentId,
    format: 'txt',
    target: { ref, expectedRevision: loaded.storageRevision },
    snapshot: { text, fileMetadata: { encoding: 'utf-8', bom: false } },
    access: null,
  });
  const events: ResourceEvent[] = [],
    errors: PortError[] = [];
  const watch = () =>
    client.events.watch(
      ref,
      (event) => events.push(event),
      (error) => errors.push(error),
    );
  const refresh = () => client.refreshResources();
  const reopen = () => {
    const db = openServiceDatabase(databasePath),
      store = createLocalServices(db);
    databases.push(db);
    stores.push(store);
    return { database: db, services: store };
  };
  return {
    folder,
    path,
    databasePath,
    database,
    signals,
    services,
    client,
    ref,
    loaded,
    request,
    events,
    errors,
    watch,
    refresh,
    reopen,
  };
}

test('черновик хранит полный Unicode/NUL без кодека, файла и версий; равная ревизия канонична', async (t) => {
  const f = await fixture(t),
    record = draft();
  const before = await readFile(f.path),
    history = value(await f.client.history.list(f.ref, null));
  assert.deepEqual(value(await f.client.drafts.put(record)), { accepted: true });
  const reordered = {
    stateRevision: 1,
    baseStorageRevision: null,
    baseline: { fileMetadata: { bom: true, encoding: 'utf-8' as const }, text: 'baseline\r' },
    snapshot: {
      fileMetadata: { bom: false, encoding: 'windows-1251' as const },
      text: record.snapshot.text,
    },
    location: null,
    format: 'txt' as const,
    key: { sessionId: 'session', documentId: 'document' },
  };
  assert.deepEqual(value(await f.client.drafts.put(reordered)), { accepted: true });
  code(
    await f.client.drafts.put({ ...record, baseline: { ...record.baseline, text: 'different' } }),
    'invalid-input',
  );
  assert.deepEqual(value(await f.client.drafts.list()), [record]);
  assert.deepEqual(await readFile(f.path), before);
  assert.deepEqual(value(await f.client.history.list(f.ref, null)), history);
  const row = f.database.connection.prepare('SELECT record_json FROM draft_records').get() as {
    record_json: string;
  };
  assert.deepEqual(JSON.parse(row.record_json), { version: 1, record });
});

test('put/removeThrough монотонны, сохраняют более новый текст и изолируют сессии', async (t) => {
  const f = await fixture(t);
  value(await f.client.drafts.put(draft(5)));
  assert.deepEqual(value(await f.client.drafts.put(draft(4))), { accepted: false });
  value(await f.client.drafts.removeThrough(draft().key, 3));
  value(await f.client.drafts.removeThrough(draft().key, 1));
  assert.deepEqual(value(await f.client.drafts.list()), [draft(5)]);
  const other = { ...draft(5), key: { ...draft().key, sessionId: 'other' } };
  value(await f.client.drafts.put(other));
  value(await f.client.drafts.removeThrough(draft().key, 5));
  assert.deepEqual(value(await f.client.drafts.list()), [other]);
  assert.deepEqual(value(await f.client.drafts.put(draft(5))), { accepted: false });
  value(await f.client.drafts.put(draft(6)));
  assert.equal(value(await f.client.drafts.list()).length, 2);
});

test('ошибка DELETE откатывает и clearance, и запись; после повтора старый put не воскресает', async (t) => {
  const f = await fixture(t);
  value(await f.client.drafts.put(draft(2)));
  f.database.connection.exec(
    "CREATE TRIGGER fail_draft_delete BEFORE DELETE ON draft_records BEGIN SELECT RAISE(ABORT, 'test'); END;",
  );
  code(await f.client.drafts.removeThrough(draft().key, 2), 'io-error');
  assert.deepEqual(value(await f.client.drafts.list()), [draft(2)]);
  assert.equal(f.database.connection.prepare('SELECT * FROM draft_clearance').all().length, 0);
  f.database.connection.exec('DROP TRIGGER fail_draft_delete');
  value(await f.client.drafts.removeThrough(draft().key, 2));
  assert.deepEqual(value(await f.client.drafts.put(draft(2))), { accepted: false });
});

test('ключи/DTO захватываются до await; немедленное закрытие отменяет ожидающий put', async (t) => {
  const f = await fixture(t),
    input = draft();
  const promise = f.client.drafts.put(input);
  Object.assign(input.key, { sessionId: 'mutated' });
  Object.assign(input.snapshot, { text: 'mutated' });
  value(await promise);
  assert.deepEqual(value(await f.client.drafts.list()), [draft()]);
  const next = f.client.drafts.put(draft(2));
  f.client.close();
  code(await next, 'permission-denied');
  assert.deepEqual(value(await f.services.listRecoverableDrafts()), [draft()]);
});

test('чужой владелец не видит/не захватывает persisted ключ; main recovery не выдаёт файл', async (t) => {
  const f = await fixture(t),
    other = f.services.createClient({});
  const record = { ...draft(), location: f.ref, baseStorageRevision: f.loaded.storageRevision };
  value(await f.client.drafts.put(record));
  assert.deepEqual(value(await other.drafts.list()), []);
  code(await other.drafts.put(record), 'permission-denied');
  code(await other.drafts.removeThrough(record.key, 10), 'permission-denied');
  code(await other.recoverDraft(record.key), 'busy');
  assert.deepEqual(value(await f.services.listRecoverableDrafts()), []);
  f.client.close();
  code(await other.drafts.put({ ...record, location: null }), 'permission-denied');
  value(await other.recoverDraft(record.key));
  assert.deepEqual(value(await other.drafts.list()), [record]);
  code(await other.documents.load(f.ref, null), 'permission-denied');
  value(await other.drafts.put({ ...record, stateRevision: 2 }));
  code(
    await other.drafts.put({
      ...record,
      stateRevision: 3,
      location: { storageId: 'local', resourceId: 'ungranted' },
    }),
    'permission-denied',
  );
});

test('records и clearance переживают перезапуск без наследования полномочий', async (t) => {
  const f = await fixture(t);
  value(await f.client.drafts.put(draft(3)));
  const cleared = { ...draft(1), key: { documentId: 'cleared', sessionId: 'session' } };
  value(await f.client.drafts.removeThrough(cleared.key, 5));
  f.services.close();
  f.database.close();
  const { services } = f.reopen();
  const client = services.createClient({});
  assert.deepEqual(value(await services.listRecoverableDrafts()), [draft(3)]);
  assert.deepEqual(value(await client.drafts.list()), []);
  code(await client.drafts.put(draft(4)), 'permission-denied');
  code(await client.drafts.put(cleared), 'permission-denied');
  value(await client.recoverDraft(draft().key));
  value(await client.drafts.removeThrough(draft().key, 2));
  assert.deepEqual(value(await client.drafts.list()), [draft(3)]);
});

test('неизвестная версия/несогласованные колонки черновика не удаляются и не заменяются', async (t) => {
  for (const broken of [
    { version: 2, record: draft() },
    { version: 1, record: draft(99) },
  ])
    await t.test(JSON.stringify(broken), async (t) => {
      const f = await fixture(t);
      value(await f.client.drafts.put(draft()));
      const json = JSON.stringify(broken);
      f.database.connection.prepare('UPDATE draft_records SET record_json = ?').run(json);
      code(await f.client.drafts.list(), 'io-error');
      code(await f.client.drafts.removeThrough(draft().key, 100), 'io-error');
      code(await f.client.drafts.put(draft(2)), 'io-error');
      assert.equal(
        (
          f.database.connection.prepare('SELECT record_json FROM draft_records').get() as {
            record_json: string;
          }
        ).record_json,
        json,
      );
    });
});

test('более новый черновик во время принятого save не очищается подтверждением старого снимка', async (t) => {
  const io = createFileWriter(),
    entered = gate(),
    release = gate();
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async prepare(...args) {
        entered.resolve();
        await release.promise;
        return io.prepare(...args);
      },
    },
  });
  t.after(() => release.resolve());
  value(await f.client.drafts.put(draft(1)));
  const pending = f.client.documents.save(f.request());
  await entered.promise;
  value(await f.client.drafts.put(draft(2)));
  release.resolve();
  assert.equal((await pending).kind, 'saved');
  value(await f.client.drafts.removeThrough(draft().key, 1));
  assert.deepEqual(value(await f.client.drafts.list()), [draft(2)]);
});

test('собственная запись подавляется только для автора; cached receipt не откатывает наблюдение', async (t) => {
  const f = await fixture(t),
    other = f.services.createClient({});
  value(await other.registerPath(f.path, 'open'));
  value(await other.documents.load(f.ref, null));
  const events: ResourceEvent[] = [];
  other.events.watch(
    f.ref,
    (event) => events.push(event),
    (error) => assert.fail(JSON.stringify(error)),
  );
  f.watch();
  await f.refresh();
  await other.refreshResources();
  assert.equal((await f.client.documents.save(f.request())).kind, 'saved');
  await f.refresh();
  assert.deepEqual(f.events, []);
  assert.equal(events.length, 1);
  await writeFile(f.path, 'external');
  await f.refresh();
  assert.equal(f.events.length, 1);
  assert.equal(events.length, 2);
  assert.equal((await f.client.documents.save(f.request())).kind, 'saved');
  await f.refresh();
  assert.equal(f.events.length, 1);
  assert.equal(events.length, 2);
  assert.deepEqual(f.errors, []);
});

test('чужой save между load и watch не теряется из-за глобальной ревизии реестра', async (t) => {
  const f = await fixture(t),
    other = f.services.createClient({});
  value(await other.registerPath(f.path, 'open'));
  assert.equal((await other.documents.save(f.request())).kind, 'saved');
  f.watch();
  await f.refresh();
  assert.deepEqual(
    f.events.map((event) => event.kind),
    ['changed'],
  );
});

test('byte probe замечает неподдерживаемый текст, удаление/создание и не выдаёт каталог за deleted', async (t) => {
  const f = await fixture(t);
  f.watch();
  await f.refresh();
  await writeFile(f.path, Buffer.from([0xff, 0xfe, 0x00, 0x00]));
  await f.refresh();
  assert.deepEqual(
    f.events.map((event) => event.kind),
    ['changed'],
  );
  code(await f.client.documents.load(f.ref, null), 'unsupported');
  await rm(f.path);
  await f.refresh();
  await f.refresh();
  await writeFile(f.path, 'recreated');
  await f.refresh();
  assert.deepEqual(
    f.events.map((event) => event.kind),
    ['changed', 'deleted', 'changed'],
  );
  await rm(f.path);
  await mkdir(f.path);
  await f.refresh();
  assert.equal(f.events.length, 3);
  assert.equal(f.errors[0]?.code, 'unsupported');
});

test('replacing с потерянным ответом ждёт reconcile только для собственного hash', async (t) => {
  const io = createFileWriter();
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async syncDirectory() {
        throw new Error('lost acknowledgement');
      },
    },
  });
  f.watch();
  await f.refresh();
  assert.equal((await f.client.documents.save(f.request())).kind, 'unknown');
  await f.refresh();
  assert.deepEqual(f.events, []);
  assert.equal((await f.client.documents.reconcile('operation')).kind, 'saved');
  await f.refresh();
  assert.deepEqual(f.events, []);
  await writeFile(f.path, 'external');
  await f.refresh();
  assert.equal(f.events.length, 1);
});

test('неизвестное внешнее содержимое/удаление не подавляется pending-операцией', async (t) => {
  const io = createFileWriter();
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async syncDirectory() {
        throw new Error('lost');
      },
    },
  });
  f.watch();
  await f.refresh();
  assert.equal((await f.client.documents.save(f.request())).kind, 'unknown');
  await writeFile(f.path, 'external');
  await f.refresh();
  assert.equal(f.events.length, 1);
  assert.equal((await f.client.documents.reconcile('operation')).kind, 'unknown');
  await rm(f.path);
  await f.refresh();
  assert.deepEqual(
    f.events.map((event) => event.kind),
    ['changed', 'deleted'],
  );
});

test('file-written reconcile не откатывает уже наблюдённую внешнюю ревизию', async (t) => {
  const f = await fixture(t);
  f.watch();
  await f.refresh();
  f.database.connection.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON saved_versions BEGIN SELECT RAISE(ABORT, 'test'); END;",
  );
  assert.equal((await f.client.documents.save(f.request())).kind, 'history-pending');
  await f.refresh();
  assert.deepEqual(f.events, []);
  await writeFile(f.path, 'external');
  await f.refresh();
  assert.equal(f.events.length, 1);
  f.database.connection.exec('DROP TRIGGER fail_history');
  assert.equal((await f.client.documents.reconcile('operation')).kind, 'saved');
  await f.refresh();
  assert.equal(f.events.length, 1);
  assert.equal(await readFile(f.path, 'utf8'), 'external');
});

test('немедленная отмена и close отзывают pending watch; права проверяются без probe', async (t) => {
  const f = await fixture(t);
  const stop = f.watch();
  stop();
  await f.refresh();
  assert.equal(f.signals.starts, 0);
  const other = f.services.createClient({}),
    errors: PortError[] = [];
  other.events.watch(
    f.ref,
    () => assert.fail('unauthorized'),
    (error) => errors.push(error),
  );
  await other.refreshResources();
  assert.equal(errors[0]?.code, 'permission-denied');
  assert.equal(f.signals.starts, 0);
  f.watch();
  f.client.close();
  await f.refresh();
  assert.equal(f.signals.starts, 0);
});

test('ошибка watcher не останавливает polling; восстановление не создаёт повторного changed', async (t) => {
  const f = await fixture(t);
  f.signals.unavailable = true;
  f.watch();
  await f.refresh();
  assert.equal(f.errors.length, 1);
  assert.equal(f.signals.watchers.size, 0);
  await writeFile(f.path, 'external with no watcher');
  f.signals.poll();
  await f.refresh();
  assert.equal(f.events.length, 1);
  assert.equal(f.errors.length, 1);
  f.signals.unavailable = false;
  f.signals.poll();
  await f.refresh();
  assert.equal(f.signals.watchers.size, 1);
  assert.equal(f.events.length, 1);
  f.signals.signal();
  f.signals.signal();
  assert.equal(f.signals.timers.size, 1);
  f.client.close();
  assert.equal(f.signals.watchers.size + f.signals.timers.size + f.signals.polls.size, 0);
});

test('service close освобождает watcher/timers, но не отменяет уже prepared save', async (t) => {
  const io = createFileWriter(),
    entered = gate(),
    release = gate();
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async prepare(...args) {
        entered.resolve();
        await release.promise;
        return io.prepare(...args);
      },
    },
  });
  t.after(() => release.resolve());
  f.watch();
  await f.refresh();
  const pending = f.client.documents.save(f.request());
  await entered.promise;
  f.services.close();
  release.resolve();
  assert.equal((await pending).kind, 'saved');
  assert.equal(await readFile(f.path, 'utf8'), 'ours');
  assert.equal(f.signals.watchers.size + f.signals.polls.size + f.signals.timers.size, 0);
  assert.deepEqual(f.events, []);
});

test(
  'настоящий fs.watch замечает атомарную внешнюю замену и удаление',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { signals: createWatchSignals() });
    let deliver!: (event: ResourceEvent) => void;
    f.client.events.watch(
      f.ref,
      (event) => deliver(event),
      (error) => assert.fail(JSON.stringify(error)),
    );
    await f.refresh();
    const next = () =>
      new Promise<ResourceEvent>((resolve) => {
        deliver = resolve;
      });
    const changed = next(),
      temp = join(f.folder, 'external.tmp');
    await writeFile(temp, 'external replacement');
    await rename(temp, f.path);
    assert.equal((await changed).kind, 'changed');
    const deleted = next();
    await rm(f.path);
    assert.equal((await deleted).kind, 'deleted');
  },
);
