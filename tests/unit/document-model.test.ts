import { describe, expect, it } from 'vitest';
import {
  applyTransaction,
  createEditState,
  EditHistory,
  equalSnapshots,
  preferredLineEnding,
  validBoundary,
} from '../../src/core';
import type { EditState, FileMetadata, TextChange } from '../../src/core';
import { selection, snapshot, transaction, value } from '../support/documents';

const state = (text = '') => createEditState('doc', 'markdown', snapshot(text));

describe('модель и транзакции DM-01–DM-06', () => {
  it('создаёт новый документ и не изменяет исходные данные', () => {
    const source = { text: 'текст\r\n', fileMetadata: { encoding: 'utf-8' as const, bom: false } };
    const edit = createEditState('id', 'txt', source);
    source.fileMetadata.bom = true;
    expect(edit).toMatchObject({
      stateRevision: 0,
      document: {
        text: 'текст\r\n',
        location: null,
        sourceRevision: 0,
        fileMetadata: { encoding: 'utf-8', bom: false },
      },
    });
    expect(Object.isFrozen(edit.document.fileMetadata)).toBe(true);
    expect(() => createEditState('', 'txt')).toThrow();
    expect(() => createEditState('id', 'txt', snapshot('\ud800'))).toThrow();
  });
  it('учитывает точный текст, кодировку и BOM при сравнении', () => {
    expect(equalSnapshots(snapshot('e\u0301'), snapshot('é'))).toBe(false);
    expect(equalSnapshots(snapshot('x\n'), snapshot('x\r\n'))).toBe(false);
    expect(
      equalSnapshots(snapshot('x'), {
        ...snapshot('x'),
        fileMetadata: { encoding: 'utf-8', bom: true },
      }),
    ).toBe(false);
  });
  it('metadata-only транзакция меняет stateRevision, но не sourceRevision; inverse точен', () => {
    const edit = state('абв');
    const result = value(
      applyTransaction(
        edit,
        transaction(edit, { changes: [], fileMetadata: { encoding: 'windows-1251', bom: false } }),
      ),
    );
    expect(result.state).toMatchObject({ stateRevision: 1, document: { sourceRevision: 0 } });
    const undo = value(applyTransaction(result.state, transaction(result.state, result.inverse!)));
    expect(equalSnapshots(undo.state.document, edit.document)).toBe(true);
    expect(undo.state.stateRevision).toBe(2);
  });
  it.each([
    [{ from: -1, to: 0, insert: '' }],
    [{ from: 0.5, to: 1, insert: '' }],
    [{ from: 0, to: 99, insert: '' }],
    [{ from: 3, to: 1, insert: '' }],
    [{ from: 2, to: 3, insert: '' }],
    [{ from: 5, to: 5, insert: '' }],
    [
      { from: 0, to: 3, insert: '' },
      { from: 1, to: 4, insert: '' },
    ],
    [
      { from: 1, to: 1, insert: 'x' },
      { from: 1, to: 1, insert: 'y' },
    ],
    [
      { from: 3, to: 3, insert: 'x' },
      { from: 0, to: 0, insert: 'y' },
    ],
  ])('атомарно отклоняет неправильные диапазоны %j', (...changes) => {
    const edit = state('A😀Б\r\n');
    const tx = transaction(edit, { changes: changes as TextChange[] });
    expect(applyTransaction(edit, tx)).toMatchObject({
      ok: false,
      error: { code: 'invalid-range' },
    });
    expect(edit.document.text).toBe('A😀Б\r\n');
    expect(edit.stateRevision).toBe(0);
  });
  it('различает ошибки документа, ревизии, вставки, метаданных и выделения', () => {
    const edit = state('A😀Б\r\n'),
      tx = transaction(edit, { changes: [] });
    expect(applyTransaction(edit, { ...tx, documentId: 'other' })).toMatchObject({
      ok: false,
      error: { code: 'wrong-document' },
    });
    expect(applyTransaction(edit, { ...tx, baseStateRevision: 1 })).toMatchObject({
      ok: false,
      error: { code: 'stale-revision' },
    });
    expect(
      applyTransaction(edit, { ...tx, body: { changes: [{ from: 0, to: 0, insert: '\udfff' }] } }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-text' } });
    expect(
      applyTransaction(edit, {
        ...tx,
        body: { changes: [], fileMetadata: { encoding: 'windows-1251', bom: true } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-metadata' } });
    expect(applyTransaction(edit, { ...tx, selectionBefore: selection(2) })).toMatchObject({
      ok: false,
      error: { code: 'invalid-selection' },
    });
    expect(applyTransaction(edit, { ...tx, selectionAfter: selection(5) })).toMatchObject({
      ok: false,
      error: { code: 'invalid-selection' },
    });
  });
  it('сохраняет направление выделения и не нормализует Unicode', () => {
    const edit = state('😀 e\u0301');
    const result = value(
      applyTransaction(
        edit,
        transaction(
          edit,
          { changes: [{ from: 0, to: 2, insert: '**😀**' }] },
          selection(2, 0),
          selection(6, 0),
        ),
      ),
    );
    expect(result.state.document.text).toBe('**😀** e\u0301');
    expect(result.selection).toEqual(selection(6, 0));
  });
  it('no-op сохраняет ссылку состояния и обе ревизии', () => {
    const edit = state('x');
    const result = value(
      applyTransaction(edit, transaction(edit, { changes: [{ from: 0, to: 1, insert: 'x' }] })),
    );
    expect(result).toMatchObject({ changed: false, inverse: null });
    expect(result.state).toBe(edit);
  });
  it('проверяет переполнение атомарно, но допускает no-op на пределе', () => {
    const edit = { ...state(), stateRevision: Number.MAX_SAFE_INTEGER };
    expect(
      applyTransaction(edit, transaction(edit, { changes: [{ from: 0, to: 0, insert: 'x' }] })),
    ).toMatchObject({ ok: false, error: { code: 'revision-overflow' } });
    expect(value(applyTransaction(edit, transaction(edit, { changes: [] }))).state).toBe(edit);
  });
  it.each([
    [
      'abcd',
      [
        { from: 0, to: 1, insert: '' },
        { from: 1, to: 2, insert: '' },
      ],
    ],
    ['\rX\n', [{ from: 1, to: 2, insert: '' }]],
    ['X\n', [{ from: 0, to: 1, insert: '\r' }]],
    ['\rX', [{ from: 1, to: 2, insert: '\n' }]],
  ] as [string, TextChange[]][])('строит валидный inverse для %j', (text, changes) => {
    const edit = state(text),
      applied = value(applyTransaction(edit, transaction(edit, { changes })));
    const restored = value(
      applyTransaction(applied.state, transaction(applied.state, applied.inverse!)),
    );
    expect(restored.state.document.text).toBe(text);
  });
  it.each([
    ['', '\n'],
    ['a\rb\n', '\r'],
    ['a\r\nb\nc\n', '\n'],
    ['a\r\nb\n', '\r\n'],
  ])('выбирает перевод строк для %j', (text, ending) => {
    expect(preferredLineEnding(text)).toBe(ending);
  });
  it('3000 детерминированных наборов сохраняют текст вне правок и проходят обратную транзакцию', () => {
    let randomState = 20261124;
    const random = (n: number) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState % n;
    };
    const alphabet = ['a', 'Б', '😀', '\r', '\n', 'e\u0301'];
    const text = () =>
      Array.from({ length: random(15) }, () => alphabet[random(alphabet.length)]!).join('');
    for (let i = 0; i < 3000; i++) {
      const original = text(),
        edit = state(original);
      const boundaries = Array.from({ length: original.length + 1 }, (_, n) => n).filter((n) =>
        validBoundary(original, n),
      );
      const points = [
        ...new Set(Array.from({ length: 6 }, () => boundaries[random(boundaries.length)]!)),
      ].sort((a, b) => a - b);
      const changes: TextChange[] = [];
      for (let j = 0; j < points.length; j += 2)
        changes.push({ from: points[j]!, to: points[j + 1] ?? points[j]!, insert: text() });
      let expected = original;
      for (const change of [...changes].reverse())
        expected = expected.slice(0, change.from) + change.insert + expected.slice(change.to);
      const applied = value(applyTransaction(edit, transaction(edit, { changes })));
      expect(applied.state.document.text).toBe(expected);
      if (applied.inverse)
        expect(
          value(applyTransaction(applied.state, transaction(applied.state, applied.inverse))).state
            .document.text,
        ).toBe(original);
    }
  });
});

describe('общая история', () => {
  it('отменяет и повторяет группу атомарно с одной ревизией', () => {
    const history = new EditHistory();
    let edit = state();
    for (const char of ['a', '😀', 'б']) {
      const at = edit.document.text.length;
      edit = value(
        history.apply(
          edit,
          transaction(
            edit,
            { changes: [{ from: at, to: at, insert: char }] },
            selection(at),
            selection(at + char.length),
            'typing',
          ),
          true,
        ),
      ).state;
    }
    const undone = value(history.undo(edit, selection(edit.document.text.length)));
    expect(undone.state.document.text).toBe('');
    expect(undone.state.stateRevision).toBe(4);
    const redone = value(history.redo(undone.state, selection()));
    expect(redone.state.document.text).toBe('a😀б');
    expect(redone.state.stateRevision).toBe(5);
  });
  it('ошибки и no-op сохраняют redo, новая правка очищает его', () => {
    const history = new EditHistory(),
      initial = state();
    const edited = value(
      history.apply(initial, transaction(initial, { changes: [{ from: 0, to: 0, insert: 'a' }] })),
    ).state;
    const undone = value(history.undo(edited, selection())).state;
    history.apply(undone, transaction(undone, { changes: [] }));
    history.apply(undone, { ...transaction(undone, { changes: [] }), baseStateRevision: 0 });
    expect(history.canRedo).toBe(true);
    history.apply(undone, transaction(undone, { changes: [{ from: 0, to: 0, insert: 'b' }] }));
    expect(history.canRedo).toBe(false);
  });
  it('предел — 200 групп; пустой undo не меняет состояние', () => {
    const history = new EditHistory();
    let edit: EditState = state();
    for (let i = 0; i < 201; i++)
      edit = value(
        history.apply(edit, transaction(edit, { changes: [{ from: 0, to: 0, insert: 'x' }] })),
      ).state;
    for (let i = 0; i < 200; i++) edit = value(history.undo(edit, selection())).state;
    expect(edit.document.text).toBe('x');
    expect(history.canUndo).toBe(false);
    expect(value(history.undo(edit, selection())).state).toBe(edit);
  });
  it('не меняет историю при переполнении undo', () => {
    const history = new EditHistory(),
      edit = state('x');
    const changed = value(
      history.apply(edit, transaction(edit, { changes: [{ from: 0, to: 1, insert: 'y' }] })),
    ).state;
    expect(
      history.undo({ ...changed, stateRevision: Number.MAX_SAFE_INTEGER }, selection()),
    ).toMatchObject({ ok: false });
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });
  it('метаданные отменяются без увеличения текстовой ревизии', () => {
    const history = new EditHistory(),
      edit = state('x');
    const metadata: FileMetadata = { encoding: 'utf-8', bom: true };
    const changed = value(
      history.apply(edit, transaction(edit, { changes: [], fileMetadata: metadata })),
    ).state;
    const undone = value(history.undo(changed, selection())).state;
    expect(undone.document.sourceRevision).toBe(0);
    expect(undone.document.fileMetadata.bom).toBe(false);
  });
});
