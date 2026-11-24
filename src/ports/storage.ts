import type {
  DocumentFormat,
  DocumentId,
  DocumentSnapshot,
  OperationId,
  Result,
  Revision,
  SessionId,
  StorageRef,
  StorageRevision,
} from '../core';
import type { PortError } from './index';

export interface LoadedDocument {
  readonly documentId: DocumentId;
  readonly format: DocumentFormat;
  readonly ref: StorageRef;
  readonly snapshot: DocumentSnapshot;
  readonly storageRevision: StorageRevision;
}
export interface SaveTarget {
  readonly ref: StorageRef;
  readonly expectedRevision: StorageRevision | null;
}
export interface LeaseHandle {
  readonly token: string;
  readonly expiresAt: number;
}
export interface SaveRequest {
  readonly operationId: OperationId;
  readonly documentId: DocumentId;
  readonly format: DocumentFormat;
  readonly target: SaveTarget;
  readonly snapshot: DocumentSnapshot;
  readonly access: LeaseHandle | null;
}
export interface SaveReceipt {
  readonly operationId: OperationId;
  readonly documentId: DocumentId;
  readonly format: DocumentFormat;
  readonly ref: StorageRef;
  readonly storageRevision: StorageRevision;
  readonly versionId: string | null;
}
export type CommitOutcome =
  | { readonly kind: 'saved'; readonly receipt: SaveReceipt }
  | { readonly kind: 'history-pending'; readonly receipt: SaveReceipt; readonly error: PortError }
  | { readonly kind: 'conflict'; readonly actualRevision: StorageRevision | null }
  | { readonly kind: 'not-written'; readonly error: PortError };
export type SaveResult =
  | CommitOutcome
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly error: PortError };
export type OperationStatus =
  | { readonly kind: 'pending' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'settled'; readonly outcome: CommitOutcome };
export interface DocumentStore {
  load(ref: StorageRef, access: LeaseHandle | null): Promise<Result<LoadedDocument, PortError>>;
  save(request: SaveRequest): Promise<SaveResult>;
  getOperation(operationId: OperationId): Promise<Result<OperationStatus, PortError>>;
  reconcile(operationId: OperationId): Promise<SaveResult>;
}
export interface VersionSummary {
  readonly id: string;
  readonly savedAt: number;
}
export interface HistoryStore {
  list(
    ref: StorageRef,
    access: LeaseHandle | null,
  ): Promise<Result<readonly VersionSummary[], PortError>>;
  read(
    ref: StorageRef,
    versionId: string,
    access: LeaseHandle | null,
  ): Promise<Result<DocumentSnapshot, PortError>>;
}
export interface DraftKey {
  readonly documentId: DocumentId;
  readonly sessionId: SessionId;
}
export interface DraftRecord {
  readonly key: DraftKey;
  readonly format: DocumentFormat;
  readonly location: StorageRef | null;
  readonly snapshot: DocumentSnapshot;
  readonly baseline: DocumentSnapshot;
  readonly baseStorageRevision: StorageRevision | null;
  readonly stateRevision: Revision;
}
export interface DraftStore {
  put(draft: DraftRecord): Promise<Result<{ readonly accepted: boolean }, PortError>>;
  list(): Promise<Result<readonly DraftRecord[], PortError>>;
  removeThrough(key: DraftKey, stateRevision: Revision): Promise<Result<void, PortError>>;
}
export interface AssetPayload {
  readonly fileName: string;
  readonly mimeType: string;
  readonly base64: string;
}
export interface AssetStore {
  add(
    owner: StorageRef,
    asset: AssetPayload,
    access: LeaseHandle | null,
  ): Promise<Result<{ readonly relativeUrl: string }, PortError>>;
  resolve(
    owner: StorageRef,
    relativeUrl: string,
    access: LeaseHandle | null,
  ): Promise<Result<AssetPayload, PortError>>;
}
export interface AccessLease {
  acquire(ref: StorageRef): Promise<Result<LeaseHandle, PortError>>;
  renew(ref: StorageRef, handle: LeaseHandle): Promise<Result<LeaseHandle, PortError>>;
  release(ref: StorageRef, handle: LeaseHandle): Promise<Result<void, PortError>>;
}
export interface ResourceEvent {
  readonly ref: StorageRef;
  readonly kind: 'changed' | 'deleted';
}
export interface ResourceEvents {
  watch(
    ref: StorageRef,
    listener: (event: ResourceEvent) => void,
    onError: (error: PortError) => void,
  ): () => void;
}
export interface StorageServices {
  readonly id: string;
  readonly documents: DocumentStore;
  readonly history: HistoryStore;
  readonly drafts: DraftStore;
  readonly assets: AssetStore | null;
  readonly events: ResourceEvents | null;
  readonly access: AccessLease | null;
}
