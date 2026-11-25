import { expect, it } from 'vitest';
import type { SaveRequest } from '../../src/ports';
import {
  parseSaveRequest,
  requestHash,
} from '../../src/platform/desktop/main/persistence/save-data';

function request(): SaveRequest {
  return {
    operationId: 'operation',
    documentId: 'document',
    format: 'txt',
    target: { ref: { storageId: 'local', resourceId: 'resource' }, expectedRevision: 'revision' },
    snapshot: { text: 'A😀Б\r\nе\u0308', fileMetadata: { encoding: 'utf-8', bom: false } },
    access: null,
  };
}

it('копирует и глубоко замораживает запрос, не замораживая caller-объекты', () => {
  const source = request();
  const result = parseSaveRequest(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual(source);
  expect(result.value).not.toBe(source);
  expect(Object.isFrozen(source.snapshot)).toBe(false);
  expect(Object.isFrozen(result.value.snapshot.fileMetadata)).toBe(true);
  expect(Object.isFrozen(result.value.target.ref)).toBe(true);
});

it.each([
  null,
  [],
  {},
  '',
  { ...request(), unexpected: true },
  { ...request(), access: undefined },
  { ...request(), operationId: '' },
  { ...request(), format: 'docx' },
  { ...request(), target: { ref: { storageId: 'local', resourceId: 'x' }, expectedRevision: 0 } },
  { ...request(), snapshot: { text: '\uD800', fileMetadata: { encoding: 'utf-8', bom: false } } },
  { ...request(), snapshot: { text: '', fileMetadata: { encoding: 'windows-1251', bom: true } } },
])('отклоняет неподходящий DTO: %#', (input) => {
  expect(parseSaveRequest(input)).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
});

it('не исполняет getters и не принимает унаследованные поля или Proxy-исключение', () => {
  const getter = Object.defineProperty(request(), 'snapshot', {
    enumerable: true,
    get() {
      throw new Error('Getter не должен исполняться');
    },
  });
  const proxy = new Proxy(request(), {
    getPrototypeOf() {
      throw new Error('Proxy');
    },
  });
  for (const input of [getter, proxy, Object.create(request())])
    expect(parseSaveRequest(input)).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
});

it('аренда и другое хранилище явно unsupported', () => {
  for (const input of [
    { ...request(), access: { token: 'lease', expiresAt: 1 } },
    {
      ...request(),
      target: { ref: { storageId: 'cloud', resourceId: 'x' }, expectedRevision: null },
    },
  ])
    expect(parseSaveRequest(input)).toMatchObject({ ok: false, error: { code: 'unsupported' } });
});

it('fingerprint не зависит от порядка полей и включает все значимые части запроса', () => {
  const original = request();
  const reordered = {
    access: null,
    snapshot: {
      fileMetadata: { bom: false, encoding: 'utf-8' as const },
      text: original.snapshot.text,
    },
    target: original.target,
    format: original.format,
    documentId: original.documentId,
    operationId: original.operationId,
  };
  expect(requestHash(reordered)).toBe(requestHash(original));
  for (const changed of [
    { ...original, operationId: 'other' },
    { ...original, documentId: 'other' },
    { ...original, format: 'markdown' as const },
    { ...original, target: { ...original.target, expectedRevision: null } },
    {
      ...original,
      target: { ...original.target, ref: { ...original.target.ref, resourceId: 'other' } },
    },
    { ...original, snapshot: { ...original.snapshot, text: 'other' } },
    {
      ...original,
      snapshot: { ...original.snapshot, fileMetadata: { encoding: 'utf-8' as const, bom: true } },
    },
  ])
    expect(requestHash(changed)).not.toBe(requestHash(original));
});
