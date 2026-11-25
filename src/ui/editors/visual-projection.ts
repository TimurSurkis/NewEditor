import { Schema } from 'prosemirror-model';
import type { Mark, Node as PMNode, NodeSpec } from 'prosemirror-model';
import {
  descendants,
  imageAltRange,
  mapText,
  parseMarkdown,
  sourceRange,
  sourceToText,
} from '../../formats';
import type { Nodes, ParsedMarkdown, TextMap } from '../../formats';

const block = (tag: string): NodeSpec => ({
  group: 'block',
  content: 'block*',
  parseDOM: [{ tag }],
  toDOM: () => [tag, 0],
});
const textblock = (tag: string): NodeSpec => ({
  group: 'block',
  content: 'inline*',
  parseDOM: [{ tag }],
  toDOM: () => [tag, 0],
});
export const visualSchema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    text: { group: 'inline' },
    paragraph: textblock('p'),
    heading: {
      ...textblock('h1'),
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${node.attrs['level']}`, 0],
    },
    blockquote: block('blockquote'),
    bullet_list: block('ul'),
    ordered_list: {
      ...block('ol'),
      attrs: { start: { default: 1 } },
      toDOM: (node) => ['ol', { start: node.attrs['start'] }, 0],
    },
    list_item: {
      ...block('li'),
      attrs: { checked: { default: null }, from: { default: 0 } },
      toDOM: (node) =>
        node.attrs['checked'] === null
          ? ['li', 0]
          : [
              'li',
              { 'data-task-item': '' },
              [
                'span',
                { contenteditable: 'false' },
                [
                  'input',
                  {
                    type: 'checkbox',
                    'aria-label': 'Задача',
                    'data-task-from': node.attrs['from'],
                    ...(node.attrs['checked'] ? { checked: 'checked' } : {}),
                  },
                ],
              ],
              ['div', 0],
            ],
    },
    table: {
      group: 'block',
      content: 'table_row+',
      parseDOM: [{ tag: 'table' }],
      toDOM: () => ['table', ['tbody', 0]],
    },
    table_row: { content: 'table_cell+', parseDOM: [{ tag: 'tr' }], toDOM: () => ['tr', 0] },
    table_cell: {
      content: 'inline*',
      parseDOM: [{ tag: 'td' }, { tag: 'th', attrs: { header: true } }],
      attrs: { header: { default: false } },
      toDOM: (node) => [node.attrs['header'] ? 'th' : 'td', 0],
    },
    code_block: {
      group: 'block',
      content: 'text*',
      code: true,
      marks: '',
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: () => ['pre', ['code', 0]],
    },
    hard_break: { group: 'inline', inline: true, selectable: false, toDOM: () => ['br'] },
    rule: { group: 'block', atom: true, toDOM: () => ['hr'] },
    opaque: {
      group: 'block',
      atom: true,
      attrs: { raw: {}, from: {}, to: {} },
      toDOM: (node) => [
        'pre',
        {
          'data-opaque': '',
          'data-source-from': node.attrs['from'],
          contenteditable: 'false',
          title: 'Редактируется в исходном режиме',
        },
        node.attrs['raw'],
      ],
    },
    opaque_inline: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { raw: {}, from: {}, to: {} },
      toDOM: (node) => [
        'code',
        { 'data-opaque': '', 'data-source-from': node.attrs['from'], contenteditable: 'false' },
        node.attrs['raw'],
      ],
    },
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { alt: {}, from: {}, to: {} },
      toDOM: (node) => [
        'span',
        {
          'data-image-alt': node.attrs['alt'],
          contenteditable: 'false',
          role: 'img',
          'aria-label': `Изображение: ${node.attrs['alt']}`,
        },
        '▧ ',
        node.attrs['alt'],
      ],
    },
  },
  marks: {
    strong: { parseDOM: [{ tag: 'strong' }], toDOM: () => ['strong', 0] },
    emphasis: { parseDOM: [{ tag: 'em' }], toDOM: () => ['em', 0] },
    strike: { parseDOM: [{ tag: 's' }], toDOM: () => ['s', 0] },
    code: { code: true, parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
    link: {
      attrs: { url: { default: '' } },
      parseDOM: [{ tag: 'a' }],
      toDOM: (mark) => ['a', { href: '#', title: mark.attrs['url'] }, 0],
    },
  },
});

export interface Span {
  readonly from: number;
  readonly to: number;
  readonly pmFrom: number;
  readonly pmTo: number;
  readonly map: TextMap | null;
  readonly context: 'text' | 'code' | 'inlineCode';
  readonly editable: boolean;
}
export interface Projection {
  readonly parsed: ParsedMarkdown;
  readonly doc: PMNode;
  readonly spans: readonly Span[];
}

export function visualProjection(text: string, revision = 0, cached?: ParsedMarkdown): Projection {
  const parsed =
      cached?.sourceRevision === revision && cached.text === text
        ? cached
        : parseMarkdown(text, revision),
    spans: Span[] = [];
  const definitions = new Map(
    descendants(parsed.tree)
      .filter((node) => node.type === 'definition')
      .map((node) => [node.identifier.toLowerCase(), node.url]),
  );
  const make = (
    name: string,
    attrs: Record<string, unknown> | null = null,
    children: PMNode[] = [],
  ) => visualSchema.nodes[name]!.create(attrs, children);
  function opaque(node: Nodes, at: number, inline = false): PMNode {
    const range = sourceRange(node);
    spans.push({ ...range, pmFrom: at, pmTo: at + 1, map: null, context: 'text', editable: false });
    return make(inline ? 'opaque_inline' : 'opaque', {
      ...range,
      raw: text.slice(range.from, range.to),
    });
  }
  function literal(
    raw: string,
    value: string,
    from: number,
    at: number,
    marks: Mark[],
    context: Span['context'],
  ): PMNode[] | null {
    const map = mapText(raw, context === 'text');
    if (map.text !== value) return null;
    spans.push({
      from,
      to: from + raw.length,
      pmFrom: at,
      pmTo: at + value.length,
      map,
      context,
      editable: true,
    });
    return value ? [visualSchema.text(value, marks)] : [];
  }
  function inline(nodes: readonly Nodes[], at: number, marks: Mark[] = []): PMNode[] {
    const result: PMNode[] = [];
    let position = at;
    for (const node of nodes) {
      const range = sourceRange(node);
      let created: PMNode[];
      if (node.type === 'text')
        created = literal(
          text.slice(range.from, range.to),
          node.value,
          range.from,
          position,
          marks,
          'text',
        ) ?? [opaque(node, position, true)];
      else if (node.type === 'inlineCode') {
        const raw = text.slice(range.from, range.to),
          marker = /^`+/.exec(raw)?.[0].length ?? 0;
        let body = raw.slice(marker, raw.length - marker),
          start = range.from + marker;
        if (body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) {
          body = body.slice(1, -1);
          start++;
        }
        created = literal(
          body,
          node.value,
          start,
          position,
          [...marks, visualSchema.marks['code']!.create()],
          'inlineCode',
        ) ?? [opaque(node, position, true)];
      } else if (node.type === 'image') {
        const alt = imageAltRange(text, node) ?? range;
        spans.push({
          ...range,
          pmFrom: position,
          pmTo: position + 1,
          map: null,
          context: 'text',
          editable: false,
        });
        created = [
          make('image', { alt: node.alt ?? '', ...range, altFrom: alt.from, altTo: alt.to }),
        ];
      } else if (node.type === 'break') {
        spans.push({
          ...range,
          pmFrom: position,
          pmTo: position + 1,
          map: null,
          context: 'text',
          editable: false,
        });
        created = [make('hard_break')];
      } else if (
        node.type === 'strong' ||
        node.type === 'emphasis' ||
        node.type === 'delete' ||
        node.type === 'link' ||
        node.type === 'linkReference'
      ) {
        const mark =
          node.type === 'delete' ? 'strike' : node.type.startsWith('link') ? 'link' : node.type;
        const url =
          node.type === 'link'
            ? node.url
            : node.type === 'linkReference'
              ? (definitions.get(node.identifier.toLowerCase()) ?? '')
              : '';
        created = inline(node.children, position, [
          ...marks,
          visualSchema.marks[mark]!.create(mark === 'link' ? { url } : null),
        ]);
      } else created = [opaque(node, position, true)];
      result.push(...created);
      position += created.reduce((size, child) => size + child.nodeSize, 0);
    }
    return result;
  }
  function blocks(nodes: readonly Nodes[], at: number, tableHeader = false): PMNode[] {
    const result: PMNode[] = [];
    let position = at;
    for (const node of nodes) {
      const range = sourceRange(node);
      let created: PMNode;
      if (
        (node.type === 'paragraph' || node.type === 'heading') &&
        (/^:::[\w-]+/.test(text.slice(range.from, range.to)) ||
          descendants(node).some((child) => child.type === 'html'))
      )
        created = opaque(node, position);
      else if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell')
        created = make(
          node.type === 'tableCell' ? 'table_cell' : node.type,
          node.type === 'heading'
            ? { level: node.depth }
            : node.type === 'tableCell'
              ? { header: tableHeader }
              : null,
          inline(node.children, position + 1),
        );
      else if (
        node.type === 'blockquote' ||
        node.type === 'list' ||
        node.type === 'listItem' ||
        node.type === 'table' ||
        node.type === 'tableRow'
      ) {
        const name =
          node.type === 'list'
            ? node.ordered
              ? 'ordered_list'
              : 'bullet_list'
            : {
                blockquote: 'blockquote',
                listItem: 'list_item',
                table: 'table',
                tableRow: 'table_row',
              }[node.type];
        const attrs =
          node.type === 'list'
            ? { start: node.start ?? 1 }
            : node.type === 'listItem'
              ? { checked: node.checked ?? null, from: range.from }
              : null;
        let children: PMNode[];
        if (node.type === 'table') {
          let offset = position + 1;
          children = node.children.flatMap((child, index) => {
            const row = blocks([child], offset, index === 0);
            offset += row[0]!.nodeSize;
            return row;
          });
        } else children = blocks(node.children, position + 1, tableHeader);
        created = make(name, attrs, children);
      } else if (node.type === 'code') {
        const raw = text.slice(range.from, range.to),
          fence = /^(?:`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n)/.exec(raw);
        const start = range.from + (fence?.[0].length ?? 0),
          normalized = mapText(text.slice(start, range.to));
        const end = normalized.boundaries[node.value.length];
        const content =
          fence && end != null
            ? literal(text.slice(start, start + end), node.value, start, position + 1, [], 'code')
            : null;
        created = content ? make('code_block', null, content) : opaque(node, position);
      } else if (node.type === 'thematicBreak') created = make('rule');
      else created = opaque(node, position);
      result.push(created);
      position += created.nodeSize;
    }
    return result;
  }
  const children = blocks(parsed.tree.children, 0);
  if (!children.length) {
    children.push(make('paragraph'));
    spans.push({
      from: 0,
      to: 0,
      pmFrom: 1,
      pmTo: 1,
      map: { text: '', boundaries: [0] },
      context: 'text',
      editable: true,
    });
  }
  return { parsed, doc: visualSchema.nodes['doc']!.create(null, children), spans };
}

export function toSource(projection: Projection, position: number, bias = 1): number {
  const candidates = projection.spans.filter(
    (span) => span.pmFrom <= position && span.pmTo >= position,
  );
  const span = bias > 0 ? candidates.at(-1) : candidates[0];
  if (span) {
    if (!span.map) return position <= span.pmFrom ? span.from : span.to;
    let at = position - span.pmFrom;
    while (span.map.boundaries[at] == null && at >= 0 && at < span.map.boundaries.length)
      at += bias < 0 ? -1 : 1;
    return span.from + (span.map.boundaries[at] ?? 0);
  }
  let nearest = 0,
    distance = Infinity;
  for (const item of projection.spans)
    for (const [pm, source] of [
      [item.pmFrom, item.from],
      [item.pmTo, item.to],
    ])
      if (Math.abs(pm! - position) < distance) {
        distance = Math.abs(pm! - position);
        nearest = source!;
      }
  return nearest;
}
export function toVisual(projection: Projection, position: number): number {
  const span = projection.spans.find((item) => item.from <= position && item.to >= position);
  if (span)
    return span.map ? span.pmFrom + sourceToText(span.map, position - span.from) : span.pmFrom;
  let nearest = 1,
    distance = Infinity;
  for (const item of projection.spans)
    for (const [source, pm] of [
      [item.from, item.pmFrom],
      [item.to, item.pmTo],
    ])
      if (Math.abs(source! - position) < distance) {
        nearest = pm!;
        distance = Math.abs(source! - position);
      }
  return nearest;
}
