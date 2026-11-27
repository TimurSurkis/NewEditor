import type { Result, SourceSelection, TransactionBody } from '../../core';
import { validSelection } from '../../core';
import { descendants, markdownAction, parseMarkdown, sourceRange, visualInsert } from './markdown';
import type { ParsedMarkdown } from './markdown';
import { mapText } from './source-map';

export type InlineStyle = 'strong' | 'emphasis' | 'strike' | 'code';
export type BasicMarkdownAction =
  | { readonly kind: 'inline'; readonly style: InlineStyle; readonly enabled: boolean }
  | { readonly kind: 'heading'; readonly level: 0 | 1 | 2 | 3 | 4 | 5 | 6 };
export interface MarkdownPlan {
  readonly body: TransactionBody;
  readonly selection: SourceSelection;
}
export interface MarkdownCommandError {
  readonly code: 'unsupported' | 'invalid-input';
  readonly message: string;
}
const rejected = (
  message = 'Этот диапазон пока изменяется в исходном режиме',
): Result<never, MarkdownCommandError> => ({ ok: false, error: { code: 'unsupported', message } });
const styles = {
  strong: 'strong',
  emphasis: 'emphasis',
  strike: 'delete',
  code: 'inlineCode',
} as const;
export function markdownVisibleSelection(
  parsed: ParsedMarkdown,
  selection: SourceSelection,
): boolean {
  const from = Math.min(selection.anchor, selection.head),
    to = Math.max(selection.anchor, selection.head);
  return descendants(parsed.tree).some((node) => {
    if (node.type !== 'paragraph' && node.type !== 'heading' && node.type !== 'tableCell')
      return false;
    if (
      descendants(node).some((child) => child.type === 'html') ||
      /^:::[\w-]+/.test(parsed.text.slice(sourceRange(node).from))
    )
      return false;
    return descendants(node).some((leaf) => {
      const range = sourceRange(leaf);
      if (leaf.type !== 'text' || range.from > from || range.to < to) return false;
      const raw = parsed.text.slice(range.from, range.to),
        map = mapText(raw, true);
      return (
        map.boundaries.includes(from - range.from) &&
        map.boundaries.includes(to - range.from) &&
        mapText(parsed.text.slice(from, to), true).text === parsed.text.slice(from, to)
      );
    });
  });
}
export function markdownStyleState(
  parsed: ParsedMarkdown,
  selection: SourceSelection,
  style: InlineStyle,
): boolean | 'mixed' {
  const from = Math.min(selection.anchor, selection.head),
    to = Math.max(selection.anchor, selection.head);
  const nodes = descendants(parsed.tree).filter(
    (node) =>
      node.type === styles[style] && sourceRange(node).from < to && sourceRange(node).to > from,
  );
  return nodes.some((node) => sourceRange(node).from <= from && sourceRange(node).to >= to)
    ? true
    : nodes.length
      ? 'mixed'
      : false;
}

export function planBasicMarkdown(
  parsed: ParsedMarkdown,
  selection: SourceSelection,
  action: BasicMarkdownAction,
): Result<MarkdownPlan, MarkdownCommandError> {
  const text = parsed.text;
  if (!validSelection(text, selection))
    return {
      ok: false,
      error: { code: 'invalid-input', message: 'Некорректное выделение Markdown' },
    };
  const from = Math.min(selection.anchor, selection.head),
    to = Math.max(selection.anchor, selection.head);
  const all = descendants(parsed.tree);
  const contains = (node: (typeof all)[number]) =>
    sourceRange(node).from <= from && sourceRange(node).to >= to;
  const intersects = (node: (typeof all)[number]) =>
    from === to
      ? sourceRange(node).from <= from && sourceRange(node).to > from
      : sourceRange(node).from < to && sourceRange(node).to > from;
  const block = all
    .filter((node) => ['paragraph', 'heading', 'tableCell'].includes(node.type) && contains(node))
    .at(-1);
  if (
    !block ||
    all.some(
      (node) =>
        ['html', 'definition', 'footnoteDefinition', 'footnoteReference'].includes(node.type) &&
        intersects(node),
    ) ||
    descendants(block).some((node) => node.type === 'html') ||
    /^:::[\w-]+/.test(text.slice(sourceRange(block).from, sourceRange(block).to))
  )
    return rejected();
  if (action.kind === 'heading') {
    if (block.type !== 'paragraph' && block.type !== 'heading') return rejected();
    const range = sourceRange(block),
      raw = text.slice(range.from, range.to);
    const setext = /(?:\r\n|\r|\n)[ \t]*(?:=+|-+)[ \t]*$/.exec(raw);
    const first = setext ? raw.slice(0, setext.index) : raw;
    if (/[\r\n]/.test(first))
      return rejected('Многострочный заголовок пока изменяется в исходном режиме');
    const opening =
      block.type === 'heading' && !setext ? (/^#{1,6}(?:[ \t]+|$)/.exec(first)?.[0] ?? '') : '';
    const content = opening ? first.slice(opening.length).replace(/[ \t]+#+[ \t]*$/, '') : first;
    let insert: string;
    if (action.level === 0) insert = content;
    else if (!setext && opening) {
      const hashes = '#'.repeat(action.level);
      insert = raw.replace(/^#{1,6}/, hashes).replace(/([ \t]+)#+([ \t]*)$/, `$1${hashes}$2`);
    } else insert = `${'#'.repeat(action.level)} ${content}`;
    const oldStart = range.from + opening.length,
      newStart =
        range.from +
        (action.level === 0 ? 0 : (/^#{1,6}(?:[ \t]+|$)/.exec(insert)?.[0].length ?? 0));
    const map = (at: number) => newStart + Math.max(0, Math.min(content.length, at - oldStart));
    return {
      ok: true,
      value: {
        body: { changes: insert === raw ? [] : [{ ...range, insert }] },
        selection: { anchor: map(selection.anchor), head: map(selection.head) },
      },
    };
  }
  if (from === to) return rejected('Выделите текст для форматирования');
  if (all.some((node) => node.type === 'code' && intersects(node))) return rejected();
  const inlineCode = all.find((node) => node.type === 'inlineCode' && contains(node));
  if (action.style === 'code' && !action.enabled) {
    if (!inlineCode || inlineCode.type !== 'inlineCode') return rejected();
    const range = sourceRange(inlineCode),
      raw = text.slice(range.from, range.to);
    const marker = /^`+/.exec(raw)![0].length;
    let body = raw.slice(marker, -marker),
      start = range.from + marker;
    if (body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) {
      body = body.slice(1, -1);
      start++;
    }
    if (from !== start || to !== start + body.length || /[\r\n]/.test(body))
      return rejected('Для снятия кода выделите всё его содержимое');
    const insert = visualInsert(text, inlineCode.value, 'text');
    return {
      ok: true,
      value: {
        body: { changes: [{ ...range, insert }] },
        selection: { anchor: range.from, head: range.from + insert.length },
      },
    };
  }
  if (all.some((node) => node.type === 'inlineCode' && intersects(node)))
    return action.style === 'code' && action.enabled && inlineCode
      ? { ok: true, value: { body: { changes: [] }, selection } }
      : rejected();
  // Оба конца должны быть видимыми границами текстового листа, а не частью escape/entity/маркера.
  const visibleBoundary = (at: number) =>
    all.some((node) => {
      if (node.type !== 'text') return false;
      const range = sourceRange(node);
      return (
        range.from <= at &&
        range.to >= at &&
        mapText(text.slice(range.from, range.to), true).boundaries.includes(at - range.from)
      );
    });
  if (!visibleBoundary(from) || !visibleBoundary(to)) return rejected();
  if (
    all.some(
      (node) =>
        ['strong', 'emphasis', 'delete', 'link', 'linkReference'].includes(node.type) &&
        intersects(node) &&
        (sourceRange(node).from < from && sourceRange(node).to > from) !==
          (sourceRange(node).from < to && sourceRange(node).to > to),
    )
  )
    return rejected(
      'Выделение пересекает часть парных маркеров; уточните диапазон в исходном режиме',
    );
  if (action.style === 'code') {
    const leaf = all.find((node) => node.type === 'text' && contains(node));
    if (!leaf || /[\r\n]/.test(text.slice(from, to))) return rejected();
    const value = mapText(text.slice(from, to), true).text;
    const length = Math.max(1, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1));
    const marker = '`'.repeat(length),
      padding = /^`|`$/.test(value) || (/^ .* $/.test(value) && /[^ ]/.test(value)) ? ' ' : '';
    const insert = marker + padding + value + padding + marker,
      start = from + length + padding.length;
    return {
      ok: true,
      value: {
        body: { changes: [{ from, to, insert }] },
        selection: { anchor: start, head: start + value.length },
      },
    };
  }
  if (action.enabled && /^\s|\s$/.test(text.slice(from, to)))
    return rejected('Для inline-стиля выделите текст без пробелов по краям');
  if (markdownStyleState(parsed, selection, action.style) === 'mixed')
    return rejected('Смешанное форматирование этого диапазона ещё не подключено');
  const body = markdownAction(parsed, selection, {
    kind: 'set-inline',
    mark: action.style,
    enabled: action.enabled,
  });
  if (!body.ok) return rejected(body.error.message);
  if (!body.value.changes.length) return { ok: true, value: { body: body.value, selection } };
  const amount = action.style === 'emphasis' ? 1 : 2;
  if (action.enabled) {
    const change = body.value.changes[0]!;
    const preview = parseMarkdown(
      text.slice(0, change.from) + change.insert + text.slice(change.to),
    );
    // Парсер должен распознать именно добавленную пару, а не поглотить соседние маркеры.
    if (
      !descendants(preview.tree).some(
        (node) =>
          node.type === styles[action.style] &&
          sourceRange(node).from === from &&
          sourceRange(node).to === to + amount * 2,
      )
    )
      return rejected(
        'Добавляемые маркеры неоднозначны рядом с исходными; уточните диапазон в исходном режиме',
      );
  }
  const offset = action.enabled ? amount : -(from - body.value.changes[0]!.from);
  return {
    ok: true,
    value: {
      body: body.value,
      selection: { anchor: selection.anchor + offset, head: selection.head + offset },
    },
  };
}
