import type {
  AppliedTransaction,
  EditState,
  EditTransaction,
  ModelError,
  Result,
  TextChange,
  TransactionBody,
} from './types';
import { copyFrozen, validBoundary, validMetadata, validSelection, validUnicode } from './document';

function fail(code: ModelError['code'], message: string): Result<never, ModelError> {
  return { ok: false, error: { code, message } };
}
function replace(text: string, changes: readonly TextChange[]): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const change of changes) {
    pieces.push(text.slice(cursor, change.from), change.insert);
    cursor = change.to;
  }
  pieces.push(text.slice(cursor));
  return pieces.join('');
}
function inverseChanges(
  before: string,
  after: string,
  changes: readonly TextChange[],
): readonly TextChange[] {
  const raw: TextChange[] = [];
  let offset = 0;
  for (const change of changes) {
    raw.push({
      from: change.from + offset,
      to: change.from + offset + change.insert.length,
      insert: before.slice(change.from, change.to),
    });
    offset += change.insert.length - (change.to - change.from);
  }
  const groups: { from: number; to: number; changes: TextChange[] }[] = [];
  for (const change of raw) {
    const from = validBoundary(after, change.from) ? change.from : change.from - 1;
    const to = validBoundary(after, change.to) ? change.to : change.to + 1;
    const last = groups.at(-1);
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to);
      last.changes.push(change);
    } else groups.push({ from, to, changes: [change] });
  }
  return groups.map((group) => ({
    from: group.from,
    to: group.to,
    insert: replace(
      after.slice(group.from, group.to),
      group.changes.map((change) => ({
        ...change,
        from: change.from - group.from,
        to: change.to - group.from,
      })),
    ),
  }));
}
export function applyTransaction(
  state: EditState,
  transaction: EditTransaction,
): Result<AppliedTransaction, ModelError> {
  if (transaction.documentId !== state.document.id)
    return fail('wrong-document', 'Другой документ');
  if (transaction.baseStateRevision !== state.stateRevision)
    return fail('stale-revision', 'Ревизия устарела');
  const text = state.document.text;
  let previous: TextChange | undefined;
  for (const change of transaction.body.changes) {
    if (
      !validBoundary(text, change.from) ||
      !validBoundary(text, change.to) ||
      change.from > change.to ||
      (previous && (change.from <= previous.from || change.from < previous.to))
    )
      return fail('invalid-range', 'Диапазоны некорректны, пересекаются или разрывают символ');
    previous = change;
  }
  if (!validSelection(text, transaction.selectionBefore))
    return fail('invalid-selection', 'Некорректное исходное выделение');
  for (const change of transaction.body.changes)
    if (typeof change.insert !== 'string' || !validUnicode(change.insert))
      return fail('invalid-text', 'Вставка содержит некорректную строку');
  const metadata = transaction.body.fileMetadata ?? state.document.fileMetadata;
  if (!validMetadata(metadata)) return fail('invalid-metadata', 'Некорректная кодировка или BOM');
  const nextText = replace(text, transaction.body.changes);
  if (!validSelection(nextText, transaction.selectionAfter))
    return fail('invalid-selection', 'Некорректное итоговое выделение');
  const textChanged = nextText !== text;
  const metadataChanged =
    metadata.encoding !== state.document.fileMetadata.encoding ||
    metadata.bom !== state.document.fileMetadata.bom;
  if (!textChanged && !metadataChanged)
    return {
      ok: true,
      value: {
        state,
        changed: false,
        inverse: null,
        selection: copyFrozen(transaction.selectionAfter),
      },
    };
  if (
    state.stateRevision === Number.MAX_SAFE_INTEGER ||
    (textChanged && state.document.sourceRevision === Number.MAX_SAFE_INTEGER)
  )
    return fail('revision-overflow', 'Исчерпан безопасный счётчик ревизий');
  const inverse: TransactionBody = {
    changes: textChanged ? inverseChanges(text, nextText, transaction.body.changes) : [],
    ...(metadataChanged ? { fileMetadata: state.document.fileMetadata } : {}),
  };
  return {
    ok: true,
    value: copyFrozen({
      state: {
        document: {
          ...state.document,
          text: nextText,
          fileMetadata: metadata,
          sourceRevision: state.document.sourceRevision + Number(textChanged),
        },
        stateRevision: state.stateRevision + 1,
      },
      changed: true,
      inverse,
      selection: transaction.selectionAfter,
    }),
  };
}
