import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createFileIpc } from '../../src/platform/desktop/main/file-ipc';
import { openServiceDatabase } from '../../src/platform/desktop/main/database';
import { createLocalServices } from '../../src/platform/desktop/main/persistence/local-services';
import type { LocalOptions } from '../../src/platform/desktop/main/persistence/local-services';
import { createFileReader } from '../../src/platform/desktop/main/persistence/file-reader';
import { value } from '../support/storage-contract';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, options: LocalOptions = {}) {
  assert.ok(process.versions.electron);
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'neweditor-file-ipc-'))),
    path = join(folder, 'Документ.txt');
  await writeFile(path, 'A😀\r\nБ\rlast\n');
  const database = openServiceDatabase(join(folder, 'service.sqlite')),
    services = createLocalServices(database, options),
    client = services.createClient({});
  t.after(async () => {
    services.close();
    database.close();
    await rm(folder, { recursive: true, force: true });
  });
  const count = () =>
    (
      database.connection.prepare('SELECT COUNT(*) AS n FROM local_resources').get() as {
        n: number;
      }
    ).n;
  return { folder, path, database, services, client, count };
}
test('file IPC: отмена/неверный input не создают ресурс и не вызывают диалог', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const ipc = createFileIpc(f.client, async () => {
    calls++;
    return null;
  });
  assert.equal((await ipc.pickOpen({ path: f.path })).ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(await ipc.pickOpen(null), { ok: true, value: null });
  assert.equal(f.count(), 0);
});
test('file IPC: частичный отказ, basename/ref без пути, точный load и начальная история', async (t) => {
  const f = await fixture(t),
    bad = join(f.folder, 'bad.exe');
  await writeFile(bad, 'bad');
  const ipc = createFileIpc(f.client, async () => [f.path, bad, f.path]),
    picked = value(await ipc.pickOpen(null))!;
  assert.equal(picked.documents.length, 2);
  assert.deepEqual(picked.documents[0], picked.documents[1]);
  assert.equal(picked.errors.length, 1);
  assert.equal(JSON.stringify(picked).includes(f.folder), false);
  const ref = picked.documents[0]!.ref,
    loaded = value(await ipc.loadDocument({ ref }));
  assert.equal(loaded.snapshot.text, 'A😀\r\nБ\rlast\n');
  assert.equal(value(await f.client.history.list(ref, null)).length, 1);
});
test('file IPC: невыданный ref/extra/path и нецелая clearance отклоняются', async (t) => {
  const f = await fixture(t),
    ipc = createFileIpc(f.client, async () => [f.path]);
  const ref = { storageId: 'local', resourceId: 'unknown' };
  for (const input of [
    { path: f.path },
    { ref, path: f.path },
    { ref: { ...ref, extra: true } },
    { ref: null },
  ])
    assert.equal((await ipc.loadDocument(input)).ok, false);
  const denied = await ipc.loadDocument({ ref });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'permission-denied');
  for (const input of [
    { key: { documentId: 'd', sessionId: 's' }, through: 0.5 },
    { key: {}, through: 0 },
    { key: { documentId: 'd', sessionId: 's' }, through: 0, extra: true },
  ])
    assert.equal((await ipc.removeDraft(input)).ok, false);
  assert.equal(f.count(), 0);
});
test('file IPC: одновременные запросы разделяют диалог; close до ответа не регистрирует путь', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate();
  let calls = 0;
  const ipc = createFileIpc(f.client, async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return [f.path];
  });
  const a = ipc.pickOpen(null),
    b = ipc.pickOpen(null);
  await entered.promise;
  ipc.close();
  release.resolve();
  assert.equal((await a).ok, false);
  assert.equal((await b).ok, false);
  assert.equal(calls, 1);
  assert.equal(f.count(), 0);
});
test('file IPC: close во время load отзывает ответ до фиксации истории', async (t) => {
  const entered = gate(),
    release = gate(),
    read = createFileReader();
  const f = await fixture(t, {
    async readFile(...args) {
      const result = await read(...args);
      entered.resolve();
      await release.promise;
      return result;
    },
  });
  t.after(() => release.resolve());
  const ipc = createFileIpc(f.client, async () => [f.path]),
    ref = value(await ipc.pickOpen(null))!.documents[0]!.ref;
  const pending = ipc.loadDocument({ ref });
  await entered.promise;
  ipc.close();
  release.resolve();
  const reply = await pending;
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, 'permission-denied');
  assert.equal(f.database.connection.prepare('SELECT * FROM saved_versions').all().length, 0);
});
test('file IPC: очистка void→null реальна, чужой persisted ключ не даёт полномочий', async (t) => {
  const f = await fixture(t),
    ipc = createFileIpc(f.client, async () => null),
    key = { documentId: 'd', sessionId: 's' };
  assert.deepEqual(await ipc.removeDraft({ key, through: 3 }), { ok: true, value: null });
  const other = createFileIpc(f.services.createClient({}), async () => null),
    denied = await other.removeDraft({ key, through: 4 });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'permission-denied');
  assert.equal(
    (
      f.database.connection.prepare('SELECT through_revision FROM draft_clearance').get() as {
        through_revision: number;
      }
    ).through_revision,
    3,
  );
});
