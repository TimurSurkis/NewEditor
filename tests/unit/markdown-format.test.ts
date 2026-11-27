import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapText, markdownAction, parseMarkdown, visualInsert } from '../../src/formats';
import type { MarkdownAction } from '../../src/formats';
import { createEditState, applyTransaction } from '../../src/core';
import { visualProjection, toSource, toVisual } from '../../src/ui/editors/visual-projection';
import { snapshot, transaction, value } from '../support/documents';

const cases = JSON.parse(
  readFileSync('docs/specifications/fixtures/spec-markdown-cases.json', 'utf8'),
).cases as {
  id: string;
  source: string;
  expected: string;
  action: MarkdownAction & { select?: string };
}[];
describe('Markdown: чистые диапазоны и визуальная проекция', () => {
  it('visual textblock сохраняет soft LF/пробелы при DOM/IME-разборе', () => {
    const projection = visualProjection('## Title\n\nA\nB  C\n\n| A |\n| --- |\n| cell |\n');
    expect(projection.doc.child(0).type.whitespace).toBe('pre');
    expect(projection.doc.child(1).type.whitespace).toBe('pre');
    expect(projection.doc.child(1).textContent).toBe('A\nB  C');
    expect(projection.doc.child(2).child(1).child(0).type.whitespace).toBe('pre');
  });
  it.each(cases)('$id: проекция валидна и ничего не сериализует', (example) => {
    const projection = visualProjection(example.source, 7);
    projection.doc.check();
    expect(projection.parsed.text).toBe(example.source);
    expect(projection.parsed.sourceRevision).toBe(7);
    for (const span of projection.spans)
      if (span.map) {
        for (let i = 0; i < span.map.boundaries.length; i++) {
          const offset = span.map.boundaries[i];
          if (offset != null)
            expect(toSource(projection, span.pmFrom + i, i === 0 ? 1 : -1)).toBe(
              span.from + offset,
            );
        }
      }
  });
  it.each(
    cases.filter(
      (example) =>
        example.action.kind.startsWith('set-') || example.action.kind === 'replace-image-alt',
    ),
  )('$id: команда меняет только заданный фрагмент', (example) => {
    const from = example.source.indexOf(example.action.select!);
    const selection = { anchor: from, head: from + example.action.select!.length };
    const body = value(markdownAction(parseMarkdown(example.source), selection, example.action));
    const state = createEditState('test', 'markdown', snapshot(example.source));
    expect(
      value(applyTransaction(state, transaction(state, body, selection))).state.document.text,
    ).toBe(example.expected);
  });
  it('карта сохраняет CRLF, CR, surrogate и entities без неоднозначных внутренних границ', () => {
    const map = mapText('A\r\nБ\r😀');
    expect(map.text).toBe('A\nБ\n😀');
    expect(map.boundaries).toEqual([0, 1, 3, 4, 5, null, 7]);
    const escaped = mapText('&amp; \\* &#x1f600;', true);
    expect(escaped.text).toBe('& * 😀');
    expect(escaped.boundaries.at(-2)).toBeNull();
    const projection = visualProjection('текст **слово** и [ссылка][ID]\n\n[ID]: /x\n');
    const position = projection.parsed.text.indexOf('слово');
    expect(toSource(projection, toVisual(projection, position))).toBe(position);
  });
  it('не исполняет HTML и не загружает URL изображений', () => {
    const projection = visualProjection(
      '<script>alert(1)</script>\n\n![alt](https://remote.test/x)\n',
    );
    expect(projection.doc.firstChild?.type.name).toBe('opaque');
    expect(JSON.stringify(projection.doc.toJSON())).not.toContain('https://remote.test');
  });
  it('экранирует вставку, но не код; metadata-only parse можно переиспользовать', () => {
    expect(visualInsert('x\r\n', '*a*|b\n', 'text')).toBe('\\*a\\*\\|b\r\n');
    expect(visualInsert('x\r\n', '*a*\n', 'code')).toBe('*a*\r\n');
  });
  it('переиспользует только подходящую ревизию и текст; игнорирует устаревшее дерево', () => {
    const parsed = parseMarkdown('**A**', 1);
    expect(visualProjection('**A**', 1, parsed).parsed).toBe(parsed);
    expect(visualProjection('**A**', 2, parsed).parsed).not.toBe(parsed);
    expect(visualProjection('**B**', 1, parsed).doc.textContent).toBe('B');
  });
  it('не форматирует защищённый HTML или код и не переписывает несколько блоков', () => {
    for (const text of ['<unknown>x</unknown>', '`x`', '```\nx\n```', 'первый\n\nвторой']) {
      expect(
        markdownAction(
          parseMarkdown(text),
          { anchor: 0, head: text.length },
          { kind: 'set-inline', mark: 'strong', enabled: true },
        ),
      ).toMatchObject({ ok: false });
    }
  });
});
