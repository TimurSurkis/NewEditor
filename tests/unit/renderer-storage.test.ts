import { expect, it, vi } from 'vitest';
import type { DesktopApi } from '../../src/platform/desktop/shared/contracts';
import { createRendererStorage } from '../../src/platform/desktop/renderer/local-storage';
import type { SaveRequest } from '../../src/ports';

it('renderer передаёт load/save/operation/clear через фиксированный API, история явно unsupported', async () => {
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
    async pickSave() {
      return { ok: true, value: null };
    },
    saveDocument: vi.fn<DesktopApi['saveDocument']>(async () => {
      return {
        kind: 'not-written',
        error: { code: 'unsupported', message: 'test', retryable: false },
      };
    }),
    getOperation: vi.fn<DesktopApi['getOperation']>(async () => {
      return { ok: false, error: { code: 'unsupported', message: 'test', retryable: false } };
    }),
    reconcileOperation: vi.fn<DesktopApi['reconcileOperation']>(async (operationId) => {
      return {
        kind: 'unknown',
        operationId,
        error: { code: 'unsupported', message: 'test', retryable: false },
      };
    }),
    async confirmClose() {
      return { ok: true, value: 'cancel' };
    },
    onCloseRequested() {
      return () => {};
    },
    async resolveClose() {
      return { ok: true, value: null };
    },
  };
  const storage = createRendererStorage(api);
  await storage.documents.load(ref, null);
  expect(api.loadDocument).toHaveBeenCalledWith(ref);
  expect(await storage.drafts.removeThrough(key, 4)).toEqual({ ok: true, value: undefined });
  expect(api.removeDraft).toHaveBeenCalledWith(key, 4);
  const request: SaveRequest = {
    operationId: 'op',
    documentId: 'document',
    format: 'txt',
    target: { ref, expectedRevision: null },
    snapshot: { text: 'A', fileMetadata: { encoding: 'utf-8', bom: false } },
    access: null,
  };
  expect(await storage.documents.save(request)).toMatchObject({ kind: 'not-written' });
  expect(api.saveDocument).toHaveBeenCalledWith(request);
  expect(await storage.history.list(ref, null)).toMatchObject({
    ok: false,
    error: { code: 'unsupported' },
  });
  expect(await storage.documents.getOperation('op')).toMatchObject({
    ok: false,
    error: { code: 'unsupported' },
  });
  expect(api.getOperation).toHaveBeenCalledWith('op');
  expect(await storage.documents.reconcile('op')).toMatchObject({
    kind: 'unknown',
    error: { code: 'unsupported' },
  });
  expect(api.reconcileOperation).toHaveBeenCalledWith('op');
});
