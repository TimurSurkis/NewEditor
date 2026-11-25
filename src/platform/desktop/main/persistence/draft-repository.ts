import type Database from 'better-sqlite3';
import { copyFrozen } from '../../../../core';
import type { Result } from '../../../../core';
import type { DraftKey, DraftRecord, PortError } from '../../../../ports';
import { draftRevision, parseDraftRecord } from './draft-data';
import { localFailure } from './errors';

function record(value: unknown): DraftRecord {
  if (!value || typeof value !== 'object') throw new Error('Некорректная строка черновика');
  const row = value as Record<string, unknown>;
  if (typeof row['record_json'] !== 'string') throw new Error('Некорректный JSON черновика');
  const envelope: unknown = JSON.parse(row['record_json']);
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !('version' in envelope) ||
    envelope.version !== 1 ||
    !('record' in envelope)
  )
    throw new Error('Неизвестная версия черновика');
  const parsed = parseDraftRecord(envelope.record);
  if (
    !parsed.ok ||
    parsed.value.key.documentId !== row['document_id'] ||
    parsed.value.key.sessionId !== row['session_id'] ||
    parsed.value.stateRevision !== draftRevision(row['state_revision'])
  )
    throw new Error('Нарушена целостность черновика');
  return parsed.value;
}

export function createDraftRepository(db: Database.Database) {
  const byKey = db.prepare('SELECT * FROM draft_records WHERE document_id = ? AND session_id = ?');
  const clearance = db.prepare(
    'SELECT through_revision FROM draft_clearance WHERE document_id = ? AND session_id = ?',
  );
  const write =
    db.prepare(`INSERT INTO draft_records (document_id, session_id, state_revision, record_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(document_id, session_id) DO UPDATE SET state_revision = excluded.state_revision, record_json = excluded.record_json`);
  const clear =
    db.prepare(`INSERT INTO draft_clearance (document_id, session_id, through_revision) VALUES (?, ?, ?)
    ON CONFLICT(document_id, session_id) DO UPDATE SET through_revision = MAX(through_revision, excluded.through_revision)`);
  const read = (key: DraftKey): DraftRecord | undefined => {
    const value = byKey.get(key.documentId, key.sessionId);
    return value === undefined ? undefined : record(value);
  };
  const through = (key: DraftKey): number => {
    const value = clearance.get(key.documentId, key.sessionId) as
      { through_revision: unknown } | undefined;
    return value === undefined ? -1 : draftRevision(value.through_revision);
  };
  return {
    read,
    exists(key: DraftKey): boolean {
      return (
        byKey.get(key.documentId, key.sessionId) !== undefined ||
        clearance.get(key.documentId, key.sessionId) !== undefined
      );
    },
    list(): readonly DraftRecord[] {
      return copyFrozen(
        db
          .prepare('SELECT * FROM draft_records ORDER BY document_id, session_id')
          .all()
          .map(record),
      );
    },
    put: db.transaction((draft: DraftRecord): Result<{ readonly accepted: boolean }, PortError> => {
      if (draft.stateRevision <= through(draft.key))
        return { ok: true, value: { accepted: false } };
      const previous = read(draft.key);
      if (previous && draft.stateRevision < previous.stateRevision)
        return { ok: true, value: { accepted: false } };
      if (previous && draft.stateRevision === previous.stateRevision)
        return JSON.stringify(previous) === JSON.stringify(draft)
          ? { ok: true, value: { accepted: true } }
          : localFailure('invalid-input', 'Другой черновик с той же ревизией');
      write.run(
        draft.key.documentId,
        draft.key.sessionId,
        draft.stateRevision,
        JSON.stringify({ version: 1, record: draft }),
      );
      return { ok: true, value: { accepted: true } };
    }).immediate,
    removeThrough: db.transaction((key: DraftKey, revision: number): void => {
      const boundary = Math.max(through(key), draftRevision(revision));
      read(key); // Повреждённый payload нельзя удалять по одному номеру колонки.
      clear.run(key.documentId, key.sessionId, boundary);
      db.prepare(
        'DELETE FROM draft_records WHERE document_id = ? AND session_id = ? AND state_revision <= ?',
      ).run(key.documentId, key.sessionId, boundary);
    }).immediate,
  };
}
