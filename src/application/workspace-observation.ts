import type { StorageRef, Result } from '../core';
import type { ResourceEvents } from '../ports';
import type { CommandError, DocumentApplication, SessionView } from './contracts';

interface ObservedTab {
  readonly id: string;
  readonly view: SessionView;
  readonly saving: boolean;
  readonly closing: boolean;
}
interface Entry {
  readonly id: string;
  readonly ref: StorageRef;
  stop: () => void;
  pending: boolean;
  running: Promise<void> | null;
  paused: boolean;
}
const sameRef = (a: StorageRef | null, b: StorageRef) =>
  a?.storageId === b.storageId && a.resourceId === b.resourceId;

export function createWorkspaceObservation(
  documents: DocumentApplication,
  events: ResourceEvents,
  flush: ((id: string) => Promise<Result<void, CommandError>>) | undefined,
  report: (id: string, error: string | null) => void,
) {
  const entries = new Map<string, Entry>();
  let tabs: readonly ObservedTab[] = [];
  let live = true;
  const current = (entry: Entry) =>
    live &&
    entries.get(entry.id) === entry &&
    sameRef(documents.getSnapshot(entry.id)?.edit.document.location ?? null, entry.ref);
  const blocked = (entry: Entry) => {
    const tab = tabs.find((tab) => tab.id === entry.id);
    return (
      !tab ||
      tab.saving ||
      tab.closing ||
      entry.paused ||
      ['saving', 'unknown', 'history-pending'].includes(tab.view.save.kind)
    );
  };
  function pump(entry: Entry): Promise<void> {
    if (entry.running) return entry.running;
    if (!current(entry) || !entry.pending || blocked(entry)) return Promise.resolve();
    entry.running = Promise.resolve().then(async () => {
      try {
        while (current(entry) && entry.pending && !blocked(entry)) {
          entry.pending = false;
          const flushed = await flush?.(entry.id);
          if (!current(entry)) return;
          if (flushed && !flushed.ok) {
            report(entry.id, flushed.error.message);
            return;
          }
          if (blocked(entry)) {
            entry.pending = true;
            return;
          }
          const revision = documents.getSnapshot(entry.id)!.edit.stateRevision;
          const result = await documents.reload(entry.id, 'if-clean');
          if (!current(entry)) return;
          if (!result.ok && result.error.code === 'busy') {
            entry.pending = true;
            if (revision === documents.getSnapshot(entry.id)!.edit.stateRevision) return;
          } else
            report(
              entry.id,
              result.ok || result.error.code === 'not-found' ? null : result.error.message,
            );
        }
      } catch {
        if (current(entry)) report(entry.id, 'Не удалось проверить внешние изменения');
      } finally {
        entry.running = null;
      }
    });
    return entry.running;
  }
  return {
    synchronize(next: readonly ObservedTab[]) {
      tabs = next;
      for (const [id, entry] of entries) {
        const tab = tabs.find((tab) => tab.id === id);
        if (!tab || !sameRef(tab.view.edit.document.location, entry.ref)) {
          entries.delete(id);
          entry.stop();
        }
      }
      for (const tab of tabs) {
        const ref = tab.view.edit.document.location;
        if (!ref) continue;
        let entry = entries.get(tab.id);
        if (!entry) {
          entry = { id: tab.id, ref, stop: () => {}, pending: true, running: null, paused: false };
          entries.set(tab.id, entry);
          const observed = entry;
          entry.stop = events.watch(
            ref,
            (event) => {
              if (!current(observed) || !sameRef(event.ref, observed.ref)) return;
              observed.pending = true;
              void pump(observed);
            },
            (error) => {
              if (current(observed)) report(tab.id, error.message);
            },
          );
          if (!current(entry)) entry.stop();
        }
        void pump(entry);
      }
    },
    async refresh() {
      await Promise.all(
        [...entries.values()].map((entry) => {
          entry.pending = true;
          return pump(entry);
        }),
      );
    },
    async accept(
      id: string,
      expected: { readonly stateRevision: number; readonly storageRevision: string },
    ) {
      const guard = { ...expected };
      const entry = entries.get(id);
      if (!entry || blocked(entry)) return;
      entry.paused = true;
      try {
        await entry.running;
        const flushed = await flush?.(id);
        if (!current(entry)) return;
        if (flushed && !flushed.ok) {
          report(id, flushed.error.message);
          return;
        }
        const result = await documents.reload(id, 'discard-local', guard);
        if (!current(entry)) return;
        if (!result.ok) {
          report(
            id,
            result.error.code === 'busy'
              ? 'Сравнение устарело: рабочая копия или файл изменились. Проверьте изменения и повторите решение.'
              : result.error.message,
          );
          entry.pending = true;
        } else report(id, null);
      } catch {
        if (current(entry))
          report(id, 'Не удалось загрузить внешний файл; рабочая копия сохранена');
      } finally {
        entry.paused = false;
        void pump(entry);
      }
    },
    dispose() {
      live = false;
      for (const entry of entries.values()) entry.stop();
      entries.clear();
    },
  };
}
