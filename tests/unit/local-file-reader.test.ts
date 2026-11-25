import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import type { Result } from '../../src/core';
import type { PortError } from '../../src/ports';
import { createFileReader } from '../../src/platform/desktop/main/persistence/file-reader';
import type { FileReadIO } from '../../src/platform/desktop/main/persistence/file-reader';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture(text = 'A😀Б\r\nе\u0308\rnext\n') {
  const folder = await mkdtemp(join(tmpdir(), 'neweditor-reader-'));
  folders.push(folder);
  const path = join(await realpath(folder), 'Текст с пробелами.txt');
  await writeFile(path, text);
  return { folder, path, text };
}

function value<T>(result: Result<T, PortError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function controlledIO(afterRead: () => Promise<void>, onClose = () => {}): FileReadIO {
  return {
    lstat: (path) => lstat(path, { bigint: true }),
    realpath,
    async open(path) {
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      return {
        stat: () => handle.stat({ bigint: true }),
        async readFile() {
          const bytes = await handle.readFile();
          await afterRead();
          return bytes;
        },
        async close() {
          await handle.close();
          onClose();
        },
      };
    },
  };
}

it('читает точный снимок, hash и стабильную ревизию, не меняет байты', async () => {
  const { path, text } = await fixture();
  const read = createFileReader();
  const first = value(await read(path));
  expect(first.snapshot).toEqual({ text, fileMetadata: { encoding: 'utf-8', bom: false } });
  expect(first.contentHash).toBe(createHash('sha256').update(text).digest('hex'));
  expect(first.storageRevision).toMatch(/^local-v1:[0-9a-f]{64}$/);
  expect(value(await read(path))).toEqual(first);
  expect(await readFile(path, 'utf8')).toBe(text);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.stamp)).toBe(true);
});

it('сверяет representation hint по hash; старая подсказка не меняет декодирование', async () => {
  const { path } = await fixture('ASCII');
  const read = createFileReader();
  const first = value(await read(path));
  const hint = {
    contentHash: first.contentHash,
    fileMetadata: { encoding: 'windows-1251', bom: false } as const,
  };
  expect(value(await read(path, hint)).snapshot.fileMetadata.encoding).toBe('windows-1251');
  await writeFile(path, 'Другие UTF-8-байты');
  expect(value(await read(path, hint)).snapshot.fileMetadata.encoding).toBe('utf-8');
});

it('меняет ревизию при другой записи той же длины с прежним mtime', async () => {
  const { path } = await fixture('old');
  const fixedTime = new Date('2026-11-25T00:00:00.000Z');
  await utimes(path, fixedTime, fixedTime);
  const read = createFileReader();
  const old = value(await read(path));
  const before = await lstat(path);
  await writeFile(path, 'new');
  await utimes(path, before.atime, before.mtime);
  expect((await lstat(path, { bigint: true })).mtimeNs).toBe(
    BigInt(fixedTime.getTime()) * 1_000_000n,
  );
  const current = value(await read(path));
  expect(current.storageRevision).not.toBe(old.storageRevision);
  expect(current.contentHash).not.toBe(old.contentHash);
});

it('обнаруживает inode-замену даже при тех же байтах', async () => {
  const { path, folder, text } = await fixture();
  const read = createFileReader();
  const old = value(await read(path));
  const replacement = join(folder, 'replacement');
  await writeFile(replacement, text);
  await rename(replacement, path);
  const current = value(await read(path));
  expect(current.contentHash).toBe(old.contentHash);
  expect(current.storageRevision).not.toBe(old.storageRevision);
});

it('обнаруживает изменение во время чтения и закрывает descriptor', async () => {
  const { path } = await fixture('original');
  let closed = 0;
  const read = createFileReader(
    controlledIO(
      () => writeFile(path, 'replacement'),
      () => closed++,
    ),
  );
  expect(await read(path)).toMatchObject({ ok: false, error: { code: 'busy', retryable: true } });
  expect(closed).toBe(1);
  expect(await readFile(path, 'utf8')).toBe('replacement');
});

it('не выдаёт прежний descriptor за уже подменённый путь', async () => {
  const { path, folder } = await fixture();
  const replacement = join(folder, 'new');
  await writeFile(replacement, 'external');
  const read = createFileReader(controlledIO(() => rename(replacement, path)));
  expect(await read(path)).toMatchObject({ ok: false, error: { code: 'busy' } });
  expect(await readFile(path, 'utf8')).toBe('external');
});

it('удаление после начала чтения даёт busy, а не согласованный снимок или начальный not-found', async () => {
  const { path } = await fixture();
  const read = createFileReader(controlledIO(() => rm(path)));
  expect(await read(path)).toMatchObject({ ok: false, error: { code: 'busy' } });
});

it('не принимает неполный буфер даже при неизменных stat', async () => {
  const { path } = await fixture();
  const io = controlledIO(async () => {});
  const originalOpen = io.open;
  io.open = async (path) => {
    const handle = await originalOpen(path);
    return { ...handle, readFile: async () => (await handle.readFile()).subarray(1) };
  };
  expect(await createFileReader(io)(path)).toMatchObject({ ok: false, error: { code: 'busy' } });
});

it('копирует подсказку до await; изменение caller-объекта не меняет чтение', async () => {
  const { path } = await fixture('ASCII');
  const hint = {
    contentHash: createHash('sha256').update('ASCII').digest('hex'),
    fileMetadata: { encoding: 'windows-1251' as const, bom: false },
  };
  const read = createFileReader(
    controlledIO(async () => {
      hint.fileMetadata.bom = true;
    }),
  );
  expect(value(await read(path, hint)).snapshot.fileMetadata).toEqual({
    encoding: 'windows-1251',
    bom: false,
  });
});

it('ошибка close не превращается в подтверждённое чтение', async () => {
  const { path } = await fixture();
  const io = controlledIO(async () => {});
  const originalOpen = io.open;
  io.open = async (path) => {
    const handle = await originalOpen(path);
    return {
      ...handle,
      async close() {
        await handle.close();
        throw new Error('close failed');
      },
    };
  };
  expect(await createFileReader(io)(path)).toMatchObject({
    ok: false,
    error: { code: 'io-error' },
  });
});

it('отклоняет ссылку и каталог без чтения; hard link читается без изменения связи', async () => {
  const { path, folder, text } = await fixture();
  const read = createFileReader();
  const alias = join(folder, 'alias.txt');
  await symlink(path, alias);
  expect(await read(alias)).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  expect(await read(folder)).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  const hard = join(folder, 'hard.txt');
  await link(path, hard);
  expect(value(await read(hard)).snapshot.text).toBe(text);
  expect((await lstat(hard)).nlink).toBe(2);
});

it('не следует через изменённую символьную ссылку родительского каталога', async () => {
  const { folder } = await fixture();
  const actual = join(folder, 'actual');
  const alias = join(folder, 'alias');
  await mkdir(actual);
  await writeFile(join(actual, 'text.txt'), 'data');
  await symlink(actual, alias);
  expect(await createFileReader()(join(alias, 'text.txt'))).toMatchObject({
    ok: false,
    error: { code: 'busy' },
  });
});

it('отклоняет неподходящий путь, отсутствие и NUL-содержимое', async () => {
  const { path, folder } = await fixture('binary\0text');
  const read = createFileReader();
  for (const invalid of ['relative.txt', `${folder}/../file.txt`, `${path}\0suffix`])
    expect(await read(invalid)).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  expect(await read(join(folder, 'missing.txt'))).toMatchObject({
    ok: false,
    error: { code: 'not-found' },
  });
  expect(await read(path)).toMatchObject({ ok: false, error: { code: 'unsupported' } });
});

it('ошибка readFile закрывает descriptor и возвращается как данные без stack/path', async () => {
  const { path } = await fixture();
  let closed = 0;
  const io = controlledIO(
    async () => {
      throw Object.assign(new Error(path), { code: 'EACCES' });
    },
    () => closed++,
  );
  expect(await createFileReader(io)(path)).toEqual({
    ok: false,
    error: { code: 'permission-denied', message: 'Нет доступа к файлу', retryable: false },
  });
  expect(closed).toBe(1);
});
