import type { EditState, EditTransaction, Result, SessionId, SourceSelection } from '../../core';
import type { CommandError } from '../../application';
import type { ParsedMarkdown } from '../../formats';
export type EditorMode = 'source' | 'visual';
export interface EditorFrame {
  readonly sessionId: SessionId;
  readonly state: EditState;
  readonly selection: SourceSelection;
  readonly editable: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly markdown?: ParsedMarkdown;
}
export interface EditorHost {
  dispatch(transaction: EditTransaction): Result<EditorFrame, CommandError>;
  undo(): Result<EditorFrame, CommandError>;
  redo(): Result<EditorFrame, CommandError>;
  selectionChanged(selection: SourceSelection): void;
  compositionChanged(active: boolean): void;
  reportError(error: CommandError, pendingInput: string | null): void;
  requestSource(selection: SourceSelection): void;
}
export interface EditorInstance {
  render(frame: EditorFrame): void;
  flush(): Promise<Result<void, CommandError>>;
  focus(): void;
  destroy(): void;
}
export interface EditorFactory {
  readonly mode: EditorMode;
  mount(element: HTMLElement, host: EditorHost, initial: EditorFrame): EditorInstance;
}
