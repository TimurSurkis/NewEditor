import { it } from 'vitest';
import { createMemoryStorage } from '../../src/platform/memory';
import { storageCases } from '../support/storage-contract';
import type { StorageFixture } from '../support/storage-contract';

export function memoryFixture(): StorageFixture {
  const memory = createMemoryStorage();
  let serial = 0;
  return {
    storage: memory.storage,
    async existing(snapshot) {
      return memory.seed(`resource-${++serial}`, snapshot);
    },
    async absent() {
      return { storageId: 'memory', resourceId: `resource-${++serial}` };
    },
    async externalWrite(ref, snapshot) {
      memory.externalWrite(ref, snapshot);
    },
    async close() {},
  };
}
for (const scenario of storageCases)
  it(`memory contract: ${scenario.name}`, async () => {
    const fixture = memoryFixture();
    try {
      await scenario.run(fixture);
    } finally {
      await fixture.close();
    }
  });
