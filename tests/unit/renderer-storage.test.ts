import { expect, it, vi } from 'vitest';
import type { DesktopApi } from '../../src/platform/desktop/shared/contracts';
import { createRendererStorage } from '../../src/platform/desktop/renderer/local-storage';

it('renderer передаёт load/clear через фиксированный API, остальные команды явно unsupported', async () => {
  const ref = { storageId: 'local', resourceId: 'resource' },
    key = { documentId: 'document', sessionId: 'session' };
  const api: DesktopApi = {
    async getAppInfo() {
      return { ok: true, value: { appVersion: '1' } };
    },
    async getStorageHealth() {
      return { ok: true, value: { schemaVersion: 2 } };
    },
    async pickOpen() {
      return { ok: true, value: null };
    },
    loadDocument: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'not-found' as const, message: 'missing', retryable: false },
    })),
    removeDraft: vi.fn(async () => ({ ok: true as const, value: null })),
  };
  const storage = createRendererStorage(api);
  await storage.documents.load(ref, null);
  expect(api.loadDocument).toHaveBeenCalledWith(ref);
  expect(await storage.drafts.removeThrough(key, 4)).toEqual({ ok: true, value: undefined });
  expect(api.removeDraft).toHaveBeenCalledWith(key, 4);
  expect(await storage.history.list(ref, null)).toMatchObject({
    ok: false,
    error: { code: 'unsupported' },
  });
  expect(await storage.documents.getOperation('op')).toMatchObject({
    ok: false,
    error: { code: 'unsupported' },
  });
  expect(await storage.documents.reconcile('op')).toMatchObject({
    kind: 'unknown',
    error: { code: 'unsupported' },
  });
});
