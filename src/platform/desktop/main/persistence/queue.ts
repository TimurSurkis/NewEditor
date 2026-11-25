export class ResourceQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, action: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(action);
    // Хвост всегда fulfilled: отказ одной задачи не блокирует следующие.
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
