import { preferredLineEnding, validBoundary, validSelection, validateSnapshot } from '../../core';
import type { Result, SourceSelection } from '../../core';
import type { MarkdownCommandError, MarkdownPlan } from './basic-formatting';
import { descendants, parseMarkdown, sourceRange, visualInsert } from './markdown';
import type { Nodes } from 'mdast';
import type { ParsedMarkdown } from './markdown';
import { mapText } from './source-map';

export type ParagraphAction =
  | { readonly kind: 'split-block' }
  | { readonly kind: 'hard-break' }
  | { readonly kind: 'join-backward' }
  | { readonly kind: 'join-forward' }
  | { readonly kind: 'insert-text'; readonly text: string };

interface Fragment {
  readonly source: string;
  readonly visible: string;
}
const unsupported = (
  message = 'Этот структурный диапазон пока требует исходный режим',
): Result<never, MarkdownCommandError> => ({
  ok: false,
  error: { code: 'unsupported', message },
});
function visible(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'break') return '\n';
  return 'children' in node ? node.children.map(visible).join('') : '';
}
function safeEdges(text: string): string {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, (edge) =>
    edge
      .replace(/\r\n|\r|\n/g, '&#10;')
      .replace(/ /g, '&#32;')
      .replace(/\t/g, '&#9;'),
  );
}
function safeBlock(node: Nodes): boolean {
  return (
    (node.type === 'paragraph' || node.type === 'heading') &&
    !descendants(node).some((child) =>
      ['html', 'footnoteReference', 'footnoteDefinition'].includes(child.type),
    )
  );
}
function contentRange(node: Nodes) {
  if (!('children' in node) || !node.children.length) return null;
  return { from: sourceRange(node.children[0]!).from, to: sourceRange(node.children.at(-1)!).to };
}
function visibleEdge(parsed: ParsedMarkdown, node: Nodes, end: boolean): number {
  if ('children' in node && node.children.length)
    return visibleEdge(parsed, end ? node.children.at(-1)! : node.children[0]!, end);
  const range = sourceRange(node);
  if (node.type !== 'inlineCode') return end ? range.to : range.from;
  const raw = parsed.text.slice(range.from, range.to),
    marker = /^`+/.exec(raw)?.[0].length ?? 0;
  const body = raw.slice(marker, -marker);
  const padding = body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body) ? 1 : 0;
  return end ? range.to - marker - padding : range.from + marker + padding;
}

// Сериализуется только затронутый inline-фрагмент, никогда весь PM/document.
// Частичный opaque/atom/URL не имеет однозначного разреза и отвергается.
function fragment(
  parsed: ParsedMarkdown,
  nodes: readonly Nodes[],
  from: number,
  to: number,
): Fragment | null {
  let source = '',
    text = '';
  for (const node of nodes) {
    const range = sourceRange(node),
      start = Math.max(from, range.from),
      end = Math.min(to, range.to);
    if (start >= end) continue;
    if (node.type === 'text') {
      const map = mapText(parsed.text.slice(range.from, range.to), true);
      const a = map.boundaries.indexOf(start - range.from),
        b = map.boundaries.indexOf(end - range.from);
      if (a < 0 || b < 0 || map.text !== node.value) return null;
      const value = map.text.slice(a, b);
      source += safeEdges(visualInsert(parsed.text, value, 'text'));
      text += value;
    } else if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
      const inner = contentRange(node);
      if (!inner) return null;
      const part = fragment(parsed, node.children, start, end);
      if (!part) return null;
      if (part.source)
        source +=
          parsed.text.slice(range.from, inner.from) +
          part.source +
          parsed.text.slice(inner.to, range.to);
      text += part.visible;
    } else if (
      ['inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'break'].includes(
        node.type,
      ) &&
      start === range.from &&
      end === range.to
    ) {
      source += parsed.text.slice(start, end);
      text += visible(node);
    } else return null;
  }
  return { source, visible: text };
}
function visibleBoundary(parsed: ParsedMarkdown, node: Nodes, at: number): boolean {
  return descendants(node).some((child) => {
    const range = sourceRange(child);
    if (
      child.type === 'inlineCode' &&
      (at === visibleEdge(parsed, child, false) || at === visibleEdge(parsed, child, true))
    )
      return true;
    if (child.type === 'text' && range.from <= at && range.to >= at)
      return mapText(parsed.text.slice(range.from, range.to), true).boundaries.includes(
        at - range.from,
      );
    return (
      ['inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'break'].includes(
        child.type,
      ) &&
      (range.from === at || range.to === at)
    );
  });
}

export function planParagraphEdit(
  parsed: ParsedMarkdown,
  selection: SourceSelection,
  action: ParagraphAction,
): Result<MarkdownPlan, MarkdownCommandError> {
  if (
    !validSelection(parsed.text, selection) ||
    (action.kind === 'insert-text' &&
      validateSnapshot({ text: action.text, fileMetadata: { encoding: 'utf-8', bom: false } }) !==
        null)
  )
    return {
      ok: false,
      error: {
        code: 'invalid-input',
        message: 'Некорректный Unicode/диапазон структурной команды',
      },
    };
  const from = Math.min(selection.anchor, selection.head),
    to = Math.max(selection.anchor, selection.head);
  if (action.kind === 'insert-text' && action.text === '' && from === to)
    return { ok: true, value: { body: { changes: [] }, selection } };
  const index = parsed.tree.children.findIndex(
    (node) => sourceRange(node).from <= from && sourceRange(node).to >= to,
  );
  const block = parsed.tree.children[index];
  if (
    !block ||
    !safeBlock(block) ||
    !('children' in block) ||
    /^:::[\w-]+/.test(parsed.text.slice(sourceRange(block).from))
  )
    return unsupported();
  const content = contentRange(block);
  if (!content || !visibleBoundary(parsed, block, from) || !visibleBoundary(parsed, block, to))
    return unsupported();
  const joining = action.kind === 'join-backward' || action.kind === 'join-forward';
  const before = joining
      ? { source: '', visible: '' }
      : fragment(parsed, block.children, content.from, from),
    after = joining
      ? { source: '', visible: '' }
      : fragment(parsed, block.children, to, content.to);
  if (!before || !after) return unsupported();
  const eol = preferredLineEnding(parsed.text),
    range = sourceRange(block);
  const tail = block.type === 'paragraph' ? parsed.text.slice(content.to, range.to) : '';
  if (!/^[ \t]*$/.test(tail)) return unsupported();
  let start = range.from,
    end = range.to,
    insert: string,
    caret: number,
    replaced = 1;
  let expected: readonly { readonly type: 'paragraph' | 'heading'; readonly text: string }[];
  const prefix = block.type === 'heading' ? '#'.repeat(block.depth) + ' ' : '';
  if (action.kind === 'join-backward' || action.kind === 'join-forward') {
    if (from !== to || block.type !== 'paragraph') return unsupported();
    const backward = action.kind === 'join-backward';
    if (from !== visibleEdge(parsed, block, !backward)) return unsupported();
    const other = parsed.tree.children[index + (backward ? -1 : 1)];
    if (!other) return { ok: true, value: { body: { changes: [] }, selection } };
    if (
      other.type !== 'paragraph' ||
      !safeBlock(other) ||
      /^:::[\w-]+/.test(parsed.text.slice(sourceRange(other).from))
    )
      return unsupported('Соединяются только соседние обычные абзацы');
    const otherContent = contentRange(other);
    if (!otherContent) return unsupported();
    const otherPart = fragment(parsed, other.children, otherContent.from, otherContent.to);
    const thisPart = fragment(parsed, block.children, content.from, content.to);
    if (!otherPart || !thisPart) return unsupported();
    const otherTail = parsed.text.slice(otherContent.to, sourceRange(other).to);
    if (!/^[ \t]*$/.test(otherTail)) return unsupported();
    const left = backward ? otherPart : thisPart,
      right = backward ? thisPart : otherPart;
    const leftTail = backward ? otherTail : tail,
      rightTail = backward ? tail : otherTail;
    start = backward ? sourceRange(other).from : range.from;
    end = backward ? range.to : sourceRange(other).to;
    insert = left.source + leftTail + right.source + rightTail;
    caret = start + left.source.length + leftTail.length;
    replaced = 2;
    expected = [{ type: 'paragraph', text: left.visible + leftTail + right.visible }];
  } else if (action.kind === 'split-block') {
    if (!before.visible || !after.visible)
      return unsupported(
        'Enter на краю/в пустом блоке ещё не подключён; ввод сохранён для исходного режима',
      );
    insert = prefix + before.source + eol + eol + after.source + tail;
    caret = start + prefix.length + before.source.length + eol.length * 2;
    expected = [
      { type: block.type as 'paragraph' | 'heading', text: before.visible },
      { type: 'paragraph', text: after.visible },
    ];
  } else {
    if (action.kind === 'hard-break' && block.type !== 'paragraph')
      return unsupported('Hard break поддерживается в обычном абзаце');
    const payload = action.kind === 'hard-break' ? '\n' : action.text.replace(/\r\n|\r/g, '\n');
    if (block.type === 'heading' && payload.includes('\n'))
      return unsupported('Многострочная вставка в заголовок пока требует исходный режим');
    if (/\n{3,}/.test(payload))
      return unsupported(
        'Несколько пустых строк требуют ещё не подключённых пустых блоков; ввод сохранён',
      );
    const chunks = payload.split(/\n{2,}/),
      pieces = chunks.map((chunk) =>
        chunk
          .split('\n')
          .map((line) => safeEdges(visualInsert(parsed.text, line, 'text')))
          .join('  ' + eol),
      );
    pieces[0] = before.source + pieces[0]!;
    const last = pieces.length - 1;
    caret = start + prefix.length + pieces.join(eol + eol).length;
    pieces[last] += after.source + tail;
    const texts = chunks.map(
      (chunk, at) => (at === 0 ? before.visible : '') + chunk + (at === last ? after.visible : ''),
    );
    if (texts.some((text) => !text))
      return unsupported(
        'Пустые результирующие блоки ещё не подключены; ввод сохранён для исходного режима',
      );
    insert = prefix + pieces.join(eol + eol);
    expected = texts.map((text, at) => ({
      type: at === 0 ? (block.type as 'paragraph' | 'heading') : 'paragraph',
      text,
    }));
  }
  const previewText = parsed.text.slice(0, start) + insert + parsed.text.slice(end),
    preview = parseMarkdown(previewText);
  const resultIndex = action.kind === 'join-backward' ? index - 1 : index;
  const changed = preview.tree.children.slice(resultIndex, resultIndex + expected.length);
  if (
    preview.tree.children.length !== parsed.tree.children.length - replaced + expected.length ||
    changed.length !== expected.length ||
    changed.some(
      (node, at) => node.type !== expected[at]!.type || visible(node) !== expected[at]!.text,
    )
  )
    return unsupported('Результат неоднозначен для Markdown; исходник не изменён');
  if (!validBoundary(previewText, caret)) return unsupported();
  // Сужаем исходный диапазон правки, не трогая совпадающие края блока.
  const raw = parsed.text.slice(start, end);
  let leading = 0,
    trailing = 0;
  while (leading < raw.length && leading < insert.length && raw[leading] === insert[leading])
    leading++;
  while (
    leading > 0 &&
    (!validBoundary(parsed.text, start + leading) || !validBoundary(insert, leading))
  )
    leading--;
  while (
    trailing < raw.length - leading &&
    trailing < insert.length - leading &&
    raw[raw.length - trailing - 1] === insert[insert.length - trailing - 1]
  )
    trailing++;
  while (
    trailing > 0 &&
    (!validBoundary(parsed.text, end - trailing) ||
      !validBoundary(insert, insert.length - trailing))
  )
    trailing--;
  return {
    ok: true,
    value: {
      body: {
        changes:
          raw === insert
            ? []
            : [
                {
                  from: start + leading,
                  to: end - trailing,
                  insert: insert.slice(leading, insert.length - trailing),
                },
              ],
      },
      selection: { anchor: caret, head: caret },
    },
  };
}
