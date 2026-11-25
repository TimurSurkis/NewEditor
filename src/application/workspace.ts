import type { DocumentFormat, Result, StorageRef } from '../core';
import type { PortError } from '../ports';
import type { DocumentApplication, SessionView } from './contracts';

export interface OpenDialogResult {
  readonly documents: readonly { readonly ref: StorageRef; readonly displayName: string }[];
  readonly errors: readonly { readonly displayName: string; readonly error: PortError }[];
}
export interface WorkspaceTab {
  readonly id: string;
  readonly name: string;
  readonly view: SessionView;
  readonly closing: boolean;
}
export interface WorkspaceSnapshot {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeId: string | null;
  readonly opening: boolean;
  readonly errors: readonly string[];
}
export interface WorkspaceApplication {
  getSnapshot(): WorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  create(format: DocumentFormat): void;
  select(id: string): void;
  open(): Promise<void>;
  close(id: string): Promise<void>;
  clearErrors(): void;
  dispose(): void;
}

export function createWorkspaceApplication(
  documents: DocumentApplication,
  pickOpen: () => Promise<Result<OpenDialogResult | null, PortError>>,
): WorkspaceApplication {
  let snapshot: WorkspaceSnapshot = Object.freeze({
    tabs: Object.freeze([]),
    activeId: null,
    opening: false,
    errors: Object.freeze([]),
  });
  const listeners = new Set<() => void>(),
    stops = new Map<string, () => void>();
  let serial = 0,
    live = true,
    opening: Promise<void> | null = null;
  const publish = (changes: Partial<WorkspaceSnapshot>) => {
    if (!live) return;
    snapshot = Object.freeze({ ...snapshot, ...changes });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* Изоляция подписчиков UI. */
      }
    }
  };
  const issue = (message: string) =>
    publish({ errors: Object.freeze([...snapshot.errors, message]) });
  const add = (id: string, name: string) => {
    if (!live) return;
    const existing = snapshot.tabs.find((tab) => tab.id === id);
    if (existing) {
      if (!existing.closing) publish({ activeId: id });
      return;
    }
    const view = documents.getSnapshot(id);
    if (!view) return;
    stops.set(
      id,
      documents.subscribe(id, () => {
        const next = documents.getSnapshot(id);
        if (next)
          publish({
            tabs: Object.freeze(
              snapshot.tabs.map((tab) =>
                tab.id === id ? Object.freeze({ ...tab, view: next }) : tab,
              ),
            ),
          });
      }),
    );
    publish({
      tabs: Object.freeze([...snapshot.tabs, Object.freeze({ id, name, view, closing: false })]),
      activeId: id,
    });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (live) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    create(format) {
      if (live)
        add(documents.create(format), `Без имени ${++serial}.${format === 'txt' ? 'txt' : 'md'}`);
    },
    select(id) {
      if (
        live &&
        snapshot.activeId !== id &&
        snapshot.tabs.some((tab) => tab.id === id && !tab.closing)
      )
        publish({ activeId: id });
    },
    open() {
      if (!live) return Promise.resolve();
      if (opening) return opening;
      opening = Promise.resolve().then(async () => {
        try {
          if (!live) return;
          const picked = await pickOpen();
          if (!live) return;
          if (!picked.ok) {
            issue(picked.error.message);
            return;
          }
          if (picked.value === null) return;
          for (const error of picked.value.errors)
            issue(`${error.displayName}: ${error.error.message}`);
          for (const choice of picked.value.documents) {
            if (!live) return;
            const loaded = await documents.open(choice.ref);
            if (!live) return;
            if (loaded.ok) add(loaded.value, choice.displayName);
            else issue(`${choice.displayName}: ${loaded.error.message}`);
          }
        } catch {
          issue('Не удалось открыть документы');
        } finally {
          opening = null;
          publish({ opening: false });
        }
      });
      publish({ opening: true, errors: Object.freeze([]) });
      return opening;
    },
    async close(id) {
      const tab = snapshot.tabs.find((tab) => tab.id === id);
      if (!live || !tab || tab.closing) return;
      if (tab.view.isDirty) {
        issue(
          'Есть несохранённые изменения. Закрытие с выбором сохранения появится на этапе P5.3.',
        );
        return;
      }
      publish({
        tabs: Object.freeze(
          snapshot.tabs.map((tab) =>
            tab.id === id ? Object.freeze({ ...tab, closing: true }) : tab,
          ),
        ),
      });
      try {
        if (documents.getSnapshot(id)?.isDirty) {
          issue('Появились несохранённые изменения; вкладка оставлена открытой.');
          return;
        }
        const closed = await documents.close(id, 'discard');
        if (!live) return;
        if (!closed.ok) {
          issue(closed.error.message);
          return;
        }
        if (!closed.value.closed) return;
        stops.get(id)?.();
        stops.delete(id);
        const index = snapshot.tabs.findIndex((tab) => tab.id === id),
          tabs = snapshot.tabs.filter((tab) => tab.id !== id);
        publish({
          tabs: Object.freeze(tabs),
          activeId:
            snapshot.activeId === id
              ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
              : snapshot.activeId,
        });
      } catch {
        issue('Не удалось закрыть документ');
      } finally {
        if (live && snapshot.tabs.some((tab) => tab.id === id))
          publish({
            tabs: Object.freeze(
              snapshot.tabs.map((tab) =>
                tab.id === id ? Object.freeze({ ...tab, closing: false }) : tab,
              ),
            ),
          });
      }
    },
    clearErrors() {
      if (snapshot.errors.length) publish({ errors: Object.freeze([]) });
    },
    dispose() {
      live = false;
      for (const stop of stops.values()) stop();
      stops.clear();
      listeners.clear();
    },
  };
}
