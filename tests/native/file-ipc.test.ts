import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createFileIpc } from '../../src/platform/desktop/main/file-ipc';
import type { FileDialogs } from '../../src/platform/desktop/main/file-ipc';
import { openServiceDatabase } from '../../src/platform/desktop/main/database';
import { createLocalServices } from '../../src/platform/desktop/main/persistence/local-services';
import type { LocalOptions } from '../../src/platform/desktop/main/persistence/local-services';
import { createFileReader } from '../../src/platform/desktop/main/persistence/file-reader';
import { createFileWriter } from '../../src/platform/desktop/main/persistence/file-writer';
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

const saveInput = (target: import('../../src/ports').SaveTarget, text = 'saved') => ({
  operationId: 'save',
  documentId: 'document',
  format: 'txt' as const,
  target,
  snapshot: { text, fileMetadata: { encoding: 'utf-8' as const, bom: false } },
  access: null,
});
const pickInput = { suggestedName: 'new.txt', format: 'txt' as const, current: null };
const saveDialogs = (path: string | null): FileDialogs => ({
  async pickSave() {
    return path;
  },
  async confirmOverwrite() {
    return true;
  },
  async confirmClose() {
    return 'cancel';
  },
});

test('save IPC: отмена диалога/замены не регистрирует цель и не меняет историю/файл', async (t) => {
  const f = await fixture(t),
    dialogs = saveDialogs(null),
    ipc = createFileIpc(f.client, async () => null, dialogs);
  assert.deepEqual(await ipc.pickSave(pickInput), { ok: true, value: null });
  dialogs.pickSave = async () => f.path;
  dialogs.confirmOverwrite = async () => false;
  assert.deepEqual(await ipc.pickSave(pickInput), { ok: true, value: null });
  assert.equal(f.count(), 0);
  assert.equal(await readFile(f.path, 'utf8'), 'A😀\r\nБ\rlast\n');
  assert.equal(f.database.connection.prepare('SELECT * FROM saved_versions').all().length, 0);
});

test('save IPC: новая пустая цель создаётся только save, затем get/reconcile идемпотентны', async (t) => {
  const f = await fixture(t),
    path = join(f.folder, 'new.txt'),
    ipc = createFileIpc(f.client, async () => null, saveDialogs(path));
  const picked = value(await ipc.pickSave(pickInput))!;
  assert.equal(picked.target.expectedRevision, null);
  assert.equal(existsSync(path), false);
  assert.equal(JSON.stringify(picked).includes(f.folder), false);
  const input = saveInput(picked.target, ''),
    saved = await ipc.saveDocument(input);
  assert.equal(saved.kind, 'saved');
  assert.equal(await readFile(path, 'utf8'), '');
  assert.equal(value(await ipc.getOperation({ operationId: 'save' })).kind, 'settled');
  await writeFile(path, 'external');
  assert.deepEqual(await ipc.reconcileOperation({ operationId: 'save' }), saved);
  assert.equal(await readFile(path, 'utf8'), 'external');
});

test('save IPC: ревизия захвачена до подтверждения; изменение/появление цели конфликтует', async (t) => {
  const f = await fixture(t),
    dialogs = saveDialogs(f.path),
    ipc = createFileIpc(f.client, async () => null, dialogs);
  dialogs.confirmOverwrite = async () => {
    await writeFile(f.path, 'changed during confirmation');
    return true;
  };
  const picked = value(await ipc.pickSave(pickInput))!;
  assert.equal((await ipc.saveDocument(saveInput(picked.target))).kind, 'conflict');
  assert.equal(await readFile(f.path, 'utf8'), 'changed during confirmation');
  const path = join(f.folder, 'appeared.txt');
  dialogs.pickSave = async () => path;
  const absent = value(await ipc.pickSave(pickInput))!;
  await writeFile(path, 'appeared');
  assert.equal(
    (await ipc.saveDocument({ ...saveInput(absent.target), operationId: 'appeared' })).kind,
    'conflict',
  );
  assert.equal(await readFile(path, 'utf8'), 'appeared');
});

test('save IPC: Save As сохраняет DocumentId и прежнее содержимое цели, не меняя источник', async (t) => {
  const f = await fixture(t),
    path = join(f.folder, 'target.txt');
  await writeFile(path, 'preimage');
  const ipc = createFileIpc(f.client, async () => [f.path], saveDialogs(path)),
    original = value(await ipc.pickOpen(null))!.documents[0]!.ref,
    loaded = value(await ipc.loadDocument({ ref: original }));
  const picked = value(await ipc.pickSave({ ...pickInput, current: original }))!,
    result = await ipc.saveDocument({ ...saveInput(picked.target), documentId: loaded.documentId });
  assert.equal(result.kind, 'saved');
  assert.equal(
    value(await ipc.loadDocument({ ref: picked.target.ref })).documentId,
    loaded.documentId,
  );
  const history = value(await f.client.history.list(picked.target.ref, null));
  assert.equal(history.length, 2);
  assert.equal(
    value(await f.client.history.read(picked.target.ref, history[1]!.id, null)).text,
    'preimage',
  );
  assert.equal(await readFile(f.path, 'utf8'), loaded.snapshot.text);
});

test('save IPC: невыданные ref/операция, path и неверные DTO отклоняются до записи', async (t) => {
  const f = await fixture(t),
    path = join(f.folder, 'new.txt');
  let dialogs = 0;
  const handlers = saveDialogs(path);
  handlers.pickSave = async () => {
    dialogs++;
    return path;
  };
  const ipc = createFileIpc(f.client, async () => null, handlers),
    unknown = { storageId: 'local', resourceId: 'unknown' };
  assert.equal((await ipc.pickSave({ ...pickInput, current: unknown })).ok, false);
  assert.equal((await ipc.pickSave({ ...pickInput, suggestedName: '../file.txt' })).ok, false);
  assert.equal(dialogs, 0);
  const denied = await ipc.saveDocument(saveInput({ ref: unknown, expectedRevision: null }));
  assert.equal(denied.kind, 'not-written');
  if (denied.kind === 'not-written') assert.equal(denied.error.code, 'permission-denied');
  const picked = value(await ipc.pickSave(pickInput))!;
  assert.equal((await ipc.saveDocument({ ...saveInput(picked.target), path })).kind, 'not-written');
  assert.equal((await ipc.getOperation({ operationId: 'save', extra: true })).ok, false);
  assert.equal((await ipc.confirmClose({ displayName: '../bad' })).ok, false);
  assert.equal(existsSync(path), false);
  assert.equal((await ipc.saveDocument(saveInput(picked.target))).kind, 'saved');
  const other = createFileIpc(f.services.createClient({}), async () => null),
    operation = await other.getOperation({ operationId: 'save' });
  assert.equal(operation.ok, false);
  if (!operation.ok) assert.equal(operation.error.code, 'permission-denied');
  assert.equal((await other.reconcileOperation({ operationId: 'save' })).kind, 'unknown');
});

test('save IPC: codec error не создаёт файл, history-pending явно завершается через reconcile', async (t) => {
  const f = await fixture(t),
    path = join(f.folder, 'new.txt'),
    ipc = createFileIpc(f.client, async () => null, saveDialogs(path));
  const picked = value(await ipc.pickSave(pickInput))!,
    bad = saveInput(picked.target, '😀');
  const invalid = await ipc.saveDocument({
    ...bad,
    snapshot: { text: '😀', fileMetadata: { encoding: 'windows-1251', bom: false } },
  });
  assert.equal(invalid.kind, 'not-written');
  if (invalid.kind === 'not-written') assert.equal(invalid.error.code, 'encoding-error');
  assert.equal(existsSync(path), false);
  f.database.connection.exec(
    "CREATE TRIGGER fail_ipc_history BEFORE INSERT ON saved_versions BEGIN SELECT RAISE(ABORT, 'test'); END;",
  );
  assert.equal(
    (await ipc.saveDocument({ ...saveInput(picked.target), operationId: 'pending' })).kind,
    'history-pending',
  );
  const status = value(await ipc.getOperation({ operationId: 'pending' }));
  assert.equal(status.kind, 'settled');
  f.database.connection.exec('DROP TRIGGER fail_ipc_history');
  assert.equal((await ipc.reconcileOperation({ operationId: 'pending' })).kind, 'saved');
  assert.equal(await readFile(path, 'utf8'), 'saved');
});

test('save IPC: close после prepared не отменяет принятую main-запись', async (t) => {
  const entered = gate(),
    release = gate(),
    io = createFileWriter();
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
  const path = join(f.folder, 'new.txt'),
    ipc = createFileIpc(f.client, async () => null, saveDialogs(path)),
    picked = value(await ipc.pickSave(pickInput))!;
  const saving = ipc.saveDocument(saveInput(picked.target));
  await entered.promise;
  ipc.close();
  release.resolve();
  assert.equal((await saving).kind, 'saved');
  assert.equal(await readFile(path, 'utf8'), 'saved');
});

test('save IPC: потеря подтверждения публикации возвращает unknown, reconcile не пишет повторно', async (t) => {
  const io = createFileWriter();
  let publications = 0;
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async publish(...args) {
        publications++;
        return io.publish(...args);
      },
      async syncDirectory() {
        throw new Error('lost acknowledgement');
      },
    },
  });
  const path = join(f.folder, 'new.txt'),
    ipc = createFileIpc(f.client, async () => null, saveDialogs(path)),
    picked = value(await ipc.pickSave(pickInput))!;
  assert.equal((await ipc.saveDocument(saveInput(picked.target))).kind, 'unknown');
  assert.equal(value(await ipc.getOperation({ operationId: 'save' })).kind, 'pending');
  assert.equal((await ipc.reconcileOperation({ operationId: 'save' })).kind, 'saved');
  assert.equal(publications, 1);
  assert.equal(await readFile(path, 'utf8'), 'saved');
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
