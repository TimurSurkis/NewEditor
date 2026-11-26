import type {
  DocumentFormat,
  DocumentSnapshot,
  EditState,
  EditTransaction,
  ModelError,
  Result,
  Revision,
  SessionId,
  SourceSelection,
  StorageRevision,
} from '../core';
import type {
  LoadedDocument,
  PortError,
  SaveReceipt,
  SaveRequest,
  SaveResult,
  SaveTarget,
  StorageServices,
} from '../ports';

export interface SaveAttempt {
  readonly request: SaveRequest;
  readonly capturedStateRevision: Revision;
}
export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving'; readonly attempt: SaveAttempt }
  | { readonly kind: 'failed'; readonly attempt: SaveAttempt; readonly error: PortError }
  | {
      readonly kind: 'history-pending';
      readonly attempt: SaveAttempt;
      readonly receipt: SaveReceipt;
      readonly error: PortError;
    }
  | { readonly kind: 'unknown'; readonly attempt: SaveAttempt; readonly error: PortError };
export type ConflictState =
  | { readonly kind: 'none' }
  | { readonly kind: 'changed'; readonly observed: LoadedDocument | null }
  | { readonly kind: 'deleted' };
export interface SessionView {
  readonly sessionId: SessionId;
  readonly edit: EditState;
  readonly baseline: DocumentSnapshot;
  readonly storageRevision: StorageRevision | null;
  readonly isDirty: boolean;
  readonly save: SaveState;
  readonly conflict: ConflictState;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly draftError: PortError | null;
}
export interface CommandReply {
  readonly view: SessionView;
  readonly selection: SourceSelection;
}
export type CommandError = ModelError | PortError;
export interface DocumentApplication {
  create(format: DocumentFormat): SessionId;
  open(ref: import('../core').StorageRef): Promise<Result<SessionId, PortError>>;
  getSnapshot(sessionId: SessionId): SessionView | undefined;
  subscribe(sessionId: SessionId, listener: () => void): () => void;
  apply(sessionId: SessionId, transaction: EditTransaction): Result<CommandReply, CommandError>;
  undo(sessionId: SessionId): Result<CommandReply, CommandError>;
  redo(sessionId: SessionId): Result<CommandReply, CommandError>;
  setSelection(sessionId: SessionId, selection: SourceSelection): Result<void, CommandError>;
  breakUndoGroup(sessionId: SessionId): Result<void, PortError>;
  save(sessionId: SessionId, target?: SaveTarget): Promise<SaveResult>;
  reconcileSave(sessionId: SessionId): Promise<SaveResult>;
  flushDraft(sessionId: SessionId): Promise<Result<void, PortError>>;
  reload(
    sessionId: SessionId,
    intent: 'if-clean' | 'discard-local',
    expected?: { readonly stateRevision: Revision; readonly storageRevision: StorageRevision },
  ): Promise<Result<void, PortError>>;
  close(
    sessionId: SessionId,
    decision: 'cancel' | 'discard' | 'save',
    target?: SaveTarget,
  ): Promise<Result<{ readonly closed: boolean }, PortError>>;
}
export interface ApplicationOptions {
  readonly storage: StorageServices;
  readonly newId: (kind: 'document' | 'session' | 'operation') => string;
  readonly now: () => number;
  readonly onError?: (error: PortError) => void;
}
