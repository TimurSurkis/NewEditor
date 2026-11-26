export type * from './contracts';
export { createDocumentApplication } from './document-application';
export { findTextMatches, replacementChanges } from './text-search';
export type { TextMatch } from './text-search';
export { createWorkspaceApplication } from './workspace';
export type {
  OpenDialogResult,
  WorkspaceApplication,
  WorkspaceSnapshot,
  WorkspaceTab,
  SaveDialogRequest,
  SaveDialogResult,
  CloseDecision,
  WorkspaceDialogs,
} from './workspace';
