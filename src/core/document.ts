import type {
  DocumentFormat,
  DocumentId,
  DocumentSnapshot,
  EditState,
  FileMetadata,
  ModelError,
  SourceSelection,
  StorageRef,
} from './types';

// Публичные данные — только plain DTO; не замораживаем объекты вызывающей стороны.
export function copyFrozen<T>(value: T): T {
  if (Array.isArray(value))
    return Object.freeze(value.map((item: unknown) => copyFrozen(item))) as T;
  if (value !== null && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyFrozen(item)])),
    ) as T;
  }
  return value;
}
export function validUnicode(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export function validBoundary(text: string, position: number): boolean {
  if (!Number.isSafeInteger(position) || position < 0 || position > text.length) return false;
  const left = text.charCodeAt(position - 1),
    right = text.charCodeAt(position);
  return (
    !(left === 13 && right === 10) &&
    !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff)
  );
}
export function validSelection(text: string, selection: SourceSelection): boolean {
  return validBoundary(text, selection.anchor) && validBoundary(text, selection.head);
}
export function validMetadata(metadata: FileMetadata): boolean {
  return (
    (metadata.encoding === 'utf-8' || metadata.encoding === 'windows-1251') &&
    typeof metadata.bom === 'boolean' &&
    !(metadata.bom && metadata.encoding !== 'utf-8')
  );
}
export function validateSnapshot(snapshot: DocumentSnapshot): ModelError | null {
  if (typeof snapshot.text !== 'string' || !validUnicode(snapshot.text))
    return { code: 'invalid-text', message: 'Текст содержит непарный суррогат' };
  if (!validMetadata(snapshot.fileMetadata))
    return { code: 'invalid-metadata', message: 'Некорректная кодировка или BOM' };
  return null;
}
export function equalSnapshots(a: DocumentSnapshot, b: DocumentSnapshot): boolean {
  return (
    a.text === b.text &&
    a.fileMetadata.encoding === b.fileMetadata.encoding &&
    a.fileMetadata.bom === b.fileMetadata.bom
  );
}
export function snapshotOf(state: EditState): DocumentSnapshot {
  return copyFrozen({ text: state.document.text, fileMetadata: state.document.fileMetadata });
}
export function createEditState(
  id: DocumentId,
  format: DocumentFormat,
  snapshot: DocumentSnapshot = { text: '', fileMetadata: { encoding: 'utf-8', bom: false } },
  location: StorageRef | null = null,
): EditState {
  if (!id || !['txt', 'markdown'].includes(format)) throw new TypeError('Некорректный документ');
  const error = validateSnapshot(snapshot);
  if (error) throw new TypeError(error.message);
  return copyFrozen({
    document: {
      id,
      format,
      text: snapshot.text,
      fileMetadata: snapshot.fileMetadata,
      location,
      sourceRevision: 0,
    },
    stateRevision: 0,
  });
}
export function preferredLineEnding(text: string): '\n' | '\r\n' | '\r' {
  const counts = new Map<'\n' | '\r\n' | '\r', number>();
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0] as '\n' | '\r\n' | '\r';
    counts.set(ending, (counts.get(ending) ?? 0) + 1);
  }
  let best: '\n' | '\r\n' | '\r' = '\n',
    maximum = 0;
  for (const [ending, count] of counts)
    if (count > maximum) {
      best = ending;
      maximum = count;
    }
  return best;
}
