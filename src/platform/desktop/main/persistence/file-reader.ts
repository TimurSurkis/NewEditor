import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { DocumentSnapshot, FileMetadata, Result, StorageRevision } from '../../../../core';
import type { PortError } from '../../../../ports';
import { decodeFile } from './codec';
import { fileFailure, localFailure } from './errors';

export interface FileReadHandle {
  stat(): Promise<BigIntStats>;
  readFile(): Promise<Buffer>;
  close(): Promise<void>;
}

// Узкая граница ФС позволяет воспроизводить подмены/ошибки тестовыми адаптерами.
export interface FileReadIO {
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  open(path: string): Promise<FileReadHandle>;
}

const nodeIO: FileReadIO = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
  async open(path) {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    return {
      stat: () => handle.stat({ bigint: true }),
      readFile: () => handle.readFile(),
      close: () => handle.close(),
    };
  },
};

export interface RepresentationHint {
  readonly contentHash: string;
  readonly fileMetadata: FileMetadata;
}

export interface ReadLocalFile {
  readonly snapshot: DocumentSnapshot;
  readonly storageRevision: StorageRevision;
  readonly contentHash: string;
  readonly stamp: readonly string[];
}

function stamp(stat: BigIntStats): readonly string[] {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].map(
    String,
  );
}

function sameStamp(left: BigIntStats, right: BigIntStats): boolean {
  const other = stamp(right);
  return stamp(left).every((value, index) => value === other[index]);
}

const changed = () =>
  localFailure('busy', 'Файл изменился во время чтения; повторите чтение', true);

export function createFileReader(io: FileReadIO = nodeIO) {
  return async function readLocalFile(
    canonicalPath: string,
    hint?: RepresentationHint,
  ): Promise<Result<ReadLocalFile, PortError>> {
    if (
      !isAbsolute(canonicalPath) ||
      canonicalPath.includes('\0') ||
      resolve(canonicalPath) !== canonicalPath
    )
      return localFailure('invalid-input', 'Ожидается канонический абсолютный путь файла');
    // Снимок параметров до первого await; caller не может подменить подсказку в полёте.
    const representation = hint && {
      contentHash: hint.contentHash,
      fileMetadata: { ...hint.fileMetadata },
    };
    let observed = false;
    try {
      const pathBefore = await io.lstat(canonicalPath);
      observed = true;
      if (!pathBefore.isFile())
        return localFailure('unsupported', 'Документ должен быть обычным файлом, не ссылкой');
      if ((await io.realpath(canonicalPath)) !== canonicalPath) return changed();
      const handle = await io.open(canonicalPath);
      try {
        const before = await handle.stat();
        if (!before.isFile() || !sameStamp(before, pathBefore)) return changed();
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (!sameStamp(before, after) || BigInt(bytes.length) !== after.size) return changed();
        const pathAfter = await io.lstat(canonicalPath);
        if (!pathAfter.isFile() || !sameStamp(after, pathAfter)) return changed();
        if ((await io.realpath(canonicalPath)) !== canonicalPath) return changed();
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        const decoded = decodeFile(
          bytes,
          representation?.contentHash === contentHash ? representation.fileMetadata : undefined,
        );
        if (!decoded.ok) return decoded;
        const fileStamp = Object.freeze(stamp(after));
        return {
          ok: true,
          value: Object.freeze({
            snapshot: decoded.value,
            contentHash,
            stamp: fileStamp,
            storageRevision: `local-v1:${createHash('sha256')
              .update(JSON.stringify([contentHash, ...fileStamp]))
              .digest('hex')}`,
          }),
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      const result = fileFailure(error);
      return observed && result.error.code === 'not-found' ? changed() : result;
    }
  };
}
