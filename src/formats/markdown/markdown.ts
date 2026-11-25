import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Nodes, Root } from 'mdast';
import type { ModelError, Result, SourceSelection, TransactionBody } from '../../core';
import { preferredLineEnding } from '../../core';

const parser = unified().use(remarkParse).use(remarkGfm);
export interface ParsedMarkdown {
  readonly text: string;
  readonly sourceRevision: number;
  readonly tree: Root;
}
export type MarkdownAction =
  | {
      readonly kind: 'set-inline';
      readonly mark: 'strong' | 'emphasis' | 'strike';
      readonly enabled: boolean;
    }
  | { readonly kind: 'set-heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { readonly kind: 'set-task'; readonly checked: boolean }
  | { readonly kind: 'replace-image-alt'; readonly insert: string };
export function parseMarkdown(text: string, sourceRevision = 0): ParsedMarkdown {
  return { text, sourceRevision, tree: parser.parse(text) };
}
export function sourceRange(node: Nodes): { from: number; to: number } {
  return { from: node.position?.start.offset ?? 0, to: node.position?.end.offset ?? 0 };
}
export function descendants(node: Nodes): Nodes[] {
  return [
    node,
    ...('children' in node ? node.children.flatMap((child) => descendants(child)) : []),
  ];
}
export function imageAltRange(text: string, node: Nodes): { from: number; to: number } | null {
  if (node.type !== 'image') return null;
  const { from, to } = sourceRange(node);
  if (text.slice(from, from + 2) !== '![') return null;
  for (let i = from + 2; i < to; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === ']') return { from: from + 2, to: i };
  }
  return null;
}
const unsupported = (): Result<never, ModelError> => ({
  ok: false,
  error: { code: 'invalid-range', message: 'Этот фрагмент изменяется в исходном режиме' },
});
export function markdownAction(
  parsed: ParsedMarkdown,
  selection: SourceSelection,
  action: MarkdownAction,
): Result<TransactionBody, ModelError> {
  const from = Math.min(selection.anchor, selection.head),
    to = Math.max(selection.anchor, selection.head);
  const nodes = descendants(parsed.tree)
    .filter((node) => {
      const range = sourceRange(node);
      return range.from <= from && range.to >= to;
    })
    .reverse();
  if (action.kind === 'set-inline') {
    if (from === to) return unsupported();
    if (
      !nodes.some((node) => ['paragraph', 'heading', 'tableCell'].includes(node.type)) ||
      descendants(parsed.tree).some((node) => {
        const range = sourceRange(node);
        return (
          range.from < to &&
          range.to > from &&
          (['html', 'definition', 'code', 'inlineCode'].includes(node.type) ||
            (node.type === 'paragraph' &&
              /^:::[\w-]+/.test(parsed.text.slice(range.from, range.to))))
        );
      })
    )
      return unsupported();
    const delimiter = { strong: '**', emphasis: '*', strike: '~~' }[action.mark];
    const type = action.mark === 'strike' ? 'delete' : action.mark;
    const existing = nodes.find((node) => node.type === type);
    if (action.enabled) {
      if (existing) return { ok: true, value: { changes: [] } };
      return {
        ok: true,
        value: {
          changes: [{ from, to, insert: delimiter + parsed.text.slice(from, to) + delimiter }],
        },
      };
    }
    if (!existing || !('children' in existing) || !existing.children.length) return unsupported();
    const range = sourceRange(existing),
      first = sourceRange(existing.children[0]!),
      last = sourceRange(existing.children.at(-1)!);
    if (first.from !== from || last.to !== to) return unsupported();
    return {
      ok: true,
      value: {
        changes: [
          { from: range.from, to: from, insert: '' },
          { from: to, to: range.to, insert: '' },
        ],
      },
    };
  }
  if (action.kind === 'set-task') {
    const item = nodes.find((node) => node.type === 'listItem');
    if (!item) return unsupported();
    const range = sourceRange(item),
      raw = parsed.text.slice(range.from, range.to);
    const match = /^(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/.exec(raw);
    if (!match) return unsupported();
    const at = range.from + match[0].lastIndexOf('[') + 1;
    return {
      ok: true,
      value: { changes: [{ from: at, to: at + 1, insert: action.checked ? 'x' : ' ' }] },
    };
  }
  if (action.kind === 'replace-image-alt') {
    const image = nodes.find((node) => node.type === 'image'),
      range = image && imageAltRange(parsed.text, image);
    return range
      ? {
          ok: true,
          value: { changes: [{ ...range, insert: action.insert.replace(/[\\[\]]/g, '\\$&') }] },
        }
      : unsupported();
  }
  const heading = nodes.find((node) => node.type === 'heading' || node.type === 'paragraph');
  if (!heading) return unsupported();
  const range = sourceRange(heading),
    raw = parsed.text.slice(range.from, range.to);
  if (/[\r\n]/.test(raw)) return unsupported();
  const hashes = '#'.repeat(action.level);
  let insert = /^#{1,6}[ \t]+/.test(raw) ? raw.replace(/^#{1,6}/, hashes) : `${hashes} ${raw}`;
  if (/^#{1,6}[ \t]+/.test(raw)) insert = insert.replace(/([ \t]+)#+([ \t]*)$/, `$1${hashes}$2`);
  return { ok: true, value: { changes: [{ ...range, insert }] } };
}

export function visualInsert(
  text: string,
  insert: string,
  context: 'text' | 'code' | 'inlineCode',
): string {
  const normalized = insert.replace(/\r\n|\r|\n/g, preferredLineEnding(text));
  return context === 'text' ? normalized.replace(/[!-/:-@[-`{-~]/g, '\\$&') : normalized;
}
