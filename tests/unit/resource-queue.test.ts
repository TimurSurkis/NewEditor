import { expect, it } from 'vitest';
import { ResourceQueue } from '../../src/platform/desktop/main/persistence/queue';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('задачи одного ресурса идут по порядку, другой ресурс не ждёт', async () => {
  const queue = new ResourceQueue();
  const blocked = gate();
  const events: string[] = [];
  const first = queue.run('a', async () => {
    events.push('a1');
    await blocked.promise;
    events.push('a1-end');
    return 1;
  });
  const second = queue.run('a', () => {
    events.push('a2');
    return 2;
  });
  expect(
    await queue.run('b', () => {
      events.push('b');
      return 3;
    }),
  ).toBe(3);
  expect(events).toEqual(['a1', 'b']);
  blocked.resolve();
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  expect(events).toEqual(['a1', 'b', 'a1-end', 'a2']);
});

it('асинхронная ошибка не отравляет очередь', async () => {
  const queue = new ResourceQueue();
  const rejected = queue.run('a', async () => {
    throw new Error('first');
  });
  const next = queue.run('a', () => 'next');
  await expect(rejected).rejects.toThrow('first');
  expect(await next).toBe('next');
  expect(await queue.run('a', () => 'later')).toBe('later');
});

it('синхронная ошибка возвращается как rejected Promise, следующая задача выполняется', async () => {
  const queue = new ResourceQueue();
  const rejected = queue.run('a', () => {
    throw new Error('sync');
  });
  const next = queue.run('a', () => 'next');
  await expect(rejected).rejects.toThrow('sync');
  expect(await next).toBe('next');
});

it('задача, добавленная при завершении прежнего хвоста, не обгоняет ожидающую', async () => {
  const queue = new ResourceQueue();
  const events: string[] = [];
  const first = queue.run('a', () => {
    events.push('first');
  });
  const second = queue.run('a', () => {
    events.push('second');
  });
  await first;
  const third = queue.run('a', () => {
    events.push('third');
  });
  await Promise.all([second, third]);
  expect(events).toEqual(['first', 'second', 'third']);
});
