import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyTransaction, createEditState, validSelection } from '../../src/core';
import {
  descendants,
  mapText,
  parseMarkdown,
  planParagraphEdit,
  sourceRange,
  visualInsert,
} from '../../src/formats';
import type { ParagraphAction } from '../../src/formats';
import { setup, snapshot, transaction, value } from '../support/documents';

function selection(source: string, selected: { select?: string; caretAfter?: string }) {
  if (selected.select !== undefined) {
    const at = source.indexOf(selected.select);
    return { anchor: at, head: at + selected.select.length };
  }
  const at = source.indexOf(selected.caretAfter!) + selected.caretAfter!.length;
  return { anchor: at, head: at };
}
function run(
  source: string,
  selected: { select?: string; caretAfter?: string },
  action: ParagraphAction,
) {
  const before = selection(source, selected),
    plan = value(planParagraphEdit(parseMarkdown(source), before, action));
  const state = createEditState('md', 'markdown', snapshot(source));
  const applied = value(
    applyTransaction(state, transaction(state, plan.body, before, plan.selection)),
  );
  expect(validSelection(applied.state.document.text, plan.selection)).toBe(true);
  return { text: applied.state.document.text, plan };
}
const cases = JSON.parse(
  readFileSync('docs/specifications/fixtures/spec-markdown-v1-cases.json', 'utf8'),
).cases as {
  id: string;
  source: string;
  selection: { select?: string; caretAfter?: string };
  expected: string;
  changeScope: string | null;
  pending?: string;
}[];
it('MV-05: split выполняется planner/core с точным исходником, областью и кареткой', () => {
  const example = cases.find((item) => item.id === 'MV-05')!;
  const result = run(example.source, example.selection, { kind: 'split-block' });
  expect(result.text).toBe(example.expected);
  const from = example.source.indexOf(example.changeScope!),
    to = from + example.changeScope!.length;
  expect(result.plan.body.changes.every((change) => change.from >= from && change.to <= to)).toBe(
    true,
  );
  expect(result.plan.selection.head).toBe(result.text.indexOf('beta'));
});
it('MV-16: multiline в tableCell отвергается без текстовой транзакции', () => {
  const example = cases.find((item) => item.id === 'MV-16')!;
  expect(
    planParagraphEdit(parseMarkdown(example.source), selection(example.source, example.selection), {
      kind: 'insert-text',
      text: example.pending!,
    }),
  ).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  expect(example.expected).toBe(example.source);
});
it.each(['\n', '\r\n', '\r'])(
  'split/join сохраняют Unicode/NFD и соседние байты, eol=%j',
  (eol) => {
    const source = `Before.${eol}${eol}A😀e\u0301B${eol}${eol}<div>raw</div>${eol}`;
    const split = run(source, { caretAfter: 'A😀' }, { kind: 'split-block' });
    expect(split.text).toBe(source.replace('A😀e\u0301B', `A😀${eol}${eol}e\u0301B`));
    const joined = run(split.text, { caretAfter: 'A😀' }, { kind: 'join-forward' });
    expect(joined.text).toBe(source);
    expect(run(split.text, { caretAfter: `A😀${eol}${eol}` }, { kind: 'join-backward' }).text).toBe(
      source,
    );
  },
);
it('split внутри strong/emphasis сохраняет стили и пробелы в обеих частях', () => {
  const result = run(
    'Before.\n\na **_alpha beta_** z\n\nAfter.\n',
    { caretAfter: 'alpha' },
    { kind: 'split-block' },
  );
  const tree = parseMarkdown(result.text).tree;
  expect(tree.children.map((node) => node.type)).toEqual([
    'paragraph',
    'paragraph',
    'paragraph',
    'paragraph',
  ]);
  expect(
    descendants(tree)
      .filter((node) => node.type === 'text')
      .map((node) => node.value),
  ).toEqual(['Before.', 'a ', 'alpha', ' beta', ' z', 'After.']);
  expect(descendants(tree).filter((node) => node.type === 'strong')).toHaveLength(2);
  expect(descendants(tree).filter((node) => node.type === 'emphasis')).toHaveLength(2);
});
it('heading split преобразует Setext/closing hashes локально и не создаёт случайный список', () => {
  for (const source of [
    '## alpha - beta ##\r\n\r\nTail.\r\n',
    'alpha - beta\r\n=============\r\n\r\nTail.\r\n',
  ]) {
    const result = run(source, { caretAfter: 'alpha ' }, { kind: 'split-block' });
    const nodes = parseMarkdown(result.text).tree.children;
    expect(nodes.map((node) => node.type)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(
      descendants(nodes[1]!)
        .filter((node) => node.type === 'text')
        .map((node) => node.value),
    ).toEqual(['- beta']);
    expect(result.text.endsWith('\r\n\r\nTail.\r\n')).toBe(true);
  }
});
it('hard break и plain-text paste экранируют разметку и сохраняют logical lines/selection', () => {
  for (const text of ['a\n\n\nb', 'a\n\n\n\nb'])
    expect(
      planParagraphEdit(parseMarkdown('old'), { anchor: 0, head: 3 }, { kind: 'insert-text', text })
        .ok,
    ).toBe(false);
  expect(run('ab\r\n', { caretAfter: 'a' }, { kind: 'hard-break' }).text).toBe('a  \r\nb\r\n');
  const result = run(
    'old\r\n\r\nTail.\r\n',
    { select: 'old' },
    { kind: 'insert-text', text: '# heading\n* item\n\n<script>x</script>' },
  );
  expect(parseMarkdown(result.text).tree.children.map((node) => node.type)).toEqual([
    'paragraph',
    'paragraph',
    'paragraph',
  ]);
  expect(result.text).toContain('\\# heading  \r\n\\* item\r\n\r\n\\<script\\>x\\<\\/script\\>');
  expect(result.text.slice(result.plan.selection.head)).toBe('\r\n\r\nTail.\r\n');
});
it('join не добавляет символ, не теряет видимые/исходные пробелы и переносит целые inline atoms', () => {
  const joined = run(
    'A  \n\nB [link](https://example.test/) `code`\n',
    { caretAfter: 'A' },
    { kind: 'join-forward' },
  );
  expect(joined.text).toContain('A  B');
  expect(joined.text).toContain('[link](https://example.test/)');
  expect(joined.text).toContain('`code`');
  expect(joined.plan.selection.head).toBe(3);
  expect(
    run('**alpha**\n\n_beta_\n', { caretAfter: '**alpha' }, { kind: 'join-forward' }).text,
  ).toBe('**alpha**_beta_\n');
  expect(
    run(
      '[link](https://example.test/)\n\n`code`\n',
      { caretAfter: '[link](https://example.test/)\n\n`' },
      { kind: 'join-backward' },
    ).text,
  ).toBe('[link](https://example.test/)`code`\n');
});
it('одна structural-команда — одна общая undo/redo, отказ не создаёт шага', () => {
  const { app } = setup(),
    id = app.create('markdown');
  const state = app.getSnapshot(id)!.edit;
  value(app.apply(id, transaction(state, { changes: [{ from: 0, to: 0, insert: 'alphabeta' }] })));
  const before = app.getSnapshot(id)!.edit,
    selected = { anchor: 5, head: 5 };
  const plan = value(
    planParagraphEdit(parseMarkdown(before.document.text), selected, { kind: 'split-block' }),
  );
  value(app.apply(id, transaction(before, plan.body, selected, plan.selection)));
  expect(app.getSnapshot(id)!.edit.document.text).toBe('alpha\n\nbeta');
  value(app.undo(id));
  expect(app.getSnapshot(id)!.edit.document.text).toBe('alphabeta');
  value(app.redo(id));
  expect(app.getSnapshot(id)!.edit.document.text).toBe('alpha\n\nbeta');
});
it.each([
  ['<b>raw</b> text', { caretAfter: 'raw' }],
  ['text[^a]\n\n[^a]: footnote', { caretAfter: 'te' }],
  ['- alphabeta', { caretAfter: 'alpha' }],
  ['> alphabeta', { caretAfter: 'alpha' }],
  ['[alphabeta][Ref]\n\n[Ref]: /x', { caretAfter: 'alpha' }],
  ['`alphabeta`', { caretAfter: 'alpha' }],
  ['abc', { caretAfter: 'abc' }],
  ['abc', { caretAfter: '' }],
  ['A &amp; B', { caretAfter: '&a' }],
] as const)('unsupported не меняет состояние: %s', (text, selected) => {
  expect(
    planParagraphEdit(parseMarkdown(text), selection(text, selected), { kind: 'split-block' }),
  ).toMatchObject({ ok: false, error: { code: 'unsupported' } });
});
it('половина Unicode/CRLF, непарный surrogate payload и multi-block range отвергаются', () => {
  for (const [text, anchor, head] of [
    ['A😀B', 2, 2],
    ['A\r\nB', 2, 2],
  ] as const)
    expect(
      planParagraphEdit(parseMarkdown(text), { anchor, head }, { kind: 'split-block' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  expect(
    planParagraphEdit(
      parseMarkdown('ab'),
      { anchor: 1, head: 1 },
      { kind: 'insert-text', text: '\ud800' },
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  expect(
    planParagraphEdit(parseMarkdown('ab\n\ncd'), { anchor: 1, head: 5 }, { kind: 'split-block' })
      .ok,
  ).toBe(false);
});

it('детерминированные разрезы пунктуации/Unicode сохраняют весь видимый текст после split/join', () => {
  const values = ['a * # > - < & \\ ` ~ z', 'a😀e\u0301\t b z', 'a [x](url) &amp; z', 'a  b   z'];
  for (const text of values) {
    const raw = visualInsert(text, text, 'text'),
      map = mapText(raw, true);
    for (const at of map.boundaries.filter(
      (boundary): boundary is number => boundary !== null && boundary > 0 && boundary < raw.length,
    )) {
      const split = run(raw, { caretAfter: raw.slice(0, at) }, { kind: 'split-block' });
      const tree = parseMarkdown(split.text).tree;
      expect(tree.children).toHaveLength(2);
      const end = sourceRange(tree.children[0]!).to;
      const joined = run(
        split.text,
        { caretAfter: split.text.slice(0, end) },
        { kind: 'join-forward' },
      );
      expect(
        descendants(parseMarkdown(joined.text).tree)
          .filter((node) => node.type === 'text')
          .map((node) => node.value)
          .join(''),
      ).toBe(text);
    }
  }
});
