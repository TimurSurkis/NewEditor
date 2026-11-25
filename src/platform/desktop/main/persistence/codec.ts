import { TextDecoder } from 'node:util';
import iconv from 'iconv-lite';
import { copyFrozen, validateSnapshot } from '../../../../core';
import type { DocumentSnapshot, FileMetadata, Result } from '../../../../core';
import type { PortError } from '../../../../ports';
import { localFailure } from './errors';

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function hasPrefix(bytes: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function unsupportedBom(bytes: Buffer): boolean {
  return (
    hasPrefix(bytes, [0xff, 0xfe]) ||
    hasPrefix(bytes, [0xfe, 0xff]) ||
    hasPrefix(bytes, [0, 0, 0xfe, 0xff])
  );
}

export function encodeFile(snapshot: DocumentSnapshot): Result<Buffer, PortError> {
  if (validateSnapshot(snapshot))
    return localFailure('invalid-input', 'Некорректный Unicode или метаданные файла');
  if (snapshot.text.includes('\0'))
    return localFailure('unsupported', 'NUL не поддерживается в текстовом документе');
  const { encoding, bom } = snapshot.fileMetadata;
  if (encoding === 'utf-8') {
    const bytes = Buffer.from(snapshot.text, 'utf8');
    return { ok: true, value: bom ? Buffer.concat([utf8Bom, bytes]) : bytes };
  }
  const bytes = iconv.encode(snapshot.text, 'windows-1251');
  // iconv-lite отображает неопределённый 0x98 в U+FFFD и обратно: round-trip недостаточен.
  if (
    bytes.includes(0x98) ||
    iconv.decode(bytes, 'windows-1251', { stripBOM: false }) !== snapshot.text
  )
    return localFailure('encoding-error', 'Текст нельзя точно сохранить в Windows-1251');
  return { ok: true, value: bytes };
}

// Подсказку разрешено применять только после сверки hash байтов с реестром.
export function decodeFile(
  bytes: Buffer,
  metadata?: FileMetadata,
): Result<DocumentSnapshot, PortError> {
  if (metadata && validateSnapshot({ text: '', fileMetadata: metadata }))
    return localFailure('invalid-input', 'Некорректные метаданные кодировки');
  if (!metadata && unsupportedBom(bytes))
    return localFailure('unsupported', 'UTF-16 и UTF-32 пока не поддерживаются');
  let fileMetadata = metadata;
  let text: string;
  if (fileMetadata) {
    if (fileMetadata.bom && !hasPrefix(bytes, [...utf8Bom]))
      return localFailure('encoding-error', 'Ожидаемый UTF-8 BOM отсутствует');
    try {
      text =
        fileMetadata.encoding === 'utf-8'
          ? utf8.decode(fileMetadata.bom ? bytes.subarray(3) : bytes)
          : iconv.decode(bytes, 'windows-1251', { stripBOM: false });
    } catch {
      return localFailure('encoding-error', 'Некорректная последовательность UTF-8');
    }
  } else {
    const bom = hasPrefix(bytes, [...utf8Bom]);
    try {
      text = utf8.decode(bom ? bytes.subarray(3) : bytes);
      fileMetadata = { encoding: 'utf-8', bom };
    } catch {
      if (bom) return localFailure('encoding-error', 'Некорректный UTF-8 после BOM');
      text = iconv.decode(bytes, 'windows-1251', { stripBOM: false });
      fileMetadata = { encoding: 'windows-1251', bom: false };
    }
  }
  const snapshot = { text, fileMetadata };
  const encoded = encodeFile(snapshot);
  if (!encoded.ok) return encoded;
  if (!encoded.value.equals(bytes))
    return localFailure('encoding-error', 'Файл нельзя декодировать без потери байтов');
  return { ok: true, value: copyFrozen(snapshot) };
}
