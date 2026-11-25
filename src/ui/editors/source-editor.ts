import { EditorState, EditorSelection, Compartment, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { preferredLineEnding } from '../../core';
import { mapText, sourceToText } from '../../formats';
import type { TextChange } from '../../core';
import type { EditorFactory, EditorFrame, EditorHost, EditorInstance } from './contracts';
import { edit, textDifference } from './transaction';
import { Composition } from './composition';

class SourceEditor implements EditorInstance {
  private frame: EditorFrame;
  private readonly view: EditorView;
  private readonly composition: Composition;
  private readonly readOnlyConfig = new Compartment();
  private ended = false;
  private animation = 0;
  private endPending = false;
  constructor(
    element: HTMLElement,
    private readonly host: EditorHost,
    initial: EditorFrame,
  ) {
    this.frame = initial;
    this.composition = new Composition(host);
    this.view = new EditorView({
      parent: element,
      state: EditorState.create({
        doc: mapText(initial.state.document.text).text,
        extensions: [
          markdown(),
          EditorView.lineWrapping,
          this.readOnlyConfig.of(EditorState.readOnly.of(!initial.editable)),
          EditorView.contentAttributes.of({ 'aria-label': 'Исходный редактор' }),
          keymap.of(defaultKeymap),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event) => {
                const key = event.key.toLowerCase();
                if (
                  (event.ctrlKey || event.metaKey) &&
                  !event.altKey &&
                  (['z', 'y'].includes(key) || ['KeyZ', 'KeyY'].includes(event.code))
                ) {
                  event.preventDefault();
                  return this.history(key === 'y' || event.code === 'KeyY' || event.shiftKey);
                }
                return false;
              },
              compositionstart: () => {
                if (this.endPending) {
                  cancelAnimationFrame(this.animation);
                  this.commitComposition();
                }
                this.composition.begin(this.frame);
                return false;
              },
              compositionend: () => {
                this.endPending = true;
                this.animation = requestAnimationFrame(() => {
                  this.animation = requestAnimationFrame(() => this.commitComposition());
                });
                return false;
              },
            }),
          ),
        ],
      }),
      dispatchTransactions: (transactions, view) => {
        for (const transaction of transactions) {
          if (this.composition.active || this.composition.error) {
            view.update([transaction]);
            if (this.composition.error && transaction.docChanged)
              host.reportError(this.composition.error, view.state.doc.toString());
            continue;
          }
          if (!transaction.docChanged) {
            view.update([transaction]);
            const map = mapText(this.frame.state.document.text),
              selected = transaction.state.selection.main;
            const anchor = map.boundaries[selected.anchor],
              head = map.boundaries[selected.head];
            if (anchor != null && head != null) {
              this.frame = { ...this.frame, selection: { anchor, head } };
              this.host.selectionChanged({ anchor, head });
            }
            continue;
          }
          const map = mapText(this.frame.state.document.text),
            changes: TextChange[] = [];
          let invalid = false;
          transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
            const start = map.boundaries[from],
              end = map.boundaries[to];
            if (start != null && end != null)
              changes.push({
                from: start,
                to: end,
                insert: inserted
                  .toString()
                  .replace(/\n/g, preferredLineEnding(this.frame.state.document.text)),
              });
            else invalid = true;
          });
          const tx = invalid
            ? {
                ok: false as const,
                error: {
                  code: 'invalid-range' as const,
                  message: 'Правка разрывает границу Unicode',
                },
              }
            : this.makeEdit(this.frame, changes, transaction.state.selection.main);
          const result = tx.ok ? host.dispatch(tx.value) : tx;
          view.update([transaction]);
          if (!result.ok) {
            this.composition.error = result.error;
            host.reportError(result.error, view.state.doc.toString());
          } else this.render(result.value);
        }
      },
    });
    this.render(initial);
  }
  private makeEdit(
    frame: EditorFrame,
    changes: readonly TextChange[],
    selection: { anchor: number; head: number },
  ) {
    let text = frame.state.document.text;
    for (const change of [...changes].reverse())
      text = text.slice(0, change.from) + change.insert + text.slice(change.to);
    const map = mapText(text);
    return edit(
      frame,
      changes,
      { anchor: map.boundaries[selection.anchor] ?? 0, head: map.boundaries[selection.head] ?? 0 },
      'source-input',
    );
  }
  private commitComposition(): void {
    this.endPending = false;
    if (this.ended || !this.composition.active || !this.composition.base) return;
    const base = this.composition.base,
      map = mapText(base.state.document.text);
    const difference = textDifference(map.text, this.view.state.doc.toString());
    if (!difference) {
      this.composition.end({ ok: true, value: undefined }, '');
      this.render(this.frame);
      return;
    }
    const changes: TextChange[] = difference
      ? [
          {
            from: map.boundaries[difference.from]!,
            to: map.boundaries[difference.to]!,
            insert: difference.insert.replace(/\n/g, preferredLineEnding(base.state.document.text)),
          },
        ]
      : [];
    const tx = this.makeEdit(base, changes, this.view.state.selection.main);
    const result = tx.ok ? this.host.dispatch({ ...tx.value, groupId: null }) : tx;
    this.composition.end(
      result.ok ? { ok: true, value: undefined } : result,
      this.view.state.doc.toString(),
    );
    if (result.ok) this.render(result.value);
  }
  private history(redo: boolean): boolean {
    if (this.composition.active || this.composition.error) return true;
    const result = redo ? this.host.redo() : this.host.undo();
    if (result.ok) this.render(result.value);
    else this.host.reportError(result.error, null);
    return true;
  }
  render(frame: EditorFrame): void {
    this.frame = frame;
    if (this.composition.active || this.composition.error) return;
    const map = mapText(frame.state.document.text);
    this.view.update([
      this.view.state.update({
        ...(this.view.state.doc.toString() !== map.text
          ? { changes: { from: 0, to: this.view.state.doc.length, insert: map.text } }
          : {}),
        selection: EditorSelection.single(
          sourceToText(map, frame.selection.anchor),
          sourceToText(map, frame.selection.head),
        ),
        effects: this.readOnlyConfig.reconfigure(EditorState.readOnly.of(!frame.editable)),
      }),
    ]);
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
export const sourceEditor: EditorFactory = {
  mode: 'source',
  mount: (element, host, initial) => new SourceEditor(element, host, initial),
};
