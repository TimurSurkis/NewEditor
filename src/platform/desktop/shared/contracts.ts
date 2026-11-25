import type { Result, StorageRef } from '../../../core';
import type { DraftKey, LoadedDocument, PortError } from '../../../ports';
import type { OpenDialogResult } from '../../../application';

export interface AppInfo {
  readonly appVersion: string;
}

export interface StorageHealth {
  readonly schemaVersion: number;
}

export interface DesktopApi {
  getAppInfo(): Promise<Result<AppInfo, PortError>>;
  getStorageHealth(): Promise<Result<StorageHealth, PortError>>;
  pickOpen(): Promise<Result<OpenDialogResult | null, PortError>>;
  loadDocument(ref: StorageRef): Promise<Result<LoadedDocument, PortError>>;
  removeDraft(key: DraftKey, through: number): Promise<Result<null, PortError>>;
}

export interface DesktopIpcMap {
  'app:info': { readonly request: null; readonly response: Result<AppInfo, PortError> };
  'storage:health': { readonly request: null; readonly response: Result<StorageHealth, PortError> };
  'dialog:open': {
    readonly request: null;
    readonly response: Result<OpenDialogResult | null, PortError>;
  };
  'document:load': {
    readonly request: { readonly ref: StorageRef };
    readonly response: Result<LoadedDocument, PortError>;
  };
  'draft:remove': {
    readonly request: { readonly key: DraftKey; readonly through: number };
    readonly response: Result<null, PortError>;
  };
}

export const channels = {
  appInfo: 'app:info',
  storageHealth: 'storage:health',
  pickOpen: 'dialog:open',
  loadDocument: 'document:load',
  removeDraft: 'draft:remove',
} as const;
