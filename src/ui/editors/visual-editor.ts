import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { markdownAction, visualInsert } from '../../formats';
import type { CommandError } from '../../application';
import type { Result, TextChange } from '../../core';
import type { EditorFactory, EditorFrame, EditorHost, EditorInstance } from './contracts';
import { Composition } from './composition';
import { boundedSelection, edit } from './transaction';
import { toSource, toVisual, visualProjection } from './visual-projection';
import type { Projection } from './visual-projection';

class VisualEditor implements EditorInstance {
  private frame: EditorFrame;
  private projection: Projection;
  private readonly view: EditorView;
  private readonly composition: Composition;
  private compositionProjection: Projection | null = null;
  private ended = false;
  private animation = 0;
  private endPending = false;
  constructor(
    element: HTMLElement,
    private readonly host: EditorHost,
    initial: EditorFrame,
  ) {
    this.frame = initial;
    this.projection = visualProjection(
      initial.state.document.text,
      initial.state.document.sourceRevision,
      initial.markdown,
    );
    this.composition = new Composition(host);
    this.view = new EditorView(element, {
      state: EditorState.create({ doc: this.projection.doc }),
      attributes: {
        'aria-label': 'Визуальный редактор',
        role: 'textbox',
        'aria-multiline': 'true',
      },
      editable: () => this.frame.editable,
      handlePaste: (_view, event) => {
        this.transferText(event.clipboardData);
        return true;
      },
      handleDrop: (_view, event) => {
        this.transferText(event.dataTransfer);
        return true;
      },
      handleTextInput: (_view, from, to, text) => {
        if (this.composition.active || this.composition.error) return false;
        this.replace(from, to, text);
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (['z', 'y'].includes(event.key.toLowerCase()) || ['KeyZ', 'KeyY'].includes(event.code))
        ) {
          if (!this.composition.active && !this.composition.error) {
            const result =
              event.key.toLowerCase() === 'y' || event.code === 'KeyY' || event.shiftKey
                ? host.redo()
                : host.undo();
            if (result.ok) this.render(result.value);
            else host.reportError(result.error, null);
          }
          return true;
        }
        if (event.key === 'Enter' && !this.composition.active) {
          this.replace(this.view.state.selection.from, this.view.state.selection.to, '\n');
          return true;
        }
        return false;
      },
      handleDoubleClickOn: (_view, _position, node, _nodePosition, event) => {
        if (node.type.name === 'opaque' || node.type.name === 'opaque_inline') {
          event.preventDefault();
          const from = Number(node.attrs['from']);
          host.requestSource({ anchor: from, head: from });
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        mousedown: (_view, event) => {
          const target =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>('[data-opaque]')
              : null;
          if (!target) return false;
          event.preventDefault();
          if (this.composition.active || this.composition.error) return true;
          const span = this.projection.spans.find(
            (item) => !item.map && item.from === Number(target.dataset['sourceFrom']),
          );
          if (!span) return true;
          if (event.detail >= 2) this.host.requestSource({ anchor: span.from, head: span.from });
          else {
            this.view.dispatch(
              this.view.state.tr.setSelection(
                NodeSelection.create(this.projection.doc, span.pmFrom),
              ),
            );
            this.view.focus();
          }
          return true;
        },
        beforeinput: (_view, event) => {
          if (
            event instanceof InputEvent &&
            event.inputType === 'insertText' &&
            event.data !== null &&
            !event.isComposing &&
            !this.composition.active &&
            !this.composition.error
          ) {
            event.preventDefault();
            this.replace(this.view.state.selection.from, this.view.state.selection.to, event.data);
            return true;
          }
          return false;
        },
        compositionstart: () => {
          if (this.endPending) {
            cancelAnimationFrame(this.animation);
            this.commitComposition();
          }
          this.composition.begin(this.frame);
          this.compositionProjection ??= this.projection;
          return false;
        },
        compositionend: () => {
          this.endPending = true;
          this.animation = requestAnimationFrame(() => {
            this.animation = requestAnimationFrame(() => this.commitComposition());
          });
          return false;
        },
        click: (_view, event) => {
          const target = event.target;
          if (target instanceof HTMLInputElement && target.dataset['taskFrom']) {
            event.preventDefault();
            if (this.composition.active || this.composition.error) return true;
            const from = Number(target.dataset['taskFrom']);
            const body = markdownAction(
              this.projection.parsed,
              { anchor: from, head: from },
              { kind: 'set-task', checked: target.checked },
            );
            const tx = body.ok
              ? edit(this.frame, body.value.changes, { anchor: from, head: from })
              : body;
            const result = tx.ok ? this.host.dispatch(tx.value) : tx;
            if (result.ok) this.render(result.value);
            else host.reportError(result.error, null);
            return true;
          }
          if (target instanceof Element && target.closest('a')) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
      dispatchTransaction: (transaction) => {
        if (this.composition.active || this.composition.error) {
          this.view.updateState(this.view.state.apply(transaction));
          if (this.composition.error && transaction.docChanged)
            host.reportError(this.composition.error, transaction.doc.textContent);
          return;
        }
        if (transaction.docChanged) {
          const result = this.commitDocument(this.frame, this.projection, transaction.doc);
          this.view.updateState(this.view.state.apply(transaction));
          if (result.ok) this.render(result.value);
          else {
            this.composition.error = result.error;
            host.reportError(result.error, transaction.doc.textContent);
          }
        } else {
          this.view.updateState(this.view.state.apply(transaction));
          const selected = boundedSelection(this.frame.state.document.text, {
            anchor: toSource(
              this.projection,
              transaction.selection.anchor,
              transaction.selection.anchor <= transaction.selection.head ? 1 : -1,
            ),
            head: toSource(
              this.projection,
              transaction.selection.head,
              transaction.selection.empty
                ? 1
                : transaction.selection.anchor <= transaction.selection.head
                  ? -1
                  : 1,
            ),
          });
          this.frame = { ...this.frame, selection: selected };
          host.selectionChanged(selected);
        }
      },
    });
    this.render(initial);
  }
  private transferText(data: DataTransfer | null): void {
    if (!this.frame.editable || this.composition.active || this.composition.error) return;
    if (data?.files.length) {
      this.host.reportError(
        {
          code: 'unsupported',
          message: 'Вставка файлов/изображений подключается на этапе P6.3',
          retryable: false,
        },
        null,
      );
      return;
    }
    if (!data?.types.includes('text/plain')) {
      this.host.reportError(
        {
          code: 'unsupported',
          message: 'HTML не вставляется без безопасного текстового представления',
          retryable: false,
        },
        null,
      );
      return;
    }
    const text = data.getData('text/plain');
    if (!text) return;
    const selection = this.view.state.selection;
    const code = this.projection.spans.some(
      (span) =>
        span.context === 'code' && span.pmFrom <= selection.from && span.pmTo >= selection.to,
    );
    if (/[\r\n]/.test(text) && !code) {
      this.host.reportError(
        {
          code: 'unsupported',
          message: 'Многострочная visual-вставка пока требует исходный режим; текст сохранён ниже',
          retryable: false,
        },
        text,
      );
      return;
    }
    this.replace(selection.from, selection.to, text);
  }
  private change(
    projection: Projection,
    from: number,
    to: number,
    inserted: string,
  ): Result<TextChange, CommandError> {
    const span = projection.spans.find(
      (item) =>
        item.editable &&
        item.pmFrom <= from &&
        item.pmTo >= to &&
        item.map?.boundaries[from - item.pmFrom] != null &&
        item.map.boundaries[to - item.pmFrom] != null,
    );
    if (!span || !span.map || (span.context === 'inlineCode' && inserted.includes('`')))
      return {
        ok: false,
        error: {
          code: 'unsupported',
          message: 'Структурная правка доступна в исходном режиме',
          retryable: false,
        },
      };
    return {
      ok: true,
      value: {
        from: span.from + span.map.boundaries[from - span.pmFrom]!,
        to: span.from + span.map.boundaries[to - span.pmFrom]!,
        insert: visualInsert(projection.parsed.text, inserted, span.context),
      },
    };
  }
  private replace(from: number, to: number, inserted: string): void {
    if (this.composition.active || this.composition.error) return;
    const change = this.change(this.projection, from, to, inserted);
    const tx = change.ok
      ? edit(
          this.frame,
          [change.value],
          {
            anchor: change.value.from + change.value.insert.length,
            head: change.value.from + change.value.insert.length,
          },
          'visual-input',
        )
      : change;
    const result = tx.ok ? this.host.dispatch(tx.value) : tx;
    if (result.ok) this.render(result.value);
    else {
      this.composition.error = result.error;
      this.host.reportError(result.error, inserted);
    }
  }
  private commitDocument(
    frame: EditorFrame,
    projection: Projection,
    doc: PMNode,
  ): Result<EditorFrame, CommandError> {
    const start = projection.doc.content.findDiffStart(doc.content);
    const end = projection.doc.content.findDiffEnd(doc.content);
    if (start === null || end === null) return { ok: true, value: this.frame };
    const overlap = Math.max(0, start - Math.min(end.a, end.b));
    const change = this.change(
      projection,
      start,
      end.a + overlap,
      doc.textBetween(start, end.b + overlap, '\n', '\n'),
    );
    const tx = change.ok
      ? edit(
          frame,
          [change.value],
          {
            anchor: change.value.from + change.value.insert.length,
            head: change.value.from + change.value.insert.length,
          },
          null,
        )
      : change;
    return tx.ok ? this.host.dispatch(tx.value) : tx;
  }
  private commitComposition(): void {
    this.endPending = false;
    if (
      this.ended ||
      !this.composition.active ||
      !this.composition.base ||
      !this.compositionProjection
    )
      return;
    const result = this.commitDocument(
      this.composition.base,
      this.compositionProjection,
      this.view.state.doc,
    );
    this.composition.end(
      result.ok ? { ok: true, value: undefined } : result,
      this.view.state.doc.textContent,
    );
    this.compositionProjection = null;
    if (result.ok) this.render(result.value);
  }
  render(frame: EditorFrame): void {
    this.frame = frame;
    if (this.composition.active || this.composition.error) return;
    if (
      frame.state.document.sourceRevision !== this.projection.parsed.sourceRevision ||
      frame.state.document.text !== this.projection.parsed.text
    )
      this.projection = visualProjection(
        frame.state.document.text,
        frame.state.document.sourceRevision,
        frame.markdown,
      );
    const anchor = toVisual(this.projection, frame.selection.anchor),
      head = toVisual(this.projection, frame.selection.head);
    const atom = this.projection.spans.find(
      (span) =>
        !span.map &&
        span.from <= Math.min(frame.selection.anchor, frame.selection.head) &&
        span.to >= Math.max(frame.selection.anchor, frame.selection.head) &&
        NodeSelection.isSelectable(this.projection.doc.nodeAt(span.pmFrom)!),
    );
    const selection = atom
      ? NodeSelection.create(this.projection.doc, atom.pmFrom)
      : TextSelection.between(
          this.projection.doc.resolve(anchor),
          this.projection.doc.resolve(head),
        );
    this.view.updateState(EditorState.create({ doc: this.projection.doc, selection }));
  }
  flush() {
    return this.composition.flush();
  }
  focus(): void {
    this.view.focus();
  }
  destroy(): void {
    this.ended = true;
    cancelAnimationFrame(this.animation);
    this.composition.cancel();
    this.view.destroy();
  }
}
export const visualEditor: EditorFactory = {
  mode: 'visual',
  mount: (element, host, initial) => new VisualEditor(element, host, initial),
};
