import { expect, it } from 'vitest';
import type { Result } from '../../src/core';
import type { PortError, ResourceEvent } from '../../src/ports';
import { createResourceObserver } from '../../src/platform/desktop/main/persistence/resource-observer';
import type { FileObservation } from '../../src/platform/desktop/main/persistence/resource-observer';
import { ManualSignals } from '../helpers/watch-signals';

const error: PortError = { code: 'io-error', message: 'test', retryable: true };
function setup() {
  const signals = new ManualSignals(),
    owner = {},
    events: ResourceEvent[] = [],
    errors: PortError[] = [];
  let observed: Result<FileObservation, PortError> = {
      ok: true,
      value: { revision: 'A', contentHash: 'hash-A' },
    },
    probes = 0;
  const observer = createResourceObserver({
    signals,
    run: async (_id, action) => action(),
    probe: async () => {
      probes++;
      return observed;
    },
    deliver: () => true,
  });
  const stop = observer.watch(
    'r',
    '/doc.txt',
    owner,
    'A',
    (event) => events.push(event),
    (cause) => errors.push(cause),
  );
  return {
    signals,
    owner,
    events,
    errors,
    observer,
    stop,
    set: (revision: string | null) => {
      observed = { ok: true, value: { revision, contentHash: revision } };
    },
    fail: (cause: PortError) => {
      observed = { ok: false, error: cause };
    },
    probes: () => probes,
  };
}

it('разделяет watcher/poll, объединяет сигналы и хранит ревизии каждого владельца', async () => {
  const f = setup();
  await f.observer.refresh(f.owner);
  const other = {},
    events: ResourceEvent[] = [];
  const stop = f.observer.watch(
    'r',
    '/doc.txt',
    other,
    'A',
    (event) => events.push(event),
    () => {},
  );
  await f.observer.refresh(other);
  expect(f.signals.watchers.size).toBe(1);
  expect([...f.signals.polls.values()]).toEqual([2000]);
  f.set('B');
  f.observer.acknowledge(f.owner, 'r', 'B');
  f.signals.signal();
  f.signals.signal();
  expect([...f.signals.timers.values()]).toEqual([100]);
  f.signals.debounce();
  await f.observer.refresh(other);
  expect(f.events).toEqual([]);
  expect(events.map((event) => event.kind)).toEqual(['changed']);
  f.set(null);
  await f.observer.refresh(f.owner);
  await f.observer.refresh(other);
  f.set('C');
  await f.observer.refresh(f.owner);
  expect(f.events.map((event) => event.kind)).toEqual(['deleted', 'changed']);
  expect(events.map((event) => event.kind)).toEqual(['changed', 'deleted', 'changed']);
  f.stop();
  expect(f.signals.watchers.size).toBe(1);
  stop();
  expect(f.signals.watchers.size + f.signals.timers.size + f.signals.polls.size).toBe(0);
  f.observer.close();
});

it('busy повторяется, одинаковые ошибки не спамят, polling восстанавливает watcher', async () => {
  const f = setup();
  await f.observer.refresh(f.owner);
  f.fail({ ...error, code: 'busy' });
  await f.observer.refresh(f.owner);
  expect(f.signals.timers.size).toBe(1);
  expect(f.errors).toEqual([]);
  f.fail(error);
  await f.observer.refresh(f.owner);
  await f.observer.refresh(f.owner);
  expect(f.errors).toEqual([error]);
  f.signals.unavailable = true;
  f.signals.fail(error);
  expect(f.signals.watchers.size).toBe(0);
  f.set('B');
  f.signals.poll();
  await f.observer.refresh(f.owner);
  expect(f.events).toHaveLength(1);
  f.signals.unavailable = false;
  f.signals.poll();
  await f.observer.refresh(f.owner);
  expect(f.signals.watchers.size).toBe(1);
  f.observer.close();
});

it('не выдумывает deleted без baseline; изолирует исключения listener/onError', async () => {
  const f = setup();
  await f.observer.refresh(f.owner);
  const events: ResourceEvent[] = [];
  f.set(null);
  f.observer.watch(
    'r',
    '/doc.txt',
    {},
    undefined,
    (event) => events.push(event),
    () => {},
  );
  f.observer.watch(
    'r',
    '/doc.txt',
    {},
    'A',
    () => {
      throw new Error('listener');
    },
    () => {
      throw new Error('onError');
    },
  );
  await f.observer.refresh(f.owner);
  expect(events).toEqual([]);
  f.set('B');
  await f.observer.refresh(f.owner);
  expect(events.map((event) => event.kind)).toEqual(['changed']);
  expect(f.events.map((event) => event.kind)).toEqual(['deleted', 'changed']);
  f.observer.close();
});

it('закрытие во время probe не доставляет результат и не оставляет таймеры', async () => {
  const signals = new ManualSignals(),
    owner = {},
    events: ResourceEvent[] = [];
  let release!: (value: Result<FileObservation, PortError>) => void;
  const blocked = new Promise<Result<FileObservation, PortError>>((resolve) => {
    release = resolve;
  });
  const observer = createResourceObserver({
    signals,
    run: async (_id, action) => action(),
    probe: () => blocked,
    deliver: () => true,
  });
  const stop = observer.watch(
    'r',
    '/doc.txt',
    owner,
    'A',
    (event) => events.push(event),
    () => {},
  );
  await Promise.resolve(); // probe уже начат, но ещё ждёт blocked.
  const pending = observer.refresh(owner);
  signals.signal();
  stop();
  stop();
  observer.close();
  release({ ok: true, value: { revision: 'B', contentHash: 'B' } });
  await pending;
  expect(events).toEqual([]);
  expect(signals.watchers.size + signals.polls.size + signals.timers.size).toBe(0);
});

it('не запускает параллельные probe и объединяет повторные намерения', async () => {
  const signals = new ManualSignals(),
    owner = {};
  let release!: () => void,
    enter!: () => void,
    probes = 0,
    active = 0,
    maximum = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const observer = createResourceObserver({
    signals,
    run: async (_id, action) => action(),
    async probe() {
      probes++;
      active++;
      maximum = Math.max(maximum, active);
      if (probes === 1) {
        enter();
        await blocked;
      }
      active--;
      return { ok: true, value: { revision: 'A', contentHash: 'A' } };
    },
    deliver: () => true,
  });
  observer.watch(
    'r',
    '/doc.txt',
    owner,
    'A',
    () => {},
    () => {},
  );
  await entered;
  const checks = [observer.refresh(owner), observer.refresh(owner), observer.refresh(owner)];
  release();
  await Promise.all(checks);
  expect(maximum).toBe(1);
  expect(probes).toBe(2);
  observer.close();
});

it('синхронный onError может закрыть observer без утечки возвращённого watcher', async () => {
  const signals = new ManualSignals();
  let stops = 0,
    probes = 0;
  signals.watch = (_path, _signal, onError) => {
    onError(error);
    return () => {
      stops++;
    };
  };
  const owner = {};
  const observer = createResourceObserver({
    signals,
    run: async (_id, action) => action(),
    async probe() {
      probes++;
      return { ok: true, value: { revision: 'B', contentHash: 'B' } };
    },
    deliver: () => true,
  });
  observer.watch(
    'r',
    '/doc.txt',
    owner,
    'A',
    () => {},
    () => observer.close(),
  );
  await observer.refresh(owner);
  expect(stops).toBe(1);
  expect(probes).toBe(0);
  expect(signals.polls.size + signals.timers.size).toBe(0);
});

it('refresh на границе завершения предыдущей проверки не теряется', async () => {
  const signals = new ManualSignals(),
    owner = {},
    events: ResourceEvent[] = [];
  let revision = 'A',
    first = true,
    pending: Promise<void> | undefined;
  let queued!: () => void;
  const requested = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const observer = createResourceObserver({
    signals,
    async run(_id, action) {
      await action();
      if (first) {
        first = false;
        queueMicrotask(() =>
          queueMicrotask(() => {
            revision = 'B';
            pending = observer.refresh(owner);
            queued();
          }),
        );
      }
    },
    async probe() {
      return { ok: true, value: { revision, contentHash: revision } };
    },
    deliver: () => true,
  });
  observer.watch(
    'r',
    '/doc.txt',
    owner,
    'A',
    (event) => events.push(event),
    () => {},
  );
  await requested;
  await pending;
  expect(events.map((event) => event.kind)).toEqual(['changed']);
  observer.close();
});

it('исключение очереди сообщает onError и не мешает следующей проверке', async () => {
  const signals = new ManualSignals(),
    owner = {},
    errors: PortError[] = [],
    events: ResourceEvent[] = [];
  let failed = false;
  const observer = createResourceObserver({
    signals,
    async run(_id, action) {
      if (!failed) {
        failed = true;
        throw new Error('queue');
      }
      await action();
    },
    async probe() {
      return { ok: true, value: { revision: 'B', contentHash: 'B' } };
    },
    deliver: () => true,
  });
  observer.watch(
    'r',
    '/doc.txt',
    owner,
    'A',
    (event) => events.push(event),
    (error) => errors.push(error),
  );
  await observer.refresh(owner);
  expect(errors).toHaveLength(1);
  await observer.refresh(owner);
  expect(events).toHaveLength(1);
  observer.close();
});
