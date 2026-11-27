import { findTextMatches, replacementChanges } from '../../application';
import type { CommandError, DocumentApplication, TextMatch } from '../../application';
import type { FileMetadata, Result, SourceSelection } from '../../core';
import {
  markdownStyleState,
  markdownVisibleSelection,
  parseMarkdown,
  planBasicMarkdown,
} from '../../formats';
import type { BasicMarkdownAction, InlineStyle, ParsedMarkdown } from '../../formats';
import type {
  EditorFactory,
  EditorFrame,
  EditorHost,
  EditorInstance,
  EditorMode,
} from './contracts';
import { sourceEditor } from './source-editor';
import { visualEditor } from './visual-editor';
import { boundedSelection, edit } from './transaction';

export interface SourceView {
  readonly markdown: boolean;
  readonly mode: EditorMode;
  readonly inline: Readonly<Record<InlineStyle, boolean | 'mixed' | undefined>>;
  readonly editable: boolean;
  readonly selection: SourceSelection;
  readonly composing: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly pending: string | null;
  readonly searchOpen: boolean;
  readonly query: string;
  readonly replacement: string;
  readonly matchCase: boolean;
  readonly matches: number;
  readonly current: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}
const empty: SourceView = Object.freeze({
  markdown: false,
  mode: 'source',
  inline: Object.freeze({
    strong: undefined,
    emphasis: undefined,
    strike: undefined,
    code: undefined,
  }),
  editable: true,
  selection: { anchor: 0, head: 0 },
  composing: false,
  busy: false,
  error: null,
  pending: null,
  searchOpen: false,
  query: '',
  replacement: '',
  matchCase: false,
  matches: 0,
  current: 0,
  canUndo: false,
  canRedo: false,
});
const cancelled = (): Result<void, CommandError> => ({
  ok: false,
  error: { code: 'cancelled', message: 'Команда отменена: сессия изменилась', retryable: false },
});
interface Entry {
  readonly id: string;
  readonly listeners: Set<() => void>;
  stop: () => void;
  instance: EditorInstance | null;
  element: HTMLElement | null;
  dispatching: boolean;
  view: SourceView;
  cached: string | null;
  matches: readonly TextMatch[];
  parsed: ParsedMarkdown | null;
}

export class WorkspaceEditor {
  private readonly entries = new Map<string, Entry>();
  private active: string | null = null;
  private generation = 0;
  private locked = new Set<string>();
  constructor(
    private readonly app: DocumentApplication,
    private readonly factory: EditorFactory = sourceEditor,
    private readonly visualFactory: EditorFactory = visualEditor,
  ) {}
  private entry(id: string): Entry | undefined {
    let entry = this.entries.get(id);
    if (!entry && this.app.getSnapshot(id)) {
      entry = {
        id,
        listeners: new Set(),
        stop: () => {},
        instance: null,
        element: null,
        dispatching: false,
        view: empty,
        cached: null,
        matches: [],
        parsed: null,
      };
      this.entries.set(id, entry);
      const current = entry;
      entry.stop = this.app.subscribe(id, () => this.refresh(current));
      this.refresh(entry, false);
    }
    return entry;
  }
  getSnapshot = (id: string): SourceView => this.entry(id)?.view ?? empty;
  subscribe = (id: string, listener: () => void): (() => void) => {
    const entry = this.entry(id);
    entry?.listeners.add(listener);
    return () => {
      entry?.listeners.delete(listener);
    };
  };
  synchronize(ids: readonly string[], active: string | null, locked: readonly string[] = []): void {
    if (this.active !== active) this.generation++;
    this.active = active;
    const previous = this.locked;
    this.locked = new Set(locked);
    for (const [id, entry] of this.entries)
      if (!ids.includes(id)) {
        entry.stop();
        entry.instance?.destroy();
        entry.listeners.clear();
        this.entries.delete(id);
      }
    for (const entry of this.entries.values())
      if (previous.has(entry.id) !== this.locked.has(entry.id)) this.refresh(entry);
  }
  private frame(entry: Entry): EditorFrame {
    const view = this.app.getSnapshot(entry.id)!;
    return {
      sessionId: entry.id,
      state: view.edit,
      selection: boundedSelection(view.edit.document.text, entry.view.selection),
      editable: !this.locked.has(entry.id),
      canUndo: view.canUndo,
      canRedo: view.canRedo,
      ...(entry.view.mode === 'visual' ? { markdown: this.parse(entry) } : {}),
    };
  }
  private parse(entry: Entry): ParsedMarkdown {
    const document = this.app.getSnapshot(entry.id)!.edit.document;
    if (
      entry.parsed?.sourceRevision !== document.sourceRevision ||
      entry.parsed.text !== document.text
    )
      entry.parsed = parseMarkdown(document.text, document.sourceRevision);
    return entry.parsed;
  }
  private refresh(entry: Entry, render = true): void {
    const session = this.app.getSnapshot(entry.id);
    if (!session || this.entries.get(entry.id) !== entry) return;
    if (entry.view.mode === 'visual') this.parse(entry);
    const cache = JSON.stringify([
      session.edit.document.sourceRevision,
      entry.view.query,
      entry.view.matchCase,
    ]);
    if (cache !== entry.cached) {
      entry.cached = cache;
      entry.matches = findTextMatches(
        session.edit.document.text,
        entry.view.query,
        entry.view.matchCase,
      );
    }
    const selection = boundedSelection(session.edit.document.text, entry.view.selection),
      from = Math.min(selection.anchor, selection.head),
      to = Math.max(selection.anchor, selection.head);
    entry.view = Object.freeze({
      ...entry.view,
      markdown: session.edit.document.format === 'markdown',
      inline: Object.freeze(
        Object.fromEntries(
          (['strong', 'emphasis', 'strike', 'code'] as const).map((style) => [
            style,
            entry.parsed?.sourceRevision === session.edit.document.sourceRevision &&
            entry.parsed.text === session.edit.document.text
              ? markdownStyleState(entry.parsed, selection, style)
              : undefined,
          ]),
        ) as Record<InlineStyle, boolean | 'mixed' | undefined>,
      ),
      editable: !this.locked.has(entry.id),
      selection,
      canUndo: session.canUndo,
      canRedo: session.canRedo,
      matches: entry.matches.length,
      current: entry.matches.findIndex((match) => match.from === from && match.to === to) + 1,
    });
    if (render && !entry.dispatching) entry.instance?.render(this.frame(entry));
    for (const listener of [...entry.listeners]) {
      try {
        listener();
      } catch {
        /* Изоляция UI. */
      }
    }
  }
  private command(
    entry: Entry,
    action: () => ReturnType<DocumentApplication['apply']>,
  ): Result<EditorFrame, CommandError> {
    if (this.locked.has(entry.id))
      return {
        ok: false,
        error: { code: 'busy', message: 'Документ закрывается', retryable: false },
      };
    entry.dispatching = true;
    try {
      const result = action();
      if (!result.ok) return result;
      entry.view = { ...entry.view, selection: result.value.selection, error: null, pending: null };
      this.refresh(entry, false);
      return { ok: true, value: this.frame(entry) };
    } finally {
      entry.dispatching = false;
    }
  }
  private host(entry: Entry): EditorHost {
    return {
      dispatch: (tx) => this.command(entry, () => this.app.apply(entry.id, tx)),
      undo: () => this.command(entry, () => this.app.undo(entry.id)),
      redo: () => this.command(entry, () => this.app.redo(entry.id)),
      selectionChanged: (selection) => {
        entry.view = { ...entry.view, selection };
        this.app.setSelection(entry.id, selection);
        this.refresh(entry, false);
      },
      compositionChanged: (composing) => {
        entry.view = { ...entry.view, composing };
        this.refresh(entry, false);
      },
      reportError: (error, pending) => {
        entry.view = { ...entry.view, error: error.message, pending };
        this.refresh(entry, false);
      },
      requestSource: (selection) => {
        this.app.setSelection(entry.id, selection);
        entry.view = { ...entry.view, selection };
        this.refresh(entry, false);
        void this.switchMode(entry.id, 'source');
      },
    };
  }
  mount(id: string, element: HTMLElement): void {
    const entry = this.entry(id);
    if (!entry) return;
    this.detach(id);
    entry.element = element;
    entry.instance = (entry.view.mode === 'visual' ? this.visualFactory : this.factory).mount(
      element,
      this.host(entry),
      this.frame(entry),
    );
  }
  private setMode(entry: Entry, mode: EditorMode): void {
    if (entry.view.mode === mode || !entry.view.markdown) return;
    if (mode === 'visual') this.parse(entry); // Подготовка до уничтожения старого движка.
    const element = entry.element;
    entry.instance?.destroy();
    entry.instance = null;
    entry.view = { ...entry.view, mode };
    try {
      if (element)
        entry.instance = (mode === 'visual' ? this.visualFactory : this.factory).mount(
          element,
          this.host(entry),
          this.frame(entry),
        );
    } catch {
      entry.view = {
        ...entry.view,
        mode: 'source',
        error: 'Не удалось подготовить визуальный режим; исходник сохранён',
      };
      if (element)
        entry.instance = this.factory.mount(element, this.host(entry), this.frame(entry));
    }
    this.refresh(entry, false);
  }
  switchMode(id: string, mode: EditorMode): Promise<void> {
    return this.run(id, (entry) => {
      this.setMode(entry, mode);
      entry.instance?.focus();
    });
  }
  format(
    id: string,
    action: BasicMarkdownAction | { readonly kind: 'toggle-inline'; readonly style: InlineStyle },
  ): Promise<void> {
    const requested = { ...action };
    return this.run(id, (entry) => {
      if (!entry.view.markdown) return;
      const parsed = this.parse(entry),
        frame = this.frame(entry);
      const chosen: BasicMarkdownAction =
        requested.kind === 'toggle-inline'
          ? {
              kind: 'inline',
              style: requested.style,
              enabled: markdownStyleState(parsed, frame.selection, requested.style) !== true,
            }
          : requested;
      const plan = planBasicMarkdown(parsed, frame.selection, chosen);
      if (!plan.ok) {
        this.report(id, plan.error.message);
        return;
      }
      const tx = edit(frame, plan.value.body.changes, plan.value.selection);
      const result = tx.ok ? this.command(entry, () => this.app.apply(id, tx.value)) : tx;
      if (result.ok) {
        entry.instance?.render(result.value);
        entry.instance?.focus();
      } else this.report(id, result.error.message);
    });
  }
  detach(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.instance?.destroy();
      entry.instance = null;
      entry.element = null;
    }
  }
  async flush(id: string): Promise<Result<void, CommandError>> {
    const entry = this.entry(id);
    if (!entry) return cancelled();
    const result = await entry.instance?.flush();
    if (this.entries.get(id) !== entry || !this.app.getSnapshot(id)) return cancelled();
    if (result && !result.ok) {
      entry.view = { ...entry.view, error: result.error.message };
      this.refresh(entry, false);
      return result;
    }
    if (entry.view.pending !== null)
      return {
        ok: false,
        error: {
          code: 'busy',
          message: 'Сначала разрешите неподтверждённый ввод',
          retryable: false,
        },
      };
    this.app.breakUndoGroup(id);
    return { ok: true, value: undefined };
  }
  hasPending(): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.view.composing || entry.view.pending !== null,
    );
  }
  report(id: string, message: string): void {
    const entry = this.entry(id);
    if (entry) {
      entry.view = { ...entry.view, error: message };
      this.refresh(entry, false);
    }
  }
  discardPending(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const element = entry.element;
    this.detach(id);
    entry.view = { ...entry.view, composing: false, error: null, pending: null };
    this.app.breakUndoGroup(id);
    this.refresh(entry, false);
    if (element) this.mount(id, element);
  }
  setSearch(
    id: string,
    changes: Partial<Pick<SourceView, 'searchOpen' | 'query' | 'replacement' | 'matchCase'>>,
  ): void {
    const entry = this.entry(id);
    if (!entry) return;
    entry.view = { ...entry.view, ...changes };
    this.app.breakUndoGroup(id);
    this.refresh(entry, false);
  }
  private async run(id: string, action: (entry: Entry) => void): Promise<void> {
    const entry = this.entry(id);
    if (!entry || entry.view.busy || this.locked.has(id)) return;
    const generation = this.generation;
    entry.view = { ...entry.view, busy: true };
    this.refresh(entry, false);
    try {
      const flushed = await this.flush(id);
      if (
        !flushed.ok ||
        this.active !== id ||
        this.generation !== generation ||
        this.locked.has(id)
      )
        return;
      action(entry);
    } catch {
      this.report(id, 'Не удалось выполнить команду редактора; исходный текст сохранён');
    } finally {
      if (this.entries.get(id) === entry) {
        entry.view = { ...entry.view, busy: false };
        this.refresh(entry, false);
      }
    }
  }
  history(id: string, redo = false): Promise<void> {
    return this.run(id, (entry) => {
      const result = this.command(entry, () => (redo ? this.app.redo(id) : this.app.undo(id)));
      if (result.ok) entry.instance?.render(result.value);
      else this.report(id, result.error.message);
    });
  }
  changeMetadata(id: string, metadata: FileMetadata): Promise<void> {
    const value = { encoding: metadata.encoding, bom: metadata.bom };
    return this.run(id, (entry) => {
      const frame = this.frame(entry);
      const result = this.command(entry, () =>
        this.app.apply(id, {
          documentId: frame.state.document.id,
          baseStateRevision: frame.state.stateRevision,
          body: { changes: [], fileMetadata: value },
          selectionBefore: frame.selection,
          selectionAfter: frame.selection,
          groupId: null,
        }),
      );
      if (result.ok) entry.instance?.render(result.value);
      else this.report(id, result.error.message);
    });
  }
  selectAll(id: string): Promise<void> {
    return this.run(id, (entry) =>
      this.select(entry, { anchor: 0, head: this.app.getSnapshot(id)!.edit.document.text.length }),
    );
  }
  private select(entry: Entry, selection: SourceSelection): void {
    if (entry.view.mode === 'visual' && !markdownVisibleSelection(this.parse(entry), selection))
      this.setMode(entry, 'source');
    this.app.setSelection(entry.id, selection);
    entry.view = { ...entry.view, selection };
    this.refresh(entry);
    entry.instance?.focus();
  }
  private next(entry: Entry, backwards: boolean): void {
    if (!entry.matches.length) return;
    const selected = entry.view.current - 1,
      selection = entry.view.selection;
    let index =
      selected >= 0
        ? (selected + (backwards ? -1 : 1) + entry.matches.length) % entry.matches.length
        : backwards
          ? entry.matches
              .map((match) => match.to <= Math.min(selection.anchor, selection.head))
              .lastIndexOf(true)
          : entry.matches.findIndex(
              (match) => match.from >= Math.max(selection.anchor, selection.head),
            );
    if (index < 0) index = backwards ? entry.matches.length - 1 : 0;
    const match = entry.matches[index]!;
    this.select(entry, { anchor: match.from, head: match.to });
  }
  find(id: string, backwards = false): Promise<void> {
    return this.run(id, (entry) => this.next(entry, backwards));
  }
  replace(id: string, all = false): Promise<void> {
    return this.run(id, (entry) => {
      this.setMode(entry, 'source');
      const selected = entry.view.current - 1;
      if (!all && selected < 0) {
        this.next(entry, false);
        return;
      }
      const matches = all ? entry.matches : entry.matches.slice(selected, selected + 1);
      if (!matches.length) return;
      const frame = this.frame(entry),
        changes = replacementChanges(frame.state.document.text, matches, entry.view.replacement);
      const last = changes[changes.length - 1]!,
        end =
          last.from +
          changes
            .slice(0, -1)
            .reduce(
              (delta, change) => delta + change.insert.length - (change.to - change.from),
              0,
            ) +
          last.insert.length;
      const tx = edit(frame, changes, { anchor: end, head: end });
      const result = tx.ok ? this.command(entry, () => this.app.apply(id, tx.value)) : tx;
      if (result.ok) {
        entry.instance?.render(result.value);
        entry.instance?.focus();
      } else this.report(id, result.error.message);
    });
  }
  destroy(): void {
    this.synchronize([], null);
  }
}
