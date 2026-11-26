import { contextBridge, ipcRenderer } from 'electron';
import type { Result } from '../../../core';
import type { PortError, SaveResult } from '../../../ports';
import { channels, closeRequested } from '../shared/contracts';
import type { DesktopApi } from '../shared/contracts';

async function request<T>(
  channel: (typeof channels)[keyof typeof channels],
  input: unknown = null,
): Promise<Result<T, PortError>> {
  try {
    return await ipcRenderer.invoke(channel, input);
  } catch {
    return {
      ok: false,
      error: { code: 'io-error', message: 'Связь с приложением недоступна', retryable: true },
    };
  }
}

const desktop: DesktopApi = {
  getAppInfo: () => request(channels.appInfo),
  getStorageHealth: () => request(channels.storageHealth),
  pickOpen: () => request(channels.pickOpen),
  loadDocument: (ref) => request(channels.loadDocument, { ref }),
  removeDraft: (key, through) => request(channels.removeDraft, { key, through }),
  pickSave: (input) => request(channels.pickSave, input),
  saveDocument: (input) => write(channels.saveDocument, input, input?.operationId ?? ''),
  getOperation: (operationId) => request(channels.getOperation, { operationId }),
  reconcileOperation: (operationId) =>
    write(channels.reconcileOperation, { operationId }, operationId),
  confirmClose: (displayName) => request(channels.confirmClose, { displayName }),
  onCloseRequested(listener) {
    const callback = () => listener();
    ipcRenderer.on(closeRequested, callback);
    void request(channels.windowReady);
    return () => {
      ipcRenderer.removeListener(closeRequested, callback);
    };
  },
  resolveClose: (proceed) => request(channels.resolveClose, { proceed }),
};

async function write(channel: string, input: unknown, operationId: string): Promise<SaveResult> {
  try {
    return await ipcRenderer.invoke(channel, input);
  } catch {
    return {
      kind: 'unknown',
      operationId,
      error: {
        code: 'io-error',
        message: 'Ответ сохранения потерян; требуется проверка',
        retryable: true,
      },
    };
  }
}

contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
