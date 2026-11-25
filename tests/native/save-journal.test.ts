import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Result } from '../../src/core';
import type { PortError, SaveRequest, SaveResult } from '../../src/ports';
import { openServiceDatabase } from '../../src/platform/desktop/main/database';
import { createLocalServices } from '../../src/platform/desktop/main/persistence/local-services';
import type { LocalOptions } from '../../src/platform/desktop/main/persistence/local-services';
import { createFileWriter } from '../../src/platform/desktop/main/persistence/file-writer';
import { createFileReader } from '../../src/platform/desktop/main/persistence/file-reader';

function value<T>(result: Result<T, PortError>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}
function saved(result: SaveResult) {
  if (result.kind !== 'saved') assert.fail(JSON.stringify(result));
  return result.receipt;
}
function notWritten(result: SaveResult, code: PortError['code']) {
  assert.equal(result.kind, 'not-written');
  if (result.kind === 'not-written') assert.equal(result.error.code, code);
}

async function fixture(
  t: TestContext,
  options: LocalOptions = {},
  initial: string | null = 'initial\r\n',
) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'neweditor-save-')));
  const path = join(folder, 'Документ с пробелами.txt');
  const databasePath = join(folder, 'service.sqlite');
  if (initial !== null) await writeFile(path, initial);
  const databases: ReturnType<typeof openServiceDatabase>[] = [];
  const openDatabase = () => {
    const db = openServiceDatabase(databasePath);
    databases.push(db);
    return db;
  };
  const database = openDatabase();
  const services = createLocalServices(database, options);
  value(await services.ready);
  const client = services.createClient({});
  t.after(async () => {
    client.close();
    for (const db of databases) db.close();
    await rm(folder, { recursive: true, force: true });
  });
  const ref = value(await client.registerPath(path, initial === null ? 'save-target' : 'open'));
  const loaded = initial === null ? null : value(await client.documents.load(ref, null));
  const request = (text: string, operationId = 'operation'): SaveRequest => ({
    operationId,
    documentId: loaded?.documentId ?? 'new-document',
    format: 'txt',
    target: { ref, expectedRevision: loaded?.storageRevision ?? null },
    snapshot: { text, fileMetadata: { encoding: 'utf-8', bom: false } },
    access: null,
  });
  const count = () =>
    (database.connection.prepare('SELECT COUNT(*) AS n FROM saved_versions').get() as { n: number })
      .n;
  return {
    folder,
    path,
    databasePath,
    database,
    openDatabase,
    services,
    client,
    ref,
    loaded,
    request,
    count,
  };
}

test('прежнее внешнее состояние и неоткрытая Save As цель добавляются перед новым снимком', async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, 'external before overwrite');
  const read = value(await createFileReader()(f.path));
  saved(
    await f.client.documents.save({
      ...f.request('ours'),
      target: { ref: f.ref, expectedRevision: read.storageRevision },
    }),
  );
  const versions = value(await f.client.history.list(f.ref, null));
  const states = [];
  for (const version of versions)
    states.push(value(await f.client.history.read(f.ref, version.id, null)).text);
  assert.deepEqual(states, ['ours', 'external before overwrite', 'initial\r\n']);
  const target = join(f.folder, 'unopened.txt');
  await writeFile(target, 'before');
  const ref = value(await f.client.registerPath(target, 'save-target'));
  const targetRead = value(await createFileReader()(target));
  assert.equal(value(await f.client.history.list(ref, null)).length, 0);
  saved(
    await f.client.documents.save({
      ...f.request('copy', 'copy'),
      target: { ref, expectedRevision: targetRead.storageRevision },
    }),
  );
  const targetVersions = value(await f.client.history.list(ref, null));
  assert.equal(targetVersions.length, 2);
  assert.equal(value(await f.client.history.read(ref, targetVersions[1]!.id, null)).text, 'before');
});

test('два клиента сериализуют save, а getOperation видит pending до завершения записи', async (t) => {
  const io = createFileWriter();
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async prepare(...args) {
        enter();
        await blocked;
        return io.prepare(...args);
      },
    },
  });
  const other = f.services.createClient({});
  value(await other.registerPath(f.path, 'open'));
  const first = f.client.documents.save(f.request('first', 'first'));
  await entered;
  assert.equal(value(await other.documents.getOperation('first')).kind, 'pending');
  const second = other.documents.save(f.request('second', 'second'));
  release();
  saved(await first);
  assert.equal((await second).kind, 'conflict');
  assert.equal(await readFile(f.path, 'utf8'), 'first');
  assert.equal(f.count(), 2);
  other.close();
});

test('закрытие владельца до prepared не принимает запрос в журнал', async (t) => {
  const io = createFileWriter();
  let close = () => {};
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async check(...args) {
        const result = await io.check(...args);
        close();
        return result;
      },
    },
  });
  close = () => f.client.close();
  notWritten(await f.client.documents.save(f.request('ours')), 'permission-denied');
  assert.equal(await readFile(f.path, 'utf8'), 'initial\r\n');
  assert.equal(
    (
      f.database.connection.prepare('SELECT COUNT(*) AS n FROM save_operations').get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test('подготовка с ошибкой остаётся известным отказом и новый operationId может сохраниться', async (t) => {
  const io = createFileWriter();
  let fail = true;
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async prepare(...args) {
        if (fail) throw Object.assign(new Error('fsync/ENOSPC boundary'), { code: 'ENOSPC' });
        return io.prepare(...args);
      },
    },
  });
  const request = f.request('ours');
  const first = await f.client.documents.save(request);
  notWritten(first, 'io-error');
  fail = false;
  assert.deepEqual(await f.client.documents.save(request), first);
  saved(await f.client.documents.save(f.request('ours', 'retry')));
  assert.equal(f.count(), 2);
});

test('достоверный отказ публикации и ошибка после directory-fsync имеют разные исходы', async (t) => {
  const io = createFileWriter();
  await t.test('not-published', async (t) => {
    const f = await fixture(t, {
      fileIO: {
        ...io,
        async publish() {
          return {
            kind: 'not-published',
            error: { code: 'permission-denied', message: 'denied', retryable: false },
          };
        },
      },
    });
    notWritten(await f.client.documents.save(f.request('ours')), 'permission-denied');
    assert.equal(await readFile(f.path, 'utf8'), 'initial\r\n');
  });
  await t.test('directory-fsync', async (t) => {
    const f = await fixture(t, {
      fileIO: {
        ...io,
        async syncDirectory(...args) {
          await io.syncDirectory(...args);
          throw new Error('fsync directory response');
        },
      },
    });
    assert.equal((await f.client.documents.save(f.request('ours'))).kind, 'unknown');
    assert.equal(await readFile(f.path, 'utf8'), 'ours');
    saved(await f.client.documents.reconcile('operation'));
  });
});

test('ошибка фиксации file-written не выдаёт not-written и допускает последующее выяснение по файлу', async (t) => {
  const f = await fixture(t);
  f.database.connection.exec(
    "CREATE TRIGGER fail_receipt BEFORE UPDATE ON save_operations WHEN NEW.phase = 'file-written' BEGIN SELECT RAISE(ABORT, 'receipt'); END",
  );
  const result = await f.client.documents.save(f.request('confirmed'));
  assert.equal(result.kind, 'history-pending');
  assert.equal(value(await f.client.documents.getOperation('operation')).kind, 'pending');
  assert.equal(await readFile(f.path, 'utf8'), 'confirmed');
  f.database.connection.exec('DROP TRIGGER fail_receipt');
  saved(await f.client.documents.reconcile('operation'));
  assert.equal(f.count(), 2);
});

test('изменённые байты собственного temp не публикуются даже при той же длине', async (t) => {
  const io = createFileWriter();
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async prepare(...args) {
        const identity = await io.prepare(...args);
        await writeFile(join(dirname(args[0]), args[1]), 'evil');
        return identity;
      },
    },
  });
  notWritten(await f.client.documents.save(f.request('ours')), 'busy');
  assert.equal(await readFile(f.path, 'utf8'), 'initial\r\n');
  assert.equal(f.count(), 1);
});

test('незавершённая очистка после link не объявляет файл не записанным', async (t) => {
  const io = createFileWriter();
  let fail = true;
  const f = await fixture(
    t,
    {
      fileIO: {
        ...io,
        async removeTemp(...args) {
          if (fail) throw new Error('cleanup');
          await io.removeTemp(...args);
        },
      },
    },
    null,
  );
  assert.equal((await f.client.documents.save(f.request('ours'))).kind, 'unknown');
  assert.equal(await readFile(f.path, 'utf8'), 'ours');
  assert.equal((await lstat(f.path)).nlink, 2);
  assert.equal((await f.client.documents.reconcile('operation')).kind, 'unknown');
  fail = false;
  saved(await f.client.documents.reconcile('operation'));
  assert.equal((await lstat(f.path)).nlink, 1);
});

test('повреждённый pending-журнал останавливает адаптер без сброса истории или файла', async (t) => {
  const f = await fixture(t);
  f.database.connection.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON saved_versions WHEN NEW.origin = 'save' BEGIN SELECT RAISE(ABORT, 'history'); END",
  );
  assert.equal((await f.client.documents.save(f.request('confirmed'))).kind, 'history-pending');
  f.database.connection.exec("UPDATE save_operations SET request_hash = 'corrupt'");
  f.client.close();
  f.database.close();
  const db = f.openDatabase();
  const service = createLocalServices(db);
  assert.equal((await service.ready).ok, false);
  const client = service.createClient({});
  assert.equal((await client.registerPath(f.path, 'open')).ok, false);
  assert.equal(await readFile(f.path, 'utf8'), 'confirmed');
  assert.equal(
    (db.connection.prepare('SELECT COUNT(*) AS n FROM saved_versions').get() as { n: number }).n,
    1,
  );
  client.close();
});

test('записывающий набор выполняется под Electron', () => {
  assert.ok(process.versions.electron);
});

test('после разрешения прежнего pending следующий save перечитывает актуальные метаданные реестра', async (t) => {
  const io = createFileWriter();
  let publications = 0;
  const f = await fixture(
    t,
    {
      fileIO: {
        ...io,
        async publish(...args) {
          const result = await io.publish(...args);
          if (++publications === 1) throw new Error('lost first reply');
          return result;
        },
      },
    },
    'ASCII',
  );
  const first = {
    ...f.request('ASCII', 'encoding'),
    snapshot: { text: 'ASCII', fileMetadata: { encoding: 'windows-1251' as const, bom: false } },
  };
  assert.equal((await f.client.documents.save(first)).kind, 'unknown');
  const observed = value(await createFileReader()(f.path));
  saved(
    await f.client.documents.save({
      ...f.request('next', 'next'),
      target: { ref: f.ref, expectedRevision: observed.storageRevision },
    }),
  );
  const versions = value(await f.client.history.list(f.ref, null));
  assert.equal(versions.length, 3); // Без перечитывания возникла бы ложная before-overwrite UTF-8 версия.
  assert.equal(
    value(await f.client.history.read(f.ref, versions[1]!.id, null)).fileMetadata.encoding,
    'windows-1251',
  );
});

test('одинаковые ASCII-байты до/после публикации encoding различаются при SIGKILL по ревизии', async (t) => {
  const worker = fileURLToPath(new URL('./save-crash-worker.mjs', import.meta.url));
  for (const boundary of ['encoding-before', 'encoding-after'])
    await t.test(boundary, async (t) => {
      const f = await fixture(t, {}, 'ASCII');
      f.client.close();
      f.database.close();
      const child = spawnSync(process.execPath, [worker, f.databasePath, f.path, boundary], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(child.error, undefined, child.stderr);
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const service = createLocalServices(f.openDatabase());
      value(await service.ready);
      const client = service.createClient({});
      const ref = value(await client.registerPath(f.path, 'open'));
      const status = value(await client.documents.getOperation('crash-operation'));
      assert.equal(status.kind, 'settled');
      if (status.kind === 'settled')
        assert.equal(status.outcome.kind, boundary === 'encoding-before' ? 'not-written' : 'saved');
      const loaded = value(await client.documents.load(ref, null));
      assert.equal(
        loaded.snapshot.fileMetadata.encoding,
        boundary === 'encoding-before' ? 'utf-8' : 'windows-1251',
      );
      assert.equal(
        loaded.storageRevision === f.loaded!.storageRevision,
        boundary === 'encoding-before',
      );
      assert.equal(await readFile(f.path, 'utf8'), 'ASCII');
      client.close();
    });
});

test('повреждённый завершённый исход не превращается в missing или новую запись того же ID', async (t) => {
  const f = await fixture(t);
  const request = f.request('written');
  saved(await f.client.documents.save(request));
  f.database.connection.exec("UPDATE save_operations SET request_hash = 'corrupt'");
  await writeFile(f.path, 'external');
  assert.equal((await f.client.documents.getOperation(request.operationId)).ok, false);
  assert.equal((await f.client.documents.save(request)).kind, 'unknown');
  assert.equal((await f.client.documents.reconcile(request.operationId)).kind, 'unknown');
  assert.equal(await readFile(f.path, 'utf8'), 'external');
  assert.equal(f.count(), 2);
});

test('UTF-8 BOM и Windows-1251 сохраняются физически в запрошенном представлении', async (t) => {
  for (const sample of [
    {
      metadata: { encoding: 'utf-8' as const, bom: true },
      hex: 'efbbbfd09fd180d0b8d0b2d0b5d1820d0a',
    },
    { metadata: { encoding: 'windows-1251' as const, bom: false }, hex: 'cff0e8e2e5f20d0a' },
  ])
    await t.test(sample.metadata.encoding, async (t) => {
      const f = await fixture(t);
      const request = {
        ...f.request('Привет\r\n'),
        snapshot: { text: 'Привет\r\n', fileMetadata: sample.metadata },
      };
      saved(await f.client.documents.save(request));
      assert.equal((await readFile(f.path)).toString('hex'), sample.hex);
      assert.deepEqual(
        value(await f.client.documents.load(f.ref, null)).snapshot,
        request.snapshot,
      );
    });
});

test('UUID операции не даёт другому владельцу права читать/восстанавливать исход', async (t) => {
  const f = await fixture(t);
  saved(await f.client.documents.save(f.request('written')));
  const other = f.services.createClient({});
  const status = await other.documents.getOperation('operation');
  assert.equal(status.ok, false);
  if (!status.ok) assert.equal(status.error.code, 'permission-denied');
  const outcome = await other.documents.reconcile('operation');
  assert.equal(outcome.kind, 'unknown');
  if (outcome.kind === 'unknown') assert.equal(outcome.error.code, 'permission-denied');
  assert.equal(await readFile(f.path, 'utf8'), 'written');
  other.close();
});

test('запись точного снимка, receipt/операция/история и физическая замена файла', async (t) => {
  const f = await fixture(t);
  await chmod(f.path, 0o640);
  const loaded = value(await f.client.documents.load(f.ref, null));
  const before = await lstat(f.path);
  const request = {
    ...f.request('A😀Б\r\nе\u0308\nконец  '),
    target: { ref: f.ref, expectedRevision: loaded.storageRevision },
  };
  const receipt = saved(await f.client.documents.save(request));
  assert.equal(await readFile(f.path, 'utf8'), request.snapshot.text);
  assert.notEqual((await lstat(f.path)).ino, before.ino);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o640);
  assert.deepEqual(value(await f.client.documents.getOperation(request.operationId)), {
    kind: 'settled',
    outcome: { kind: 'saved', receipt },
  });
  const versions = value(await f.client.history.list(f.ref, null));
  assert.equal(versions.length, 2);
  assert.deepEqual(
    value(await f.client.history.read(f.ref, versions[0]!.id, null)),
    request.snapshot,
  );
  assert.deepEqual(
    value(await f.client.history.read(f.ref, versions[1]!.id, null)),
    f.loaded!.snapshot,
  );
  assert.equal(
    value(await f.client.documents.load(f.ref, null)).storageRevision,
    receipt.storageRevision,
  );
  assert.equal(
    (await readdir(f.folder)).filter((name) => name.startsWith('.neweditor-')).length,
    0,
  );
});

test('новый пустой документ создаёт обычный UTF-8 файл и первую версию', async (t) => {
  const f = await fixture(t, {}, null);
  const receipt = saved(await f.client.documents.save(f.request('')));
  assert.equal((await readFile(f.path)).length, 0);
  assert.equal((await lstat(f.path)).nlink, 1);
  assert.equal(f.count(), 1);
  assert.equal(value(await f.client.documents.load(f.ref, null)).documentId, 'new-document');
  assert.ok(receipt.versionId);
});

test('null expectedRevision и устаревшая ревизия конфликтуют без перезаписи', async (t) => {
  for (const missing of [false, true])
    await t.test(String(missing), async (t) => {
      const f = await fixture(t, {}, missing ? null : 'initial');
      await writeFile(f.path, 'external');
      const request = f.request('ours');
      const result = await f.client.documents.save(request);
      assert.equal(result.kind, 'conflict');
      assert.equal(await readFile(f.path, 'utf8'), 'external');
      await rm(f.path);
      assert.deepEqual(await f.client.documents.save(request), result);
      await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    });
});

test('один operationId идемпотентен до/после перезапуска и не перезаписывает последующее внешнее состояние', async (t) => {
  const f = await fixture(t);
  const request = f.request('saved');
  const receipt = saved(await f.client.documents.save(request));
  const inode = (await lstat(f.path)).ino;
  const reordered = {
    access: null,
    snapshot: { fileMetadata: { bom: false, encoding: 'utf-8' as const }, text: 'saved' },
    target: request.target,
    format: request.format,
    documentId: request.documentId,
    operationId: request.operationId,
  };
  assert.deepEqual(saved(await f.client.documents.save(reordered)), receipt);
  assert.equal((await lstat(f.path)).ino, inode);
  assert.equal(f.count(), 2);
  f.client.close();
  f.database.close();
  await writeFile(f.path, 'later external');
  const services = createLocalServices(f.openDatabase());
  value(await services.ready);
  const client = services.createClient({});
  value(await client.registerPath(f.path, 'open'));
  assert.deepEqual(saved(await client.documents.save(request)), receipt);
  assert.equal(await readFile(f.path, 'utf8'), 'later external');
  client.close();
});

test('другой payload с прежним operationId отклоняется и не портит исход', async (t) => {
  const f = await fixture(t);
  const request = f.request('first');
  const original = await f.client.documents.save(request);
  saved(original);
  notWritten(
    await f.client.documents.save({
      ...request,
      snapshot: { ...request.snapshot, text: 'different' },
    }),
    'invalid-input',
  );
  assert.deepEqual(await f.client.documents.save(request), original);
  assert.equal(await readFile(f.path, 'utf8'), 'first');
});

test('no-op не меняет inode/историю; ASCII encoding-only создаёт новую ревизию при тех же байтах', async (t) => {
  const f = await fixture(t, {}, 'ASCII');
  const before = await lstat(f.path);
  const noop = saved(await f.client.documents.save(f.request('ASCII', 'noop')));
  assert.equal(noop.versionId, null);
  assert.equal(f.count(), 1);
  const request = f.request('ASCII', 'encoding');
  const receipt = saved(
    await f.client.documents.save({
      ...request,
      snapshot: { text: 'ASCII', fileMetadata: { encoding: 'windows-1251', bom: false } },
    }),
  );
  assert.notEqual(receipt.storageRevision, f.loaded!.storageRevision);
  assert.notEqual((await lstat(f.path)).ino, before.ino);
  assert.equal(await readFile(f.path, 'utf8'), 'ASCII');
  assert.equal(f.count(), 2);
  assert.equal(
    value(await f.client.documents.load(f.ref, null)).snapshot.fileMetadata.encoding,
    'windows-1251',
  );
  assert.equal(
    (await f.client.documents.save(f.request('ASCII', 'stale-metadata'))).kind,
    'conflict',
  );
});

test('пять состояний включают последнее; A → B → A и обратные часы не дедуплицируются глобально', async (t) => {
  let time = 1000;
  const f = await fixture(t, { now: () => time-- }, 'A');
  let revision = f.loaded!.storageRevision;
  let firstVersion: string | null = null;
  const states = ['B', 'A', 'C', 'D', 'E', 'F', 'G'];
  for (const [i, text] of states.entries()) {
    const request = {
      ...f.request(text, `save-${i}`),
      target: { ref: f.ref, expectedRevision: revision },
    };
    const receipt = saved(await f.client.documents.save(request));
    revision = receipt.storageRevision;
    if (i === 0) firstVersion = receipt.versionId;
    if (i === 1) assert.equal(f.count(), 3);
  }
  const versions = value(await f.client.history.list(f.ref, null));
  assert.equal(versions.length, 5);
  const texts = [];
  for (const version of versions)
    texts.push(value(await f.client.history.read(f.ref, version.id, null)).text);
  assert.deepEqual(texts, ['G', 'F', 'E', 'D', 'C']);
  assert.ok(firstVersion);
  assert.equal((await f.client.history.read(f.ref, firstVersion, null)).ok, false);
  saved(await f.client.documents.save(f.request('B', 'save-0')));
  assert.equal(await readFile(f.path, 'utf8'), 'G');
  assert.equal(f.count(), 5);
});

test('Save As сохраняет DocumentId и прежнее содержимое цели, не меняет старый файл/историю', async (t) => {
  const f = await fixture(t, {}, 'source');
  const target = join(f.folder, 'target.txt');
  await writeFile(target, 'target before');
  const ref = value(await f.client.registerPath(target, 'save-target'));
  const before = value(await f.client.documents.load(ref, null));
  saved(
    await f.client.documents.save({
      ...f.request('source'),
      target: { ref, expectedRevision: before.storageRevision },
    }),
  );
  assert.equal(await readFile(f.path, 'utf8'), 'source');
  assert.equal(value(await f.client.history.list(f.ref, null)).length, 1);
  assert.equal(value(await f.client.documents.load(ref, null)).documentId, f.loaded!.documentId);
  const history = value(await f.client.history.list(ref, null));
  assert.equal(value(await f.client.history.read(ref, history[1]!.id, null)).text, 'target before');
});

test('валидация/кодировка не меняют файл; caller не подменяет снимок после первого await', async (t) => {
  const f = await fixture(t);
  notWritten(
    await f.client.documents.save({
      ...f.request('😀'),
      snapshot: { text: '😀', fileMetadata: { encoding: 'windows-1251', bom: false } },
    }),
    'encoding-error',
  );
  for (const invalid of [null, {}, { ...f.request('x'), extra: true }, { ...f.request('\uD800') }])
    notWritten(await f.client.documents.save(invalid as SaveRequest), 'invalid-input');
  assert.equal(await readFile(f.path, 'utf8'), 'initial\r\n');
  const request = JSON.parse(JSON.stringify(f.request('captured'))) as {
    snapshot: { text: string };
  };
  const pending = f.client.documents.save(request as SaveRequest);
  request.snapshot.text = 'mutated';
  saved(await pending);
  assert.equal(await readFile(f.path, 'utf8'), 'captured');
});

test('read-only и hard link не обходятся атомарной заменой', async (t) => {
  const f = await fixture(t);
  await chmod(f.path, 0o444);
  const readonly = value(await f.client.documents.load(f.ref, null));
  notWritten(
    await f.client.documents.save({
      ...f.request('ours'),
      target: { ref: f.ref, expectedRevision: readonly.storageRevision },
    }),
    'permission-denied',
  );
  await chmod(f.path, 0o600);
  const hard = join(f.folder, 'hard.txt');
  await link(f.path, hard);
  const linked = value(await f.client.documents.load(f.ref, null));
  notWritten(
    await f.client.documents.save({
      ...f.request('ours'),
      target: { ref: f.ref, expectedRevision: linked.storageRevision },
    }),
    'unsupported',
  );
  assert.equal(await readFile(hard, 'utf8'), 'initial\r\n');
  assert.equal((await lstat(f.path)).nlink, 2);
});

test('ошибка подготовки и повторная внешняя правка дают известный отказ/конфликт до публикации', async (t) => {
  const io = createFileWriter();
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async prepare(...args) {
        const identity = await io.prepare(...args);
        await writeFile(args[0], 'external');
        return identity;
      },
    },
  });
  assert.equal((await f.client.documents.save(f.request('ours'))).kind, 'conflict');
  assert.equal(await readFile(f.path, 'utf8'), 'external');
  assert.equal(f.count(), 1);
  assert.equal(
    (await readdir(f.folder)).filter((name) => name.startsWith('.neweditor-')).length,
    0,
  );
});

test('появление цели в момент exclusive публикации не перезаписывается', async (t) => {
  const io = createFileWriter();
  const f = await fixture(
    t,
    {
      fileIO: {
        ...io,
        async publish(...args) {
          await writeFile(args[0], 'appeared');
          return io.publish(...args);
        },
      },
    },
    null,
  );
  assert.equal((await f.client.documents.save(f.request('ours'))).kind, 'conflict');
  assert.equal(await readFile(f.path, 'utf8'), 'appeared');
  assert.equal(f.count(), 0);
});

test('потеря ответа после rename/link даёт unknown; reconcile завершает один раз без повторной записи', async (t) => {
  for (const create of [false, true])
    await t.test(String(create), async (t) => {
      const io = createFileWriter();
      const f = await fixture(
        t,
        {
          fileIO: {
            ...io,
            async publish(...args) {
              await io.publish(...args);
              throw new Error('lost response after syscall');
            },
          },
        },
        create ? null : 'initial',
      );
      const request = f.request('written');
      assert.equal((await f.client.documents.save(request)).kind, 'unknown');
      assert.equal(
        value(await f.client.documents.getOperation(request.operationId)).kind,
        'pending',
      );
      const inode = (await lstat(f.path)).ino;
      const result = await f.client.documents.reconcile(request.operationId);
      saved(result);
      assert.equal((await lstat(f.path)).ino, inode);
      assert.deepEqual(await f.client.documents.reconcile(request.operationId), result);
      assert.equal(f.count(), create ? 1 : 2);
      assert.equal((await lstat(f.path)).nlink, 1);
    });
});

test('неизвестное внешнее состояние сохраняется и блокирует только свою цель', async (t) => {
  const io = createFileWriter();
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async publish(...args) {
        await io.publish(...args);
        throw new Error('lost');
      },
    },
  });
  const request = f.request('written');
  assert.equal((await f.client.documents.save(request)).kind, 'unknown');
  await writeFile(f.path, 'unknown external');
  assert.equal((await f.client.documents.reconcile(request.operationId)).kind, 'unknown');
  notWritten(await f.client.documents.save(f.request('new', 'next')), 'busy');
  assert.equal(await readFile(f.path, 'utf8'), 'unknown external');
  const target = join(f.folder, 'copy.txt');
  const ref = value(await f.client.registerPath(target, 'save-target'));
  const alternate = await f.client.documents.save({
    ...f.request('copy', 'copy'),
    target: { ref, expectedRevision: null },
  });
  assert.equal(alternate.kind, 'unknown'); // Обёртка теряет ответ и для альтернативной цели.
  saved(await f.client.documents.reconcile('copy'));
  assert.equal(await readFile(target, 'utf8'), 'copy');
});

test('ошибка истории после file-written даёт history-pending; восстановление не трогает последующий внешний файл', async (t) => {
  const f = await fixture(t);
  f.database.connection.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON saved_versions WHEN NEW.origin = 'save' BEGIN SELECT RAISE(ABORT, 'history'); END",
  );
  const result = await f.client.documents.save(f.request('confirmed'));
  assert.equal(result.kind, 'history-pending');
  assert.equal(await readFile(f.path, 'utf8'), 'confirmed');
  assert.equal(f.count(), 1);
  const status = value(await f.client.documents.getOperation('operation'));
  assert.equal(status.kind, 'settled');
  if (status.kind === 'settled') assert.equal(status.outcome.kind, 'history-pending');
  await writeFile(f.path, 'later external');
  f.database.connection.exec('DROP TRIGGER fail_history');
  saved(await f.client.documents.reconcile('operation'));
  assert.equal(await readFile(f.path, 'utf8'), 'later external');
  assert.equal(f.count(), 2);
  const history = value(await f.client.history.list(f.ref, null));
  assert.equal(value(await f.client.history.read(f.ref, history[0]!.id, null)).text, 'confirmed');
});

test('отказы prepare/replacing SQLite не объявляются успешной записью и не меняют исходник', async (t) => {
  for (const boundary of ['insert', 'replacing'])
    await t.test(boundary, async (t) => {
      const f = await fixture(t);
      f.database.connection.exec(
        boundary === 'insert'
          ? "CREATE TRIGGER fail_journal BEFORE INSERT ON save_operations BEGIN SELECT RAISE(ABORT, 'prepare'); END"
          : "CREATE TRIGGER fail_journal BEFORE UPDATE ON save_operations WHEN NEW.phase = 'replacing' BEGIN SELECT RAISE(ABORT, 'replacing'); END",
      );
      notWritten(await f.client.documents.save(f.request('ours')), 'io-error');
      assert.equal(await readFile(f.path, 'utf8'), 'initial\r\n');
      assert.equal(f.count(), 1);
      assert.equal(
        (await readdir(f.folder)).filter((name) => name.startsWith('.neweditor-')).length,
        0,
      );
    });
});

test('закрытие владельца после prepared не отменяет уже принятую запись main', async (t) => {
  const io = createFileWriter();
  let close = () => {};
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async prepare(...args) {
        close();
        return io.prepare(...args);
      },
    },
  });
  close = () => f.client.close();
  saved(await f.client.documents.save(f.request('accepted')));
  assert.equal(await readFile(f.path, 'utf8'), 'accepted');
  const client = f.services.createClient({});
  value(await client.registerPath(f.path, 'open'));
  assert.equal(value(await client.documents.getOperation('operation')).kind, 'settled');
  client.close();
});

test('чужой temp при EEXIST и подмена temp не удаляются и не публикуются', async (t) => {
  for (const replacement of [false, true])
    await t.test(String(replacement), async (t) => {
      const io = createFileWriter();
      let foreign = '';
      const f = await fixture(t, {
        fileIO: {
          ...io,
          async prepare(...args) {
            foreign = join(dirname(args[0]), args[1]);
            if (!replacement) {
              await writeFile(foreign, 'foreign');
              return io.prepare(...args);
            }
            const identity = await io.prepare(...args);
            await rename(foreign, `${foreign}.moved`);
            await writeFile(foreign, 'foreign');
            return identity;
          },
        },
      });
      const outcome = await f.client.documents.save(f.request('ours'));
      assert.equal(outcome.kind, 'not-written');
      assert.equal(await readFile(f.path, 'utf8'), 'initial\r\n');
      assert.equal(await readFile(foreign, 'utf8'), 'foreign');
      assert.equal(f.count(), 1);
    });
});

test(
  'SIGKILL на границах prepared/replacing/rename/file-written/settled восстанавливается без автоматической перезаписи',
  { timeout: 60000 },
  async (t) => {
    const worker = fileURLToPath(new URL('./save-crash-worker.mjs', import.meta.url));
    for (const boundary of [
      'prepared',
      'replacing-before',
      'after-rename',
      'file-written',
      'settled',
    ])
      await t.test(boundary, async (t) => {
        const f = await fixture(t);
        f.client.close();
        f.database.close();
        const child = spawnSync(process.execPath, [worker, f.databasePath, f.path, boundary], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.equal(child.error, undefined, child.stderr);
        assert.equal(child.signal, 'SIGKILL', `${child.status}: ${child.stderr}`);
        const wrote = ['after-rename', 'file-written', 'settled'].includes(boundary);
        assert.equal(await readFile(f.path, 'utf8'), wrote ? 'after crash\r\n😀' : 'initial\r\n');
        if (boundary === 'file-written') await writeFile(f.path, 'external after crash');
        const services = createLocalServices(f.openDatabase());
        value(await services.ready);
        const client = services.createClient({});
        const ref = value(await client.registerPath(f.path, 'open'));
        const status = value(await client.documents.getOperation('crash-operation'));
        assert.equal(status.kind, 'settled');
        if (status.kind === 'settled')
          assert.equal(status.outcome.kind, wrote ? 'saved' : 'not-written');
        assert.equal(
          await readFile(f.path, 'utf8'),
          boundary === 'file-written'
            ? 'external after crash'
            : wrote
              ? 'after crash\r\n😀'
              : 'initial\r\n',
        );
        assert.equal(value(await client.history.list(ref, null)).length, wrote ? 2 : 1);
        const again = await client.documents.reconcile('crash-operation');
        assert.equal(again.kind, wrote ? 'saved' : 'not-written');
        if (boundary === 'prepared')
          assert.equal(
            (await readdir(f.folder)).filter((name) => name.startsWith('.neweditor-')).length,
            1,
          ); // identity не успела попасть в журнал: не удаляем недоказанный orphan.
        client.close();
      });
  },
);
