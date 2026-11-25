import type { PortError } from '../../src/ports';
import type { WatchSignals } from '../../src/platform/desktop/main/persistence/resource-observer';

// Детерминированные сигналы: тест сам запускает debounce/poll без ожидания часов.
export class ManualSignals implements WatchSignals {
  readonly watchers = new Set<{ signal: () => void; error: (error: PortError) => void }>();
  readonly timers = new Map<() => void, number>();
  readonly polls = new Map<() => void, number>();
  starts = 0;
  stops = 0;
  unavailable = false;
  watch(_path: string, signal: () => void, error: (error: PortError) => void) {
    this.starts++;
    if (this.unavailable) throw Object.assign(new Error('watch unavailable'), { code: 'EACCES' });
    const watcher = { signal, error };
    this.watchers.add(watcher);
    return () => {
      if (this.watchers.delete(watcher)) this.stops++;
    };
  }
  later(milliseconds: number, callback: () => void) {
    this.timers.set(callback, milliseconds);
    return () => {
      this.timers.delete(callback);
    };
  }
  every(milliseconds: number, callback: () => void) {
    this.polls.set(callback, milliseconds);
    return () => {
      this.polls.delete(callback);
    };
  }
  signal() {
    for (const watcher of [...this.watchers]) watcher.signal();
  }
  debounce() {
    for (const callback of [...this.timers.keys()]) {
      this.timers.delete(callback);
      callback();
    }
  }
  poll() {
    for (const callback of [...this.polls.keys()]) callback();
  }
  fail(error: PortError) {
    for (const watcher of [...this.watchers]) watcher.error(error);
  }
}
