import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { copyFrozen } from '../../../../core';
import type { DocumentSnapshot } from '../../../../core';
import type { CommitOutcome, SaveReceipt, SaveRequest } from '../../../../ports';
import { encodeFile } from './codec';
import type { ReadLocalFile } from './file-reader';
import type { TempIdentity } from './file-writer';
import { validTempName } from './file-writer';
import type { LocalRepository } from './repository';
import {
  fields,
  nonempty,
  parseOutcome,
  parseReceipt,
  parseSaveRequest,
  parseSnapshot,
  requestHash,
} from './save-data';

export interface JournalOperation {
  readonly request: SaveRequest;
  readonly phase: 'prepared' | 'replacing' | 'file-written' | 'settled' | 'needs-attention';
  readonly oldRevision: string | null;
  readonly oldSnapshot: DocumentSnapshot | null;
  readonly newHash: string;
  readonly tempName: string | null;
  readonly tempIdentity: TempIdentity | null;
  readonly receipt: SaveReceipt | null;
  readonly outcome: CommitOutcome | null;
}

function json(value: unknown): Record<string, unknown> {
  const data: unknown = JSON.parse(nonempty(value));
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !('version' in data) ||
    data.version !== 1
  )
    throw new Error('Неверная версия журнала');
  return data as Record<string, unknown>;
}

function row(value: unknown): JournalOperation {
  if (!value || typeof value !== 'object') throw new Error('Некорректная строка журнала');
  const data = value as Record<string, unknown>;
  const envelope = json(data['request_json']);
  const parsed = parseSaveRequest(envelope['request']);
  if (!parsed.ok) throw new Error('Некорректный запрос в журнале');
  const request = parsed.value;
  if (
    request.operationId !== data['operation_id'] ||
    request.target.ref.resourceId !== data['resource_id'] ||
    requestHash(request) !== data['request_hash']
  )
    throw new Error('Нарушена целостность запроса журнала');
  const bytes = encodeFile(request.snapshot);
  if (
    !bytes.ok ||
    createHash('sha256').update(bytes.value).digest('hex') !== data['new_content_hash']
  )
    throw new Error('Неверный hash журнала');
  const phase = data['phase'];
  if (
    phase !== 'prepared' &&
    phase !== 'replacing' &&
    phase !== 'file-written' &&
    phase !== 'settled' &&
    phase !== 'needs-attention'
  )
    throw new Error('Неверная фаза журнала');
  let tempIdentity: TempIdentity | null = null;
  if (envelope['tempIdentity'] !== null) {
    const identity = fields(envelope['tempIdentity'], ['dev', 'ino']);
    const dev = nonempty(identity['dev']),
      ino = nonempty(identity['ino']);
    if (!/^\d+$/.test(dev) || !/^[1-9]\d*$/.test(ino))
      throw new Error('Неверная идентичность temp');
    tempIdentity = { dev, ino };
  }
  const tempName = data['temp_name'] === null ? null : nonempty(data['temp_name']);
  if ((tempName && !validTempName(tempName)) || (tempIdentity && !tempName))
    throw new Error('Неверное имя temp');
  const oldRevision = data['old_revision'] === null ? null : nonempty(data['old_revision']);
  const oldSnapshot =
    data['old_snapshot_json'] === null
      ? null
      : parseSnapshot(json(data['old_snapshot_json'])['snapshot']);
  if (oldSnapshot) {
    const encoded = encodeFile(oldSnapshot);
    if (
      !encoded.ok ||
      createHash('sha256').update(encoded.value).digest('hex') !==
        json(data['old_snapshot_json'])['contentHash']
    )
      throw new Error('Неверный hash исходного снимка');
  }
  if ((oldRevision === null) !== (oldSnapshot === null))
    throw new Error('Неполный исходный снимок');
  const receipt =
    data['receipt_json'] === null
      ? null
      : parseReceipt(json(data['receipt_json'])['receipt'], request);
  const outcome =
    data['outcome_json'] === null
      ? null
      : parseOutcome(json(data['outcome_json'])['outcome'], request);
  if ((phase === 'file-written' && !receipt) || (phase === 'settled' && !outcome))
    throw new Error('Неполный исход журнала');
  return copyFrozen({
    request,
    phase,
    oldRevision,
    oldSnapshot,
    newHash: String(data['new_content_hash']),
    tempName,
    tempIdentity,
    receipt,
    outcome,
  });
}

export function createSaveJournal(
  db: Database.Database,
  repository: LocalRepository,
  now: () => number,
) {
  const byId = db.prepare('SELECT * FROM save_operations WHERE operation_id = ?');
  const get = (id: string): JournalOperation | undefined => {
    const value = byId.get(id);
    return value === undefined ? undefined : row(value);
  };
  const insert = db.prepare(`INSERT INTO save_operations
    (operation_id, resource_id, request_json, request_hash, phase, old_revision, old_snapshot_json, new_content_hash, temp_name, created_at)
    VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)`);
  function prepare(
    request: SaveRequest,
    old: ReadLocalFile | null,
    tempName: string | null,
  ): JournalOperation {
    const encoded = encodeFile(request.snapshot);
    if (!encoded.ok) throw new Error('Некорректный снимок сохранения');
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('Некорректное время журнала');
    insert.run(
      request.operationId,
      request.target.ref.resourceId,
      JSON.stringify({ version: 1, request, tempIdentity: null }),
      requestHash(request),
      old?.storageRevision ?? null,
      old
        ? JSON.stringify({ version: 1, snapshot: old.snapshot, contentHash: old.contentHash })
        : null,
      createHash('sha256').update(encoded.value).digest('hex'),
      tempName,
      time,
    );
    return get(request.operationId)!;
  }
  function update(sql: string, ...params: (string | null)[]) {
    if (db.prepare(sql).run(...params).changes !== 1)
      throw new Error('Устаревшее состояние журнала');
  }
  const settle = db.transaction((request: SaveRequest, outcome: CommitOutcome): CommitOutcome => {
    const operation = get(request.operationId) ?? prepare(request, null, null);
    if (requestHash(operation.request) !== requestHash(request))
      throw new Error('Другой запрос для operationId');
    if (operation.phase === 'settled') return operation.outcome!;
    update(
      "UPDATE save_operations SET phase = 'settled', outcome_json = ? WHERE operation_id = ?",
      JSON.stringify({ version: 1, outcome }),
      request.operationId,
    );
    return copyFrozen(outcome);
  });
  return {
    get,
    pending: (): readonly JournalOperation[] =>
      db
        .prepare(
          "SELECT * FROM save_operations WHERE phase <> 'settled' ORDER BY created_at, operation_id",
        )
        .all()
        .map(row),
    pendingFor(resourceId: string): JournalOperation | undefined {
      const value = db
        .prepare("SELECT * FROM save_operations WHERE resource_id = ? AND phase <> 'settled'")
        .get(resourceId);
      return value === undefined ? undefined : row(value);
    },
    prepare: db.transaction(prepare),
    settle,
    rememberTemp(operation: JournalOperation, identity: TempIdentity): void {
      update(
        "UPDATE save_operations SET request_json = ? WHERE operation_id = ? AND phase = 'prepared'",
        JSON.stringify({ version: 1, request: operation.request, tempIdentity: identity }),
        operation.request.operationId,
      );
    },
    replacing(operation: JournalOperation): void {
      update(
        "UPDATE save_operations SET phase = 'replacing' WHERE operation_id = ? AND phase = 'prepared'",
        operation.request.operationId,
      );
    },
    written(operation: JournalOperation, receipt: SaveReceipt): void {
      update(
        "UPDATE save_operations SET phase = 'file-written', receipt_json = ? WHERE operation_id = ? AND phase IN ('replacing', 'file-written')",
        JSON.stringify({ version: 1, receipt }),
        operation.request.operationId,
      );
    },
    attention(operation: JournalOperation): void {
      update(
        "UPDATE save_operations SET phase = 'needs-attention' WHERE operation_id = ? AND phase IN ('replacing', 'needs-attention')",
        operation.request.operationId,
      );
    },
    finish: db.transaction((operation: JournalOperation): CommitOutcome => {
      const current = get(operation.request.operationId)!;
      if (current.phase === 'settled') return current.outcome!;
      if (current.phase !== 'file-written' || !current.receipt)
        throw new Error('Запись файла не подтверждена');
      const receipt = repository.completeSave(
        current.request,
        current.oldSnapshot,
        current.receipt,
      );
      const outcome: CommitOutcome = { kind: 'saved', receipt };
      update(
        "UPDATE save_operations SET phase = 'settled', receipt_json = ?, outcome_json = ? WHERE operation_id = ?",
        JSON.stringify({ version: 1, receipt }),
        JSON.stringify({ version: 1, outcome }),
        current.request.operationId,
      );
      return copyFrozen(outcome);
    }),
  };
}

export type SaveJournal = ReturnType<typeof createSaveJournal>;
