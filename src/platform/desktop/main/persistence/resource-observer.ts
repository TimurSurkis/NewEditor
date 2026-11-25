import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Result } from '../../../../core';
import type { PortError, ResourceEvent } from '../../../../ports';
import { fileFailure, localFailure } from './errors';

export interface FileObservation {
  readonly revision: string | null;
  readonly contentHash: string | null;
}
export interface WatchSignals {
  watch(path: string, signal: () => void, error: (error: PortError) => void): () => void;
  later(milliseconds: number, callback: () => void): () => void;
  every(milliseconds: number, callback: () => void): () => void;
}

export function createWatchSignals(): WatchSignals {
  return {
    watch(path, signal, error) {
      const watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
        if (filename === null || filename.toString() === basename(path)) signal();
      });
      watcher.on('error', (cause) => error(fileFailure(cause).error));
      return () => watcher.close();
    },
    later(milliseconds, callback) {
      const timer = setTimeout(callback, milliseconds);
      timer.unref();
      return () => clearTimeout(timer);
    },
    every(milliseconds, callback) {
      const timer = setInterval(callback, milliseconds);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

export interface ObserverDependencies {
  readonly signals: WatchSignals;
  readonly run: (id: string, action: () => Promise<void>) => Promise<void>;
  readonly probe: (id: string) => Promise<Result<FileObservation, PortError>>;
  readonly deliver: (
    id: string,
    owner: object,
    previous: string | null | undefined,
    observed: FileObservation,
  ) => boolean;
}

interface Subscription {
  readonly owner: object;
  readonly listener: (event: ResourceEvent) => void;
  readonly onError: (error: PortError) => void;
  active: boolean;
  revision: string | null | undefined;
  lastError: string | null;
}
interface Entry {
  readonly id: string;
  readonly path: string;
  readonly subscribers: Set<Subscription>;
  active: boolean;
  dirty: boolean;
  running: Promise<void> | null;
  stopWatcher: (() => void) | null;
  stopPoll: (() => void) | null;
  stopLater: (() => void) | null;
  watchError: string | null;
}

export function createResourceObserver(deps: ObserverDependencies) {
  const entries = new Map<string, Entry>();
  let closed = false;
  const sendError = (sub: Subscription, error: PortError) => {
    if (!sub.active) return;
    try {
      sub.onError(error);
    } catch {
      /* Ошибка получателя не ломает остальных подписчиков. */
    }
  };
  function watcherError(entry: Entry, error: PortError) {
    if (!entry.active) return;
    entry.stopWatcher?.();
    entry.stopWatcher = null;
    const key = JSON.stringify(error);
    if (entry.watchError !== key) {
      entry.watchError = key;
      for (const sub of entry.subscribers) sendError(sub, error);
    }
  }
  function startWatcher(entry: Entry) {
    if (!entry.active || entry.stopWatcher) return;
    try {
      let failed = false;
      const stop = deps.signals.watch(
        entry.path,
        () => schedule(entry),
        (error) => {
          failed = true;
          watcherError(entry, error);
        },
      );
      // onError может синхронно закрыть клиента/весь сервис до возврата watch.
      if (!entry.active || failed) {
        stop();
        return;
      }
      entry.stopWatcher = stop;
      entry.watchError = null;
    } catch (cause) {
      watcherError(entry, fileFailure(cause).error);
    }
  }
  function schedule(entry: Entry) {
    if (!entry.active || entry.stopLater) return;
    entry.stopLater = deps.signals.later(100, () => {
      entry.stopLater = null;
      void check(entry);
    });
  }
  async function probe(entry: Entry) {
    if (!entry.active) return;
    startWatcher(entry);
    if (!entry.active) return;
    const observed = await deps.probe(entry.id);
    if (!entry.active) return;
    if (!observed.ok) {
      if (observed.error.code === 'busy') {
        schedule(entry);
        return;
      }
      const key = JSON.stringify(observed.error);
      for (const sub of entry.subscribers) {
        if (sub.lastError !== key) {
          sub.lastError = key;
          sendError(sub, observed.error);
        }
      }
      return;
    }
    for (const sub of [...entry.subscribers]) {
      if (!sub.active) continue;
      sub.lastError = null;
      if (!deps.deliver(entry.id, sub.owner, sub.revision, observed.value)) continue;
      const previous = sub.revision;
      sub.revision = observed.value.revision;
      if (previous === undefined || previous === sub.revision) continue;
      try {
        sub.listener({
          ref: { storageId: 'local', resourceId: entry.id },
          kind: sub.revision === null ? 'deleted' : 'changed',
        });
      } catch {
        sendError(sub, localFailure('io-error', 'Ошибка обработчика изменения ресурса').error);
      }
    }
  }
  function check(entry: Entry): Promise<void> {
    if (!entry.active) return Promise.resolve();
    entry.stopLater?.();
    entry.stopLater = null;
    entry.dirty = true;
    if (entry.running) return entry.running;
    entry.running = Promise.resolve().then(async () => {
      try {
        do {
          entry.dirty = false;
          try {
            await deps.run(entry.id, () => probe(entry));
          } catch (cause) {
            if (entry.active)
              for (const sub of entry.subscribers)
                sendError(
                  sub,
                  localFailure(
                    'io-error',
                    cause instanceof Error ? 'Не удалось проверить ресурс' : 'Ошибка наблюдения',
                  ).error,
                );
          }
        } while (entry.active && entry.dirty);
      } finally {
        // Без отдельного microtask Promise.finally: иначе refresh может попасть
        // между последней проверкой dirty и освобождением running и потеряться.
        entry.running = null;
      }
    });
    return entry.running;
  }
  function stopEntry(entry: Entry) {
    if (!entry.active) return;
    entry.active = false;
    entry.stopWatcher?.();
    entry.stopPoll?.();
    entry.stopLater?.();
    entry.stopWatcher = entry.stopPoll = entry.stopLater = null;
    for (const sub of entry.subscribers) sub.active = false;
    entry.subscribers.clear();
    entries.delete(entry.id);
  }
  return {
    watch(
      id: string,
      path: string,
      owner: object,
      initial: string | null | undefined,
      listener: Subscription['listener'],
      onError: Subscription['onError'],
    ): () => void {
      if (closed) return () => {};
      let entry = entries.get(id);
      if (!entry) {
        entry = {
          id,
          path,
          subscribers: new Set(),
          active: true,
          dirty: false,
          running: null,
          stopWatcher: null,
          stopPoll: null,
          stopLater: null,
          watchError: null,
        };
        entries.set(id, entry);
      }
      const sub: Subscription = {
        owner,
        listener,
        onError,
        active: true,
        revision: initial,
        lastError: null,
      };
      entry.subscribers.add(sub);
      if (!entry.stopPoll)
        entry.stopPoll = deps.signals.every(2000, () => {
          void check(entry);
        });
      void check(entry);
      return () => {
        if (!sub.active) return;
        sub.active = false;
        entry.subscribers.delete(sub);
        if (entry.subscribers.size === 0) stopEntry(entry);
      };
    },
    acknowledge(owner: object, id: string, revision: string) {
      const entry = entries.get(id);
      if (entry)
        for (const sub of entry.subscribers)
          if (sub.owner === owner && sub.active) sub.revision = revision;
    },
    async refresh(owner: object): Promise<void> {
      await Promise.all(
        [...entries.values()]
          .filter((entry) => [...entry.subscribers].some((sub) => sub.owner === owner))
          .map(check),
      );
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of [...entries.values()]) stopEntry(entry);
    },
  };
}
