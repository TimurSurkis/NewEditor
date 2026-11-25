import type { PortError, StorageServices } from '../../../ports';
import type { DesktopApi } from '../shared/contracts';

const unsupported = () => ({
  ok: false as const,
  error: {
    code: 'unsupported',
    message: 'Команда ещё не подключена к файловому интерфейсу',
    retryable: false,
  } satisfies PortError,
});

export function createRendererStorage(api: DesktopApi): StorageServices {
  return {
    id: 'local',
    assets: null,
    events: null,
    access: null,
    documents: {
      load: (ref, access) =>
        access === null ? api.loadDocument(ref) : Promise.resolve(unsupported()),
      async save() {
        return { kind: 'not-written', error: unsupported().error };
      },
      async getOperation() {
        return unsupported();
      },
      async reconcile(operationId) {
        return { kind: 'unknown', operationId, error: unsupported().error };
      },
    },
    history: {
      async list() {
        return unsupported();
      },
      async read() {
        return unsupported();
      },
    },
    drafts: {
      async put() {
        return unsupported();
      },
      async list() {
        return unsupported();
      },
      async removeThrough(key, through) {
        const result = await api.removeDraft(key, through);
        return result.ok ? { ok: true, value: undefined } : result;
      },
    },
  };
}
