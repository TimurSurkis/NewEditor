import type {
  AppliedTransaction,
  EditState,
  EditTransaction,
  ModelError,
  Result,
  SourceSelection,
  TransactionBody,
} from './types';
import { copyFrozen, equalSnapshots } from './document';
import { applyTransaction } from './transactions';

interface Entry {
  readonly forward: TransactionBody;
  readonly inverse: TransactionBody;
  readonly before: SourceSelection;
  readonly after: SourceSelection;
}
interface Group {
  readonly id: string | null;
  readonly entries: readonly Entry[];
}
export class EditHistory {
  private past: Group[] = [];
  private future: Group[] = [];
  private joinable = false;
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  breakGroup(): void {
    this.joinable = false;
  }
  clear(): void {
    this.past = [];
    this.future = [];
    this.breakGroup();
  }
  apply(
    state: EditState,
    transaction: EditTransaction,
    merge = false,
  ): Result<AppliedTransaction, ModelError> {
    const result = applyTransaction(state, transaction);
    if (!result.ok || !result.value.changed || !result.value.inverse) return result;
    const entry = copyFrozen({
      forward: transaction.body,
      inverse: result.value.inverse,
      before: transaction.selectionBefore,
      after: transaction.selectionAfter,
    });
    const last = this.past.at(-1);
    if (merge && this.joinable && last && transaction.groupId && last.id === transaction.groupId)
      this.past[this.past.length - 1] = { ...last, entries: [...last.entries, entry] };
    else {
      this.past.push({ id: transaction.groupId, entries: [entry] });
      if (this.past.length > 200) this.past.shift();
    }
    this.future = [];
    this.joinable = true;
    return result;
  }
  undo(state: EditState, selection: SourceSelection): Result<AppliedTransaction, ModelError> {
    return this.travel(state, selection, true);
  }
  redo(state: EditState, selection: SourceSelection): Result<AppliedTransaction, ModelError> {
    return this.travel(state, selection, false);
  }
  private travel(
    state: EditState,
    selection: SourceSelection,
    undo: boolean,
  ): Result<AppliedTransaction, ModelError> {
    const from = undo ? this.past : this.future,
      to = undo ? this.future : this.past,
      group = from.at(-1);
    if (!group) return { ok: true, value: { state, selection, changed: false, inverse: null } };
    let temporary = state,
      nextSelection = selection;
    for (const entry of undo ? [...group.entries].reverse() : group.entries) {
      // Промежуточные ревизии локальны; переполнение проверяется для всей группы.
      const result = applyTransaction(
        { ...temporary, stateRevision: 0, document: { ...temporary.document, sourceRevision: 0 } },
        {
          documentId: state.document.id,
          baseStateRevision: 0,
          body: undo ? entry.inverse : entry.forward,
          selectionBefore: nextSelection,
          selectionAfter: undo ? entry.before : entry.after,
          groupId: null,
        },
      );
      if (!result.ok) return result;
      temporary = result.value.state;
      nextSelection = result.value.selection;
    }
    const changed = !equalSnapshots(state.document, temporary.document),
      textChanged = state.document.text !== temporary.document.text;
    if (
      changed &&
      (state.stateRevision === Number.MAX_SAFE_INTEGER ||
        (textChanged && state.document.sourceRevision === Number.MAX_SAFE_INTEGER))
    )
      return {
        ok: false,
        error: { code: 'revision-overflow', message: 'Исчерпан безопасный счётчик ревизий' },
      };
    const nextState = changed
      ? copyFrozen({
          ...temporary,
          stateRevision: state.stateRevision + 1,
          document: {
            ...temporary.document,
            sourceRevision: state.document.sourceRevision + Number(textChanged),
          },
        })
      : state;
    from.pop();
    to.push(group);
    this.breakGroup();
    return {
      ok: true,
      value: { state: nextState, selection: nextSelection, changed, inverse: null },
    };
  }
}
