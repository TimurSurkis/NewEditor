import type { DocumentApplication, CommandError } from '../../application';
import type { Result, SourceSelection } from '../../core';
import { validateSnapshot } from '../../core';
import {
  descendants,
  imageAltRange,
  markdownAction,
  parseMarkdown,
  sourceRange,
} from '../../formats';
import type { MarkdownAction, ParsedMarkdown } from '../../formats';
import type { EditorFrame, EditorHost, EditorInstance, EditorMode } from './contracts';
import { sourceEditor } from './source-editor';
import { visualEditor } from './visual-editor';
import { boundedSelection, edit } from './transaction';

export interface PrototypeView {
  readonly source: string;
  readonly mode: EditorMode;
  readonly revision: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly composing: boolean;
  readonly error: string | null;
  readonly pending: string | null;
  readonly imageAlt: string | null;
  readonly captured: string | null;
  readonly parseMs: number;
  readonly editorMs: number;
  readonly selection: SourceSelection;
  readonly dispatches: number;
}
export class PrototypeController {
  private session: string;
  private selection: SourceSelection = { anchor: 0, head: 0 };
  private mode: EditorMode = 'source';
  private instance: EditorInstance | null = null;
  private element: HTMLElement | null = null;
  private stop: () => void;
  private dispatching = 0;
  private composing = false;
  private error: string | null = null;
  private pending: string | null = null;
  private captured: string | null = null;
  private readonly listeners = new Set<() => void>();
  private view!: PrototypeView;
  private parsed: ParsedMarkdown | null = null;
  private parseMs = 0;
  private editorMs = 0;
  private dispatches = 0;
  private destroyed = false;
  constructor(
    private readonly app: DocumentApplication,
    source: string,
  ) {
    this.session = app.create('markdown');
    this.seed(source);
    this.stop = app.subscribe(this.session, () => this.changed());
    this.changed();
  }
  readonly getSnapshot = (): PrototypeView => this.view;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private frame(): EditorFrame {
    const view = this.app.getSnapshot(this.session)!;
    if (
      this.parsed?.sourceRevision !== view.edit.document.sourceRevision ||
      this.parsed.text !== view.edit.document.text
    ) {
      const start = performance.now();
      this.parsed = parseMarkdown(view.edit.document.text, view.edit.document.sourceRevision);
      this.parseMs = performance.now() - start;
    }
    return {
      sessionId: this.session,
      state: view.edit,
      selection: boundedSelection(view.edit.document.text, this.selection),
      editable: true,
      canUndo: view.canUndo,
      canRedo: view.canRedo,
      markdown: this.parsed,
    };
  }
  private readonly host: EditorHost = {
    dispatch: (transaction) => {
      this.dispatches++;
      return this.command(() => this.app.apply(this.session, transaction));
    },
    undo: () => this.command(() => this.app.undo(this.session)),
    redo: () => this.command(() => this.app.redo(this.session)),
    selectionChanged: (selection) => {
      this.selection = selection;
      this.app.setSelection(this.session, selection);
      this.changed(false);
    },
    compositionChanged: (active) => {
      this.composing = active;
      this.changed(false);
    },
    reportError: (error, pending) => {
      this.error = error.message;
      this.pending = pending;
      this.changed(false);
    },
    requestSource: (selection) => {
      this.selection = selection;
      this.app.setSelection(this.session, selection);
      void this.switchMode('source');
    },
  };
  private command(
    action: () => ReturnType<DocumentApplication['apply']>,
  ): Result<EditorFrame, CommandError> {
    this.dispatching++;
    try {
      const result = action();
      if (!result.ok) return result;
      this.selection = result.value.selection;
      this.error = null;
      this.pending = null;
      this.changed(false);
      return { ok: true, value: this.frame() };
    } finally {
      this.dispatching--;
    }
  }
  private changed(render = true): void {
    if (this.destroyed) return;
    const frame = this.frame();
    if (render && !this.dispatching) this.instance?.render(frame);
    const image = descendants(frame.markdown!.tree).find((node) => {
      const range = sourceRange(node);
      return (
        node.type === 'image' &&
        range.from <= Math.min(this.selection.anchor, this.selection.head) &&
        range.to >= Math.max(this.selection.anchor, this.selection.head)
      );
    });
    this.view = {
      source: frame.state.document.text,
      mode: this.mode,
      revision: `${frame.state.document.sourceRevision}:${frame.state.stateRevision}`,
      canUndo: frame.canUndo,
      canRedo: frame.canRedo,
      composing: this.composing,
      error: this.error,
      pending: this.pending,
      captured: this.captured,
      parseMs: this.parseMs,
      editorMs: this.editorMs,
      selection: this.selection,
      dispatches: this.dispatches,
      imageAlt:
        image?.type === 'image' && imageAltRange(frame.state.document.text, image)
          ? (image.alt ?? '')
          : null,
    };
    for (const listener of this.listeners) listener();
  }
  private mountCurrent(): void {
    if (this.element) {
      const start = performance.now();
      this.instance = (this.mode === 'source' ? sourceEditor : visualEditor).mount(
        this.element,
        this.host,
        this.frame(),
      );
      this.editorMs = performance.now() - start;
    }
  }
  mount(element: HTMLElement): void {
    this.element = element;
    this.mountCurrent();
    this.changed(false);
  }
  detach(): void {
    this.instance?.destroy();
    this.instance = null;
    this.element = null;
  }
  private async flush(): Promise<boolean> {
    const result = await this.instance?.flush();
    if (this.destroyed) return false;
    if (result && !result.ok) {
      this.error = result.error.message;
      this.changed(false);
      return false;
    }
    return true;
  }
  async switchMode(mode: EditorMode): Promise<void> {
    if (!(await this.flush()) || mode === this.mode) return;
    this.app.breakUndoGroup(this.session);
    this.instance?.destroy();
    this.mode = mode;
    this.mountCurrent();
    this.changed(false);
    this.instance?.focus();
  }
  async format(action: MarkdownAction): Promise<void> {
    if (!(await this.flush())) return;
    const frame = this.frame(),
      parsed = frame.markdown!;
    const body = markdownAction(parsed, this.selection, action);
    const amount =
      action.kind === 'set-inline' && action.enabled && body.ok && body.value.changes.length
        ? action.mark === 'emphasis'
          ? 1
          : 2
        : 0;
    const tx = body.ok
      ? edit(frame, body.value.changes, {
          anchor: this.selection.anchor + amount,
          head: this.selection.head + amount,
        })
      : body;
    const result = tx.ok ? this.host.dispatch(tx.value) : tx;
    if (result.ok) this.instance?.render(result.value);
    else this.host.reportError(result.error, null);
  }
  async history(redo = false): Promise<void> {
    if (await this.flush()) {
      const result = redo ? this.host.redo() : this.host.undo();
      if (result.ok) this.instance?.render(result.value);
      else this.host.reportError(result.error, null);
    }
  }
  async capture(): Promise<void> {
    if (await this.flush()) {
      this.app.breakUndoGroup(this.session);
      this.captured = this.frame().state.document.text;
      this.changed(false);
    }
  }
  externalEdit(): void {
    const frame = this.frame(),
      end = frame.state.document.text.length;
    const tx = edit(frame, [{ from: end, to: end, insert: '\nВнешняя правка.' }]);
    if (tx.ok) this.app.apply(this.session, tx.value);
  }
  metadataEdit(): void {
    const frame = this.frame();
    this.app.apply(this.session, {
      documentId: frame.state.document.id,
      baseStateRevision: frame.state.stateRevision,
      body: {
        changes: [],
        fileMetadata: {
          ...frame.state.document.fileMetadata,
          bom: !frame.state.document.fileMetadata.bom,
        },
      },
      selectionBefore: this.selection,
      selectionAfter: this.selection,
      groupId: null,
    });
  }
  discardPending(): void {
    this.instance?.destroy();
    this.composing = false;
    this.error = null;
    this.pending = null;
    this.app.breakUndoGroup(this.session);
    this.mountCurrent();
    this.changed(false);
  }
  async load(source: string): Promise<void> {
    const invalid = validateSnapshot({
      text: source,
      fileMetadata: { encoding: 'utf-8', bom: false },
    });
    if (invalid) {
      this.host.reportError(invalid, source);
      return;
    }
    if (!(await this.flush())) return;
    this.stop();
    await this.app.close(this.session, 'discard');
    this.instance?.destroy();
    this.session = this.app.create('markdown');
    this.selection = { anchor: 0, head: 0 };
    this.error = null;
    this.pending = null;
    this.captured = null;
    this.seed(source);
    this.stop = this.app.subscribe(this.session, () => this.changed());
    this.mountCurrent();
    this.changed(false);
  }
  private seed(source: string): void {
    const frame = this.frame(),
      tx = edit(frame, [{ from: 0, to: 0, insert: source }], { anchor: 0, head: 0 });
    if (tx.ok) this.app.apply(this.session, tx.value);
    this.app.breakUndoGroup(this.session);
  }
  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.detach();
    this.listeners.clear();
    void this.app.close(this.session, 'discard');
  }
}
