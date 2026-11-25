import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createDocumentApplication } from '../../src/application';
import type { DocumentApplication } from '../../src/application';
import { openServiceDatabase } from '../../src/platform/desktop/main/database';
import { createLocalServices } from '../../src/platform/desktop/main/persistence/local-services';
import type { LocalOptions } from '../../src/platform/desktop/main/persistence/local-services';
import { createFileWriter } from '../../src/platform/desktop/main/persistence/file-writer';
import { createFileReader } from '../../src/platform/desktop/main/persistence/file-reader';
import { ManualSignals } from '../helpers/watch-signals';
import { value } from '../support/storage-contract';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function append(app: DocumentApplication, id: string, text: string) {
  const edit = app.getSnapshot(id)!.edit,
    end = edit.document.text.length;
  const result = app.apply(id, {
    documentId: edit.document.id,
    baseStateRevision: edit.stateRevision,
    body: { changes: [{ from: end, to: end, insert: text }] },
    selectionBefore: { anchor: end, head: end },
    selectionAfter: { anchor: end + text.length, head: end + text.length },
    groupId: null,
  });
  if (!result.ok) assert.fail(JSON.stringify(result.error));
}
async function fixture(t: TestContext, options: LocalOptions = {}) {
  assert.ok(process.versions.electron);
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'neweditor-app-local-'))),
    path = join(folder, 'document.txt');
  await writeFile(path, 'initial');
  const database = openServiceDatabase(join(folder, 'service.sqlite')),
    services = createLocalServices(database, { signals: new ManualSignals(), ...options }),
    client = services.createClient({});
  value(await services.ready);
  const ref = value(await client.registerPath(path, 'open'));
  const app = createDocumentApplication({
    storage: client,
    newId: (kind) => `${kind}-${randomUUID()}`,
    now: Date.now,
  });
  const id = value(await app.open(ref));
  t.after(async () => {
    services.close();
    database.close();
    await rm(folder, { recursive: true, force: true });
  });
  return {
    folder,
    path,
    database,
    services,
    client,
    ref,
    app,
    id,
    view: () => app.getSnapshot(id)!,
  };
}

test('application/local: старый save сохраняет снимок, новый ввод/черновик остаются dirty', async (t) => {
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
  append(f.app, f.id, 'A');
  value(await f.app.flushDraft(f.id));
  const saving = f.app.save(f.id);
  await entered.promise;
  append(f.app, f.id, 'B');
  value(await f.app.flushDraft(f.id));
  const draft = value(await f.client.drafts.list())[0]!;
  release.resolve();
  assert.equal((await saving).kind, 'saved');
  assert.equal(f.view().edit.document.text, 'initialAB');
  assert.equal(f.view().baseline.text, 'initialA');
  assert.equal(f.view().isDirty, true);
  assert.equal(await readFile(f.path, 'utf8'), 'initialA');
  value(await f.app.flushDraft(f.id));
  assert.deepEqual(value(await f.client.drafts.list()), [draft]);
  assert.equal((await f.app.save(f.id)).kind, 'saved');
  assert.deepEqual(value(await f.client.drafts.list()), []);
  assert.equal(await readFile(f.path, 'utf8'), 'initialAB');
});

test('application/local: отказ очистки черновика не превращает подтверждённый save в отказ', async (t) => {
  const f = await fixture(t);
  append(f.app, f.id, 'A');
  value(await f.app.flushDraft(f.id));
  f.database.connection.exec(
    "CREATE TRIGGER fail_clear BEFORE DELETE ON draft_records BEGIN SELECT RAISE(ABORT, 'test'); END;",
  );
  assert.equal((await f.app.save(f.id)).kind, 'saved');
  assert.equal(f.view().isDirty, false);
  assert.equal(f.view().draftError?.code, 'io-error');
  assert.equal(await readFile(f.path, 'utf8'), 'initialA');
  assert.equal(value(await f.client.drafts.list()).length, 1);
  f.database.connection.exec('DROP TRIGGER fail_clear');
  value(await f.app.flushDraft(f.id));
  assert.deepEqual(value(await f.client.drafts.list()), []);
  assert.equal(f.view().draftError, null);
});

test('application/local: unknown не очищает черновик; reconcile подтверждает без повторной записи', async (t) => {
  const io = createFileWriter();
  let syncs = 0;
  const f = await fixture(t, {
    fileIO: {
      ...io,
      async syncDirectory() {
        syncs++;
        throw new Error('lost reply');
      },
    },
  });
  append(f.app, f.id, 'A');
  value(await f.app.flushDraft(f.id));
  assert.equal((await f.app.save(f.id)).kind, 'unknown');
  assert.equal(f.view().baseline.text, 'initial');
  assert.equal(f.view().isDirty, true);
  assert.equal(value(await f.client.drafts.list()).length, 1);
  assert.equal(await readFile(f.path, 'utf8'), 'initialA');
  assert.equal((await f.app.reconcileSave(f.id)).kind, 'saved');
  assert.equal(syncs, 1);
  assert.equal(f.view().save.kind, 'idle');
  assert.equal(f.view().isDirty, false);
  assert.deepEqual(value(await f.client.drafts.list()), []);
});

test('application/local: history-pending и reconcile сохраняют более новый черновик', async (t) => {
  const f = await fixture(t);
  append(f.app, f.id, 'A');
  value(await f.app.flushDraft(f.id));
  f.database.connection.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON saved_versions BEGIN SELECT RAISE(ABORT, 'test'); END;",
  );
  assert.equal((await f.app.save(f.id)).kind, 'history-pending');
  assert.equal(f.view().baseline.text, 'initialA');
  assert.equal(f.view().save.kind, 'history-pending');
  assert.equal((await f.app.close(f.id, 'discard')).ok, false);
  append(f.app, f.id, 'B');
  value(await f.app.flushDraft(f.id));
  const draft = value(await f.client.drafts.list())[0]!;
  f.database.connection.exec('DROP TRIGGER fail_history');
  assert.equal((await f.app.reconcileSave(f.id)).kind, 'saved');
  assert.equal(f.view().edit.document.text, 'initialAB');
  assert.equal(f.view().isDirty, true);
  assert.deepEqual(value(await f.client.drafts.list()), [draft]);
  assert.equal((await f.app.save(f.id)).kind, 'saved');
  assert.equal(f.view().isDirty, false);
});

test('application/local: событие перечитывает чистую сессию, грязную сохраняет для сравнения/Save As', async (t) => {
  const f = await fixture(t);
  const reloads: ReturnType<DocumentApplication['reload']>[] = [];
  f.client.events.watch(
    f.ref,
    () => {
      reloads.push(f.app.reload(f.id, 'if-clean'));
    },
    (error) => assert.fail(JSON.stringify(error)),
  );
  await f.client.refreshResources();
  await writeFile(f.path, 'external clean');
  await f.client.refreshResources();
  await Promise.all(reloads);
  assert.equal(f.view().edit.document.text, 'external clean');
  assert.equal(f.view().isDirty, false);
  append(f.app, f.id, ' ours');
  value(await f.app.flushDraft(f.id));
  await writeFile(f.path, 'external dirty');
  await f.client.refreshResources();
  await Promise.all(reloads);
  assert.equal(f.view().edit.document.text, 'external clean ours');
  assert.equal(f.view().conflict.kind, 'changed');
  const conflict = f.view().conflict;
  if (conflict.kind === 'changed') assert.equal(conflict.observed?.snapshot.text, 'external dirty');
  assert.equal((await f.app.save(f.id)).kind, 'not-written');
  assert.equal(await readFile(f.path, 'utf8'), 'external dirty');
  const copy = join(f.folder, 'copy.txt'),
    ref = value(await f.client.registerPath(copy, 'save-target'));
  assert.equal((await f.app.save(f.id, { ref, expectedRevision: null })).kind, 'saved');
  assert.equal(await readFile(copy, 'utf8'), 'external clean ours');
  assert.equal(await readFile(f.path, 'utf8'), 'external dirty');
  assert.equal(f.view().conflict.kind, 'none');
  assert.deepEqual(value(await f.client.drafts.list()), []);
});

test('application/local: устаревший load после новой правки не подменяет текст сессии', async (t) => {
  const read = createFileReader(),
    entered = gate(),
    release = gate();
  let blocked = false;
  const f = await fixture(t, {
    async readFile(...args) {
      const result = await read(...args);
      if (blocked) {
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  });
  t.after(() => release.resolve());
  await writeFile(f.path, 'external');
  blocked = true;
  const reload = f.app.reload(f.id, 'if-clean');
  await entered.promise;
  append(f.app, f.id, ' ours');
  value(await f.app.flushDraft(f.id));
  release.resolve();
  const result = await reload;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'busy');
  assert.equal(f.view().edit.document.text, 'initial ours');
  assert.equal(f.view().baseline.text, 'initial');
  assert.equal(value(await f.client.drafts.list())[0]?.snapshot.text, 'initial ours');
});
