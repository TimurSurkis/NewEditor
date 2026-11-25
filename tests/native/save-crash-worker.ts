import assert from 'node:assert/strict';
import { openServiceDatabase } from '../../src/platform/desktop/main/database';
import { createLocalServices } from '../../src/platform/desktop/main/persistence/local-services';
import { createFileWriter } from '../../src/platform/desktop/main/persistence/file-writer';

assert.ok(process.versions.electron);
const [databasePath, path, boundary] = process.argv.slice(2);
assert.ok(databasePath && path && boundary);
const database = openServiceDatabase(databasePath);
const io = createFileWriter();
const crash = (): never => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('Не удалось остановить процесс');
};
const services = createLocalServices(database, {
  fileIO: {
    ...io,
    async prepare(...args) {
      const identity = await io.prepare(...args);
      if (boundary === 'prepared') crash();
      return identity;
    },
    async publish(...args) {
      if (boundary === 'replacing-before' || boundary === 'encoding-before') crash();
      const result = await io.publish(...args);
      if (boundary === 'after-rename' || boundary === 'encoding-after') crash();
      return result;
    },
  },
});
assert.equal((await services.ready).ok, true);
const client = services.createClient({});
const registered = await client.registerPath(path, 'open');
assert.ok(registered.ok);
const loaded = await client.documents.load(registered.value, null);
assert.ok(loaded.ok);
if (boundary === 'file-written') {
  database.connection.function('crash_test_process', crash);
  database.connection.exec(`CREATE TEMP TRIGGER crash_during_history BEFORE INSERT ON saved_versions
    WHEN NEW.origin = 'save' BEGIN SELECT crash_test_process(); END`);
}
const saved = await client.documents.save({
  operationId: 'crash-operation',
  documentId: 'crash-document',
  format: 'txt',
  target: { ref: registered.value, expectedRevision: loaded.value.storageRevision },
  snapshot: {
    text: boundary.startsWith('encoding-') ? loaded.value.snapshot.text : 'after crash\r\n😀',
    fileMetadata: {
      encoding: boundary.startsWith('encoding-') ? 'windows-1251' : 'utf-8',
      bom: false,
    },
  },
  access: null,
});
assert.equal(saved.kind, 'saved');
if (boundary === 'settled') crash();
throw new Error(`Не достигнута граница ${boundary}`);
