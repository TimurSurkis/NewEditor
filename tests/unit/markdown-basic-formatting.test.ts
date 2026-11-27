import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyTransaction, createEditState, validSelection } from '../../src/core';
import {
  markdownStyleState,
  markdownVisibleSelection,
  parseMarkdown,
  planBasicMarkdown,
} from '../../src/formats';
import type { BasicMarkdownAction } from '../../src/formats';
import { snapshot, transaction, value } from '../support/documents';

function apply(source: string, needle: string, action: BasicMarkdownAction, backwards = false) {
  const from = source.indexOf(needle),
    to = from + needle.length;
  const selection = backwards ? { anchor: to, head: from } : { anchor: from, head: to };
  const plan = value(planBasicMarkdown(parseMarkdown(source, 3), selection, action));
  const state = createEditState('md', 'markdown', snapshot(source));
  const result = value(
    applyTransaction(state, transaction(state, plan.body, selection, plan.selection)),
  );
  expect(validSelection(result.state.document.text, plan.selection)).toBe(true);
  return { plan, text: result.state.document.text };
}

const examples = JSON.parse(
  readFileSync('docs/specifications/fixtures/spec-markdown-v1-cases.json', 'utf8'),
).cases as {
  id: string;
  source: string;
  selection: { select: string };
  expected: string;
  changeScope: string;
}[];
it.each(examples.filter((example) => ['MV-01', 'MV-02'].includes(example.id)))(
  '$id: настоящий planner и core, без подстановки expected',
  (example) => {
    const action: BasicMarkdownAction =
      example.id === 'MV-01'
        ? { kind: 'heading', level: 3 }
        : { kind: 'inline', style: 'code', enabled: true };
    const result = apply(example.source, example.selection.select, action);
    expect(result.text).toBe(example.expected);
    const from = example.source.indexOf(example.changeScope),
      to = from + example.changeScope.length;
    expect(result.text.startsWith(example.source.slice(0, from))).toBe(true);
    expect(result.text.endsWith(example.source.slice(to))).toBe(true);
  },
);

it.each(['strong', 'emphasis', 'strike'] as const)(
  '%s: включение/снятие сохраняет Unicode/CRLF и направление выделения',
  (style) => {
    const source = 'A😀 e\u0301\r\n',
      on = apply(source, '😀', { kind: 'inline', style, enabled: true }, true);
    expect(on.plan.selection.anchor).toBeGreaterThan(on.plan.selection.head);
    const off = apply(on.text, '😀', { kind: 'inline', style, enabled: false }, true);
    expect(off.text).toBe(source);
    expect(
      apply(on.text, '😀', { kind: 'inline', style, enabled: true }).plan.body.changes,
    ).toEqual([]);
  },
);

it('ATX сохраняет closing hashes и отступ содержимого; абзац снимает только heading-маркеры', () => {
  expect(
    apply('### Название ###  \n\n* tail\n', 'Название', { kind: 'heading', level: 2 }).text,
  ).toBe('## Название ##  \n\n* tail\n');
  const result = apply('##   **Title** ##\r\n', 'Title', { kind: 'heading', level: 4 });
  expect(result.text).toBe('####   **Title** ####\r\n');
  expect(
    result.text.slice(
      Math.min(result.plan.selection.anchor, result.plan.selection.head),
      Math.max(result.plan.selection.anchor, result.plan.selection.head),
    ),
  ).toBe('Title');
  expect(apply('## **Title** ##\n', 'Title', { kind: 'heading', level: 0 }).text).toBe(
    '**Title**\n',
  );
});

it('inline-code декодирует escapes, выбирает fence/padding и снимается как буквальный текст', () => {
  expect(apply('a\\*b', 'a\\*b', { kind: 'inline', style: 'code', enabled: true }).text).toBe(
    '`a*b`',
  );
  expect(apply('a`', 'a`', { kind: 'inline', style: 'code', enabled: true }).text).toBe('`` a` ``');
  expect(apply('`a*b`', 'a*b', { kind: 'inline', style: 'code', enabled: false }).text).toBe(
    'a\\*b',
  );
  const code = apply('x &amp; y', '&amp;', { kind: 'inline', style: 'code', enabled: true });
  expect(code.text).toBe('x `&` y');
});

it('пустой ATX меняет уровень без добавления видимого текста и снимается в абзац', () => {
  const empty = apply('#', '', { kind: 'heading', level: 3 });
  expect(empty.text).toBe('###');
  expect(empty.plan.selection).toEqual({ anchor: 3, head: 3 });
  expect(apply('## ###\r\n', '', { kind: 'heading', level: 4 }).text).toBe('#### ####\r\n');
  expect(apply('###\n', '', { kind: 'heading', level: 0 }).text).toBe('\n');
});

it('коллизия delimiter-run отклоняется вместо успешной команды с неработающим стилем', () => {
  for (const [text, style] of [
    ['a~', 'strike'],
    ['*a', 'emphasis'],
  ] as const) {
    expect(
      planBasicMarkdown(
        parseMarkdown(text),
        { anchor: 0, head: text.length },
        { kind: 'inline', style, enabled: true },
      ),
    ).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  }
});

it.each([
  '<div>raw</div>\n\ntext',
  'Text <b>raw</b>.',
  'Note[^a]\n\n[^a]: footnote',
  ':::note\nraw\n:::',
])('opaque/footnote не меняется: %s', (source) => {
  const from = source.includes('raw') ? source.indexOf('raw') : source.indexOf('[^a]');
  const result = planBasicMarkdown(
    parseMarkdown(source),
    { anchor: from, head: from + (source.includes('raw') ? 3 : 4) },
    { kind: 'inline', style: 'strong', enabled: true },
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'unsupported' } });
});

it('половина entity/escape/маркер, несколько блоков и пустое выделение отклоняются атомарно', () => {
  for (const [source, from, to] of [
    ['A &amp; B', 3, 5],
    ['A \\* B', 3, 4],
    ['**word**', 0, 5],
    ['one\n\ntwo', 0, 8],
    ['word', 1, 1],
    ['**ab**cd', 3, 7],
    ['A word B', 1, 6],
  ] as const) {
    expect(
      planBasicMarkdown(
        parseMarkdown(source),
        { anchor: from, head: to },
        { kind: 'inline', style: 'strong', enabled: true },
      ).ok,
    ).toBe(false);
  }
  expect(
    planBasicMarkdown(
      parseMarkdown('A😀'),
      { anchor: 1, head: 2 },
      { kind: 'inline', style: 'strong', enabled: true },
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
});

it('видимый source-match отличается от URL/маркера/entity/opaque без полного PM-render', () => {
  const text = '**word** [label](https://example.test/) &amp;\n\n<div>raw</div>\n',
    parsed = parseMarkdown(text);
  const selected = (needle: string) => ({
    anchor: text.indexOf(needle),
    head: text.indexOf(needle) + needle.length,
  });
  expect(markdownVisibleSelection(parsed, selected('word'))).toBe(true);
  expect(markdownVisibleSelection(parsed, selected('label'))).toBe(true);
  for (const needle of ['https', '**word**', '&amp;', 'raw'])
    expect(markdownVisibleSelection(parsed, selected(needle))).toBe(false);
  expect(markdownStyleState(parsed, selected('word'), 'strong')).toBe(true);
  expect(markdownStyleState(parsed, selected('word** [label'), 'strong')).toBe('mixed');
});
