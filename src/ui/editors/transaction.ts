import { applyTransaction, validBoundary } from '../../core';
import type { EditTransaction, ModelError, Result, SourceSelection, TextChange } from '../../core';
import type { EditorFrame } from './contracts';

export function boundedSelection(text: string, selection: SourceSelection): SourceSelection {
  const bound = (value: number) => {
    let at = Math.max(0, Math.min(text.length, value));
    while (!validBoundary(text, at)) at++;
    return at;
  };
  return { anchor: bound(selection.anchor), head: bound(selection.head) };
}
export function edit(
  frame: EditorFrame,
  changes: readonly TextChange[],
  after?: SourceSelection,
  groupId: string | null = null,
): Result<EditTransaction, ModelError> {
  const tx: EditTransaction = {
    documentId: frame.state.document.id,
    baseStateRevision: frame.state.stateRevision,
    body: { changes },
    selectionBefore: frame.selection,
    selectionAfter: { anchor: 0, head: 0 },
    groupId,
  };
  const preview = applyTransaction(frame.state, tx);
  if (!preview.ok) return preview;
  return {
    ok: true,
    value: {
      ...tx,
      selectionAfter: boundedSelection(preview.value.state.document.text, after ?? frame.selection),
    },
  };
}
export function textDifference(before: string, after: string): TextChange | null {
  if (before === after) return null;
  let from = 0,
    endBefore = before.length,
    endAfter = after.length;
  while (from < endBefore && from < endAfter && before[from] === after[from]) from++;
  while (!validBoundary(before, from) || !validBoundary(after, from)) from--;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  while (!validBoundary(before, endBefore) || !validBoundary(after, endAfter)) {
    endBefore++;
    endAfter++;
  }
  return { from, to: endBefore, insert: after.slice(from, endAfter) };
}
