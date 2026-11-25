import { expect, it } from 'vitest';
import { findTextMatches, replacementChanges } from '../../src/application';
import { applyTransaction, createEditState } from '../../src/core';
import { transaction, value } from '../support/documents';

it('поиск буквальный, Unicode-aware и не нормализует NFC/NFD', () => {
  expect(findTextMatches('a.* A.* 😀 е\u0308 ё', 'a.*')).toEqual([
    { from: 0, to: 3 },
    { from: 4, to: 7 },
  ]);
  expect(findTextMatches('a A', 'a', true)).toEqual([{ from: 0, to: 1 }]);
  expect(findTextMatches('😀😀', '😀')).toEqual([
    { from: 0, to: 2 },
    { from: 2, to: 4 },
  ]);
  expect(findTextMatches('😀', '\ud83d')).toEqual([]);
  expect(findTextMatches('е\u0308 ё', 'ё')).toEqual([{ from: 3, to: 4 }]);
  expect(findTextMatches('anything', '')).toEqual([]);
  expect(findTextMatches('aaa', 'aa')).toEqual([{ from: 0, to: 2 }]);
});

it('переводит многострочное совпадение на полные исходные CRLF/CR/LF', () => {
  expect(findTextMatches('A\r\nB\rA\nB', 'a\rB')).toEqual([
    { from: 0, to: 4 },
    { from: 5, to: 8 },
  ]);
  expect(findTextMatches('A\r\nB\rC\nD', '\n')).toEqual([
    { from: 1, to: 3 },
    { from: 4, to: 5 },
    { from: 6, to: 7 },
  ]);
});

it('замена буквальна, меняет только совпадения и сохраняет нетронутые окончания', () => {
  const source = 'A\r\nB\rA\nB\n';
  const state = createEditState('doc', 'txt', {
    text: source,
    fileMetadata: { encoding: 'utf-8', bom: false },
  });
  const matches = findTextMatches(source, 'a\nB'),
    changes = replacementChanges(source, matches, '$1\\x\n😀');
  const changed = value(applyTransaction(state, transaction(state, { changes })));
  expect(changed.state.document.text).toBe('$1\\x\n😀\r$1\\x\n😀\n');
  expect(source).toBe('A\r\nB\rA\nB\n');
});
