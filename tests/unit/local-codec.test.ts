import { describe, expect, it } from 'vitest';
import type { DocumentSnapshot, FileMetadata, Result } from '../../src/core';
import type { PortError } from '../../src/ports';
import { decodeFile, encodeFile } from '../../src/platform/desktop/main/persistence/codec';

function value<T>(result: Result<T, PortError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const utf8: FileMetadata = { encoding: 'utf-8', bom: false };
const cp1251: FileMetadata = { encoding: 'windows-1251', bom: false };

describe('локальный кодек: точные байты и снимки', () => {
  it.each([
    { text: '', fileMetadata: utf8 },
    { text: 'ASCII\tline\r\nnext\rfinal\n', fileMetadata: utf8 },
    { text: 'A😀Б\r\nе\u0308\nё\rконец  ', fileMetadata: utf8 },
    { text: 'Привет\r\nмир\r\n', fileMetadata: { encoding: 'utf-8', bom: true } },
    { text: '\uFEFFвнутренний BOM\uFEFF', fileMetadata: { encoding: 'utf-8', bom: true } },
    { text: 'Намеренный �', fileMetadata: utf8 },
    { text: 'Привет\r\nмир\r\n', fileMetadata: cp1251 },
    { text: 'Ёё № — «» €', fileMetadata: cp1251 },
  ] satisfies DocumentSnapshot[])('сохраняет $text', (snapshot) => {
    const bytes = value(encodeFile(snapshot));
    const decoded = value(decodeFile(bytes));
    expect(decoded).toEqual(snapshot);
    expect(value(encodeFile(decoded))).toEqual(bytes);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.fileMetadata)).toBe(true);
  });

  it('создаёт ожидаемые UTF-8 и Windows-1251-байты без подстановок', () => {
    expect(value(encodeFile({ text: 'Привет', fileMetadata: cp1251 })).toString('hex')).toBe(
      'cff0e8e2e5f2',
    );
    expect(
      value(encodeFile({ text: 'A', fileMetadata: { encoding: 'utf-8', bom: true } })).toString(
        'hex',
      ),
    ).toBe('efbbbf41');
    expect(value(encodeFile({ text: '', fileMetadata: utf8 })).length).toBe(0);
  });

  it('строгий UTF-8 имеет приоритет над неоднозначной Windows-1251', () => {
    expect(value(decodeFile(Buffer.from([0xd0, 0x90])))).toEqual({
      text: 'А',
      fileMetadata: utf8,
    });
    expect(value(decodeFile(Buffer.from('ASCII'))).fileMetadata).toEqual(utf8);
  });

  it('подсказка сохраняет CP1251 ASCII и обычный начальный U+FEFF', () => {
    for (const snapshot of [
      { text: 'ASCII', fileMetadata: cp1251 },
      { text: '', fileMetadata: cp1251 },
      { text: '\uFEFFcontent\uFEFF', fileMetadata: utf8 },
    ]) {
      const bytes = value(encodeFile(snapshot));
      expect(value(decodeFile(bytes, snapshot.fileMetadata))).toEqual(snapshot);
    }
    expect(value(decodeFile(Buffer.from('\uFEFF\uFEFFtext')))).toEqual({
      text: '\uFEFFtext',
      fileMetadata: { encoding: 'utf-8', bom: true },
    });
  });

  it.each(['fffe4100', 'feff0041', 'fffe000041000000', '0000feff00000041'])(
    'не выдаёт UTF-16/32 за CP1251: %s',
    (hex) => {
      expect(decodeFile(Buffer.from(hex, 'hex'))).toMatchObject({
        ok: false,
        error: { code: 'unsupported' },
      });
    },
  );

  it('не делает fallback повреждённого UTF-8 с BOM и не заменяет CP1251 0x98', () => {
    for (const hex of ['efbbbfff', 'efbbbfe282', '98'])
      expect(decodeFile(Buffer.from(hex, 'hex'))).toMatchObject({
        ok: false,
        error: { code: 'encoding-error' },
      });
  });

  it('проверяет подсказку, включая BOM и строгий UTF-8', () => {
    expect(decodeFile(Buffer.from('no BOM'), { encoding: 'utf-8', bom: true })).toMatchObject({
      ok: false,
      error: { code: 'encoding-error' },
    });
    expect(decodeFile(Buffer.from([0xff]), utf8)).toMatchObject({
      ok: false,
      error: { code: 'encoding-error' },
    });
    expect(decodeFile(Buffer.from('text'), { encoding: 'windows-1251', bom: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
  });

  it.each(['😀', 'е\u0308', '漢字', '\uFEFF', '�'])(
    'не заменяет непредставимый CP1251-текст: %s',
    (text) => {
      expect(encodeFile({ text, fileMetadata: cp1251 })).toMatchObject({
        ok: false,
        error: { code: 'encoding-error' },
      });
    },
  );

  it('проверяет NUL, непарные суррогаты и несовместимый BOM', () => {
    expect(decodeFile(Buffer.from('a\0b'))).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    expect(encodeFile({ text: '\0', fileMetadata: cp1251 })).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    for (const text of ['\uD800', '\uDC00', 'a\uD800b'])
      expect(encodeFile({ text, fileMetadata: utf8 })).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
    expect(
      encodeFile({ text: '', fileMetadata: { encoding: 'windows-1251', bom: true } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
  });

  it('каждый определённый ненулевой CP1251-байт проходит точный round-trip', () => {
    for (let byte = 1; byte <= 255; byte++) {
      if (byte === 0x98) continue;
      const bytes = Buffer.from([byte]);
      const snapshot = value(decodeFile(bytes, cp1251));
      expect(value(encodeFile(snapshot))).toEqual(bytes);
    }
  });
});
