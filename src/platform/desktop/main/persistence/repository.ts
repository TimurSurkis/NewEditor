import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { copyFrozen, equalSnapshots, validateSnapshot } from '../../../../core';
import type { DocumentFormat, DocumentSnapshot, FileMetadata } from '../../../../core';
import type { SaveReceipt, SaveRequest, VersionSummary } from '../../../../ports';
import { encodeFile } from './codec';
import type { ReadLocalFile, RepresentationHint } from './file-reader';

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Некорректные служебные данные');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Некорректная строка реестра');
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error('Некорректное число реестра');
  return value;
}

function hash(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error('Некорректный hash реестра');
  return result;
}

function json(value: unknown): Record<string, unknown> {
  const parsed = object(JSON.parse(text(value)) as unknown);
  if (parsed['version'] !== 1) throw new Error('Неизвестная версия служебных данных');
  return parsed;
}

function metadata(value: unknown): FileMetadata {
  const record = object(value);
  const encoding = record['encoding'];
  const bom = record['bom'];
  if (
    (encoding !== 'utf-8' && encoding !== 'windows-1251') ||
    typeof bom !== 'boolean' ||
    (bom && encoding !== 'utf-8')
  )
    throw new Error('Некорректные метаданные реестра');
  return { encoding, bom };
}

function snapshot(value: unknown, expectedHash: unknown): DocumentSnapshot {
  const record = object(json(value)['snapshot']);
  const source = record['text'];
  if (typeof source !== 'string') throw new Error('Некорректный текст версии');
  const result = { text: source, fileMetadata: metadata(record['fileMetadata']) };
  if (validateSnapshot(result)) throw new Error('Некорректный снимок версии');
  const encoded = encodeFile(result);
  if (
    !encoded.ok ||
    createHash('sha256').update(encoded.value).digest('hex') !== hash(expectedHash)
  )
    throw new Error('Нарушена целостность снимка версии');
  return copyFrozen(result);
}

export interface ResourceRecord {
  readonly resourceId: string;
  readonly canonicalPath: string;
  readonly documentId: string;
  readonly format: DocumentFormat;
  readonly hint: RepresentationHint | undefined;
  readonly lastRevision: string | null;
  readonly nextVersion: number;
}

function resource(value: unknown): ResourceRecord {
  const row = object(value);
  const format = row['format'];
  if (format !== 'txt' && format !== 'markdown') throw new Error('Некорректный формат реестра');
  integer(row['created_at']);
  const canonicalPath = text(row['canonical_path']);
  if (
    !isAbsolute(canonicalPath) ||
    canonicalPath.includes('\0') ||
    resolve(canonicalPath) !== canonicalPath
  )
    throw new Error('Некорректный канонический путь реестра');
  const hint =
    row['representation_json'] === null && row['content_hash'] === null
      ? undefined
      : {
          fileMetadata: metadata(json(row['representation_json'])['fileMetadata']),
          contentHash: hash(row['content_hash']),
        };
  return copyFrozen({
    resourceId: text(row['resource_id']),
    canonicalPath,
    documentId: text(row['document_id']),
    format,
    hint,
    lastRevision: row['last_revision'] === null ? null : text(row['last_revision']),
    nextVersion: integer(row['next_version'], 1),
  });
}

export function createLocalRepository(db: Database.Database, id: () => string, now: () => number) {
  const byId = db.prepare('SELECT * FROM local_resources WHERE resource_id = ?');
  const byPath = db.prepare('SELECT * FROM local_resources WHERE canonical_path = ?');
  const all = db.prepare('SELECT * FROM local_resources');
  const active = db.prepare(
    "SELECT 1 FROM save_operations WHERE resource_id = ? AND phase <> 'settled' LIMIT 1",
  );
  const versions = db.prepare(
    'SELECT * FROM saved_versions WHERE resource_id = ? ORDER BY sequence DESC',
  );
  const version = db.prepare(
    'SELECT * FROM saved_versions WHERE resource_id = ? AND version_id = ?',
  );
  const insertResource = db.prepare(`INSERT INTO local_resources
    (resource_id, canonical_path, document_id, format, next_version, created_at)
    VALUES (?, ?, ?, ?, 1, ?)`);
  const insertVersion = db.prepare(`INSERT INTO saved_versions
    (version_id, resource_id, sequence, saved_at, origin, snapshot_json, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const updateRead = db.prepare(`UPDATE local_resources SET
    representation_json = ?, content_hash = ?, last_revision = ?, next_version = ? WHERE resource_id = ?`);

  const get = (resourceId: string): ResourceRecord | undefined => {
    const row = byId.get(resourceId);
    return row === undefined ? undefined : resource(row);
  };
  const register = db.transaction(
    (canonicalPath: string, format: DocumentFormat): ResourceRecord => {
      const row = byPath.get(canonicalPath);
      if (row !== undefined) return resource(row);
      const resourceId = text(id());
      insertResource.run(resourceId, canonicalPath, text(id()), format, integer(now()));
      return resource(byId.get(resourceId));
    },
  );

  const recordRead = db.transaction((resourceId: string, read: ReadLocalFile): void => {
    const row = get(resourceId);
    if (!row) throw new Error('Ресурс исчез из реестра');
    if (active.get(resourceId)) throw new Error('Незавершённая запись ресурса');
    const last = versions.get(resourceId);
    let next = row.nextVersion;
    if (last === undefined) {
      if (next !== 1) throw new Error('Нарушена последовательность истории');
      insertVersion.run(
        text(id()),
        resourceId,
        next,
        integer(now()),
        'initial',
        JSON.stringify({ version: 1, snapshot: read.snapshot }),
        read.contentHash,
      );
      next++;
    } else {
      const latest = object(last);
      integer(latest['saved_at']);
      text(latest['version_id']);
      const sequence = integer(latest['sequence'], 1);
      if (!Number.isSafeInteger(sequence + 1) || next !== sequence + 1)
        throw new Error('Нарушена последовательность истории');
      snapshot(latest['snapshot_json'], latest['content_hash']);
    }
    updateRead.run(
      JSON.stringify({ version: 1, fileMetadata: read.snapshot.fileMetadata }),
      read.contentHash,
      read.storageRevision,
      next,
      resourceId,
    );
  });

  return {
    get,
    findPath(canonicalPath: string): ResourceRecord | undefined {
      const row = byPath.get(canonicalPath);
      return row === undefined ? undefined : resource(row);
    },
    all: (): readonly ResourceRecord[] => all.all().map(resource),
    register,
    hasPending: (resourceId: string): boolean => active.get(resourceId) !== undefined,
    recordRead,
    completeSave: db.transaction(
      (request: SaveRequest, old: DocumentSnapshot | null, receipt: SaveReceipt): SaveReceipt => {
        const resourceId = request.target.ref.resourceId;
        const row = get(resourceId);
        if (!row) throw new Error('Ресурс отсутствует');
        const last = versions.get(resourceId);
        let latest: DocumentSnapshot | null = null;
        let next = row.nextVersion;
        if (last !== undefined) {
          const saved = object(last);
          integer(saved['saved_at']);
          const sequence = integer(saved['sequence'], 1);
          if (!Number.isSafeInteger(sequence + 1) || next !== sequence + 1)
            throw new Error('Нарушен счётчик истории');
          latest = snapshot(saved['snapshot_json'], saved['content_hash']);
        } else if (next !== 1) throw new Error('Отсутствует прежняя история');
        const append = (
          state: DocumentSnapshot,
          origin: 'initial' | 'before-overwrite' | 'save',
        ): string | null => {
          if (latest && equalSnapshots(latest, state)) return null;
          if (!Number.isSafeInteger(next + 1)) throw new Error('Переполнение счётчика истории');
          const encoded = encodeFile(state);
          if (!encoded.ok) throw new Error('Некорректный снимок истории');
          const versionId = text(id());
          insertVersion.run(
            versionId,
            resourceId,
            next++,
            integer(now()),
            origin,
            JSON.stringify({ version: 1, snapshot: state }),
            createHash('sha256').update(encoded.value).digest('hex'),
          );
          latest = state;
          return versionId;
        };
        if (old) append(old, latest ? 'before-overwrite' : 'initial');
        const versionId = append(request.snapshot, 'save');
        const encoded = encodeFile(request.snapshot);
        if (!encoded.ok) throw new Error('Некорректный сохранённый снимок');
        updateRead.run(
          JSON.stringify({ version: 1, fileMetadata: request.snapshot.fileMetadata }),
          createHash('sha256').update(encoded.value).digest('hex'),
          receipt.storageRevision,
          next,
          resourceId,
        );
        db.prepare(
          'UPDATE local_resources SET document_id = ?, format = ? WHERE resource_id = ?',
        ).run(request.documentId, request.format, resourceId);
        db.prepare(
          `DELETE FROM saved_versions WHERE resource_id = ? AND version_id NOT IN
        (SELECT version_id FROM saved_versions WHERE resource_id = ? ORDER BY sequence DESC LIMIT 5)`,
        ).run(resourceId, resourceId);
        return copyFrozen({ ...receipt, versionId });
      },
    ),
    list(resourceId: string): readonly VersionSummary[] {
      return copyFrozen(
        versions.all(resourceId).map((value) => {
          const row = object(value);
          integer(row['sequence'], 1);
          snapshot(row['snapshot_json'], row['content_hash']);
          return { id: text(row['version_id']), savedAt: integer(row['saved_at']) };
        }),
      );
    },
    read(resourceId: string, versionId: string): DocumentSnapshot | undefined {
      const value = version.get(resourceId, versionId);
      if (value === undefined) return undefined;
      const row = object(value);
      integer(row['sequence'], 1);
      integer(row['saved_at']);
      return snapshot(row['snapshot_json'], row['content_hash']);
    },
  };
}

export type LocalRepository = ReturnType<typeof createLocalRepository>;
