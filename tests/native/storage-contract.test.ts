import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openServiceDatabase } from '../../src/platform/desktop/main/database';
import { createLocalServices } from '../../src/platform/desktop/main/persistence/local-services';
import { encodeFile } from '../../src/platform/desktop/main/persistence/codec';
import { storageCases, value } from '../support/storage-contract';
import type { StorageFixture } from '../support/storage-contract';

async function fixture(): Promise<StorageFixture> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'neweditor-contract-')));
  const database = openServiceDatabase(join(folder, 'service.sqlite')),
    services = createLocalServices(database),
    storage = services.createClient({});
  value(await services.ready);
  let serial = 0;
  const paths = new Map<string, string>();
  return {
    storage,
    async existing(snapshot) {
      const path = join(folder, `document-${++serial}.txt`);
      await writeFile(path, value(encodeFile(snapshot)));
      const ref = value(await storage.registerPath(path, 'open'));
      paths.set(ref.resourceId, path);
      return ref;
    },
    async absent() {
      const path = join(folder, `document-${++serial}.txt`),
        ref = value(await storage.registerPath(path, 'save-target'));
      paths.set(ref.resourceId, path);
      return ref;
    },
    async externalWrite(ref, snapshot) {
      await writeFile(paths.get(ref.resourceId)!, value(encodeFile(snapshot)));
    },
    async close() {
      services.close();
      database.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}
for (const scenario of storageCases)
  test(`local contract: ${scenario.name}`, async () => {
    assert.ok(process.versions.electron);
    const f = await fixture();
    try {
      await scenario.run(f);
    } finally {
      await f.close();
    }
  });
