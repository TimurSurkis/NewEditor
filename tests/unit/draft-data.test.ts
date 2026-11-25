import { expect, it } from 'vitest';
import type { DraftRecord } from '../../src/ports';
import {
  draftKey,
  draftRevision,
  parseDraftKey,
  parseDraftRecord,
} from '../../src/platform/desktop/main/persistence/draft-data';

function record(): DraftRecord {
  return {
    key: { documentId: 'doc', sessionId: 'session' },
    format: 'markdown',
    location: null,
    snapshot: { text: '😀\0\r\nе\u0308', fileMetadata: { encoding: 'windows-1251', bom: false } },
    baseline: { text: 'baseline', fileMetadata: { encoding: 'utf-8', bom: true } },
    baseStorageRevision: null,
    stateRevision: 3,
  };
}

it('черновик сохраняет непредставимый в кодировке текст/NUL и замораживает копию', () => {
  const input = record();
  const result = parseDraftRecord(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual(input);
  expect(result.value).not.toBe(input);
  expect(Object.isFrozen(result.value.snapshot.fileMetadata)).toBe(true);
  expect(Object.isFrozen(input.snapshot)).toBe(false);
  expect(
    parseDraftRecord({
      ...input,
      location: { storageId: 'local', resourceId: 'resource' },
      baseStorageRevision: 'rev',
    }).ok,
  ).toBe(true);
});

it.each([
  null,
  [],
  {},
  { ...record(), extra: true },
  { ...record(), key: { documentId: '', sessionId: 's' } },
  { ...record(), stateRevision: -1 },
  { ...record(), stateRevision: 0.5 },
  { ...record(), stateRevision: Number.MAX_SAFE_INTEGER + 1 },
  { ...record(), format: 'docx' },
  { ...record(), location: undefined },
  { ...record(), baseStorageRevision: '' },
  { ...record(), snapshot: { text: '\ud800', fileMetadata: { encoding: 'utf-8', bom: false } } },
  { ...record(), baseline: { text: '', fileMetadata: { encoding: 'windows-1251', bom: true } } },
])('отклоняет некорректный черновик %#', (input) => {
  expect(parseDraftRecord(input)).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
});

it('не исполняет getters/Proxy и не принимает наследуемые поля', () => {
  const getter = Object.defineProperty(record(), 'snapshot', {
    enumerable: true,
    get() {
      throw new Error('getter');
    },
  });
  const proxy = new Proxy(record(), {
    getPrototypeOf() {
      throw new Error('proxy');
    },
  });
  for (const input of [getter, proxy, Object.create(record())])
    expect(parseDraftRecord(input)).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  expect(
    parseDraftRecord({ ...record(), location: { storageId: 'cloud', resourceId: 'r' } }),
  ).toMatchObject({ ok: false, error: { code: 'unsupported' } });
});

it('ключ не коллидирует на разделителях, ревизия проверяется отдельно', () => {
  expect(draftKey({ documentId: 'a:b', sessionId: 'c' })).not.toBe(
    draftKey({ documentId: 'a', sessionId: 'b:c' }),
  );
  expect(parseDraftKey(record().key)).toEqual(record().key);
  for (const value of [NaN, Infinity, -1, '0', null]) expect(() => draftRevision(value)).toThrow();
  expect(draftRevision(0)).toBe(0);
});
