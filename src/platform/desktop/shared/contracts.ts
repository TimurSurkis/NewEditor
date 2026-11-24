import type { Result } from '../../../core';
import type { PortError } from '../../../ports';

export interface AppInfo {
  readonly appVersion: string;
}

export interface StorageHealth {
  readonly schemaVersion: number;
}

export interface DesktopApi {
  getAppInfo(): Promise<Result<AppInfo, PortError>>;
  getStorageHealth(): Promise<Result<StorageHealth, PortError>>;
}

export interface DesktopIpcMap {
  'app:info': { readonly request: null; readonly response: Result<AppInfo, PortError> };
  'storage:health': { readonly request: null; readonly response: Result<StorageHealth, PortError> };
}

export const channels = {
  appInfo: 'app:info',
  storageHealth: 'storage:health',
} as const;
