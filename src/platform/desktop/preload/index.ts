import { contextBridge, ipcRenderer } from 'electron';
import type { Result } from '../../../core';
import type { PortError } from '../../../ports';
import { channels } from '../shared/contracts';
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
};

contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
