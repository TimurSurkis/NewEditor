import type {
  DocumentSnapshot,
  EditState,
  EditTransaction,
  Result,
  SourceSelection,
  TransactionBody,
} from '../../src/core';
import { createDocumentApplication } from '../../src/application';
import type { ApplicationOptions } from '../../src/application';
import { createMemoryStorage } from './memory-store';

export const selection = (anchor = 0, head = anchor): SourceSelection => ({ anchor, head });
export const snapshot = (text = ''): DocumentSnapshot => ({
  text,
  fileMetadata: { encoding: 'utf-8', bom: false },
});
export function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
export function transaction(
  state: EditState,
  body: TransactionBody,
  before = selection(),
  after = selection(),
  groupId: string | null = null,
): EditTransaction {
  return {
    documentId: state.document.id,
    baseStateRevision: state.stateRevision,
    body,
    selectionBefore: before,
    selectionAfter: after,
    groupId,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function setup(overrides: Partial<ApplicationOptions> = {}) {
  const memory = createMemoryStorage();
  let id = 0,
    time = 0;
  const app = createDocumentApplication({
    storage: memory.storage,
    newId: (kind) => `${kind}-${++id}`,
    now: () => time,
    ...overrides,
  });
  return {
    app,
    ...memory,
    tick: (amount = 100) => {
      time += amount;
    },
  };
}
