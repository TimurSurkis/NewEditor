import { contextBridge, ipcRenderer } from 'electron';
import type { Result } from '../../../core';
import type { PortError } from '../../../ports';
import { channels } from '../shared/contracts';
import type { DesktopApi } from '../shared/contracts';

async function request<T>(
  channel: (typeof channels)[keyof typeof channels],
): Promise<Result<T, PortError>> {
  try {
    return await ipcRenderer.invoke(channel, null);
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
};

contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
