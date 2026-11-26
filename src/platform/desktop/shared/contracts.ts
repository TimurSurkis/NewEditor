import type { Result, StorageRef } from '../../../core';
import type {
  DraftKey,
  LoadedDocument,
  OperationStatus,
  PortError,
  SaveRequest,
  SaveResult,
} from '../../../ports';
import type {
  CloseDecision,
  OpenDialogResult,
  SaveDialogRequest,
  SaveDialogResult,
} from '../../../application';

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
  pickSave(input: SaveDialogRequest): Promise<Result<SaveDialogResult | null, PortError>>;
  saveDocument(input: SaveRequest): Promise<SaveResult>;
  getOperation(operationId: string): Promise<Result<OperationStatus, PortError>>;
  reconcileOperation(operationId: string): Promise<SaveResult>;
  confirmClose(displayName: string): Promise<Result<CloseDecision, PortError>>;
  onCloseRequested(listener: () => void): () => void;
  resolveClose(proceed: boolean): Promise<Result<null, PortError>>;
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
  'dialog:save': {
    readonly request: SaveDialogRequest;
    readonly response: Result<SaveDialogResult | null, PortError>;
  };
  'document:save': { readonly request: SaveRequest; readonly response: SaveResult };
  'operation:get': {
    readonly request: { readonly operationId: string };
    readonly response: Result<OperationStatus, PortError>;
  };
  'operation:reconcile': {
    readonly request: { readonly operationId: string };
    readonly response: SaveResult;
  };
  'dialog:close': {
    readonly request: { readonly displayName: string };
    readonly response: Result<CloseDecision, PortError>;
  };
  'window:ready': { readonly request: null; readonly response: Result<null, PortError> };
  'window:resolve-close': {
    readonly request: { readonly proceed: boolean };
    readonly response: Result<null, PortError>;
  };
}

export const channels = {
  appInfo: 'app:info',
  storageHealth: 'storage:health',
  pickOpen: 'dialog:open',
  loadDocument: 'document:load',
  removeDraft: 'draft:remove',
  pickSave: 'dialog:save',
  saveDocument: 'document:save',
  getOperation: 'operation:get',
  reconcileOperation: 'operation:reconcile',
  confirmClose: 'dialog:close',
  windowReady: 'window:ready',
  resolveClose: 'window:resolve-close',
} as const;
export const closeRequested = 'window:close-request';
