import { decodeString } from 'micromark-util-decode-string';

export interface TextMap {
  readonly text: string;
  readonly boundaries: readonly (number | null)[];
}

export function mapText(raw: string, decode = false): TextMap {
  let text = '';
  const boundaries: (number | null)[] = [0];
  for (let i = 0; i < raw.length;) {
    let size = raw.codePointAt(i)! > 0xffff ? 2 : 1;
    let value = raw.slice(i, i + size);
    if (value === '\r') {
      size = raw[i + 1] === '\n' ? 2 : 1;
      value = '\n';
    } else if (decode && raw[i] === '\\' && raw[i + 1] && /[!-/:-@[-`{-~]/.test(raw[i + 1]!)) {
      size = 2;
      value = raw[i + 1]!;
    } else if (decode && raw[i] === '&') {
      const entity = /^&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/.exec(
        raw.slice(i, i + 64),
      )?.[0];
      if (entity && decodeString(entity) !== entity) {
        size = entity.length;
        value = decodeString(entity);
      }
    }
    text += value;
    for (let j = 1; j < value.length; j++) boundaries.push(null);
    boundaries.push(i + size);
    i += size;
  }
  return { text, boundaries };
}

export function sourceToText(map: TextMap, position: number): number {
  let nearest = 0,
    distance = Infinity;
  for (let i = 0; i < map.boundaries.length; i++) {
    const source = map.boundaries[i];
    if (source !== null && source !== undefined && Math.abs(source - position) < distance) {
      nearest = i;
      distance = Math.abs(source - position);
    }
  }
  return nearest;
}
