export type DocumentId = string;
export type SessionId = string;
export type OperationId = string;
export type StorageRevision = string;
export type Revision = number;
export type DocumentFormat = 'txt' | 'markdown';
export interface StorageRef {
  readonly storageId: string;
  readonly resourceId: string;
}
export interface FileMetadata {
  readonly encoding: 'utf-8' | 'windows-1251';
  readonly bom: boolean;
}
export interface DocumentSnapshot {
  readonly text: string;
  readonly fileMetadata: FileMetadata;
}
export interface Document extends DocumentSnapshot {
  readonly id: DocumentId;
  readonly format: DocumentFormat;
  readonly location: StorageRef | null;
  readonly sourceRevision: Revision;
}
export interface EditState {
  readonly document: Document;
  readonly stateRevision: Revision;
}
export interface SourceSelection {
  readonly anchor: number;
  readonly head: number;
}
export interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}
export interface TransactionBody {
  readonly changes: readonly TextChange[];
  readonly fileMetadata?: FileMetadata;
}
export interface EditTransaction {
  readonly documentId: DocumentId;
  readonly baseStateRevision: Revision;
  readonly body: TransactionBody;
  readonly selectionBefore: SourceSelection;
  readonly selectionAfter: SourceSelection;
  readonly groupId: string | null;
}
export interface ModelError {
  readonly code:
    | 'wrong-document'
    | 'stale-revision'
    | 'invalid-range'
    | 'invalid-text'
    | 'invalid-metadata'
    | 'invalid-selection'
    | 'revision-overflow';
  readonly message: string;
}
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export interface AppliedTransaction {
  readonly state: EditState;
  readonly changed: boolean;
  readonly inverse: TransactionBody | null;
  readonly selection: SourceSelection;
}
