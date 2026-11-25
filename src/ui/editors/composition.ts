import type { Result } from '../../core';
import type { CommandError } from '../../application';
import type { EditorFrame, EditorHost } from './contracts';

export class Composition {
  active = false;
  base: EditorFrame | null = null;
  error: CommandError | null = null;
  private waiting: ((result: Result<void, CommandError>) => void)[] = [];
  constructor(private readonly host: EditorHost) {}
  begin(frame: EditorFrame): void {
    if (!this.active) {
      this.active = true;
      this.base ??= frame;
      this.host.compositionChanged(true);
    }
  }
  end(result: Result<void, CommandError>, pending: string): void {
    this.active = false;
    this.error = result.ok ? null : result.error;
    if (result.ok) this.base = null;
    else this.host.reportError(result.error, pending);
    this.host.compositionChanged(false);
    for (const resolve of this.waiting.splice(0)) resolve(result);
  }
  flush(): Promise<Result<void, CommandError>> {
    if (this.active) return new Promise((resolve) => this.waiting.push(resolve));
    return Promise.resolve(
      this.error ? { ok: false, error: this.error } : { ok: true, value: undefined },
    );
  }
  cancel(): void {
    this.active = false;
    for (const resolve of this.waiting.splice(0))
      resolve({
        ok: false,
        error: { code: 'cancelled', message: 'Ожидание ввода отменено', retryable: false },
      });
  }
}
