import {
  applyTransaction,
  copyFrozen,
  createEditState,
  EditHistory,
  equalSnapshots,
  snapshotOf,
  validateSnapshot,
  validSelection,
} from '../core';
import type {
  AppliedTransaction,
  DocumentFormat,
  EditState,
  EditTransaction,
  Result,
  SessionId,
  SourceSelection,
  StorageRef,
} from '../core';
import type { DraftRecord, LoadedDocument, PortError, SaveResult, SaveTarget } from '../ports';
import type {
  ApplicationOptions,
  CommandError,
  CommandReply,
  DocumentApplication,
  SaveAttempt,
  SessionView,
} from './contracts';

const ok = <T>(value: T): Result<T, PortError> => ({ ok: true, value });
const error = (code: PortError['code'], message: string): PortError => ({
  code,
  message,
  retryable: code === 'io-error' || code === 'busy',
});
const missing = () => error('not-found', 'Сессия не найдена');
const busy = () => error('busy', 'Операция требует завершения или состояние изменилось');
const key = (ref: StorageRef) => JSON.stringify([ref.storageId, ref.resourceId]);
const sameRef = (a: StorageRef | null, b: StorageRef) => a !== null && key(a) === key(b);
const sameSelection = (a: SourceSelection, b: SourceSelection) =>
  a.anchor === b.anchor && a.head === b.head;
const blockedSave = (s: Session) =>
  s.view.save.kind === 'unknown' || s.view.save.kind === 'history-pending';
const notWritten = (reason: PortError): SaveResult => ({ kind: 'not-written', error: reason });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Session {
  view: SessionView;
  selection: SourceSelection;
  history: EditHistory;
  listeners: Set<() => void>;
  draft: DraftRecord;
  draftSequence: number;
  clearedThrough: number;
  closing: boolean;
  lastInput: { time: number; groupId: string | null; selection: SourceSelection } | null;
  readSequence: number;
  saveGeneration: number;
  running: Promise<SaveResult> | null;
  queued: {
    target: SaveTarget | undefined;
    pending: ReturnType<typeof deferred<SaveResult>>;
  } | null;
}

export function createDocumentApplication(options: ApplicationOptions): DocumentApplication {
  return new Application(options);
}

class Application implements DocumentApplication {
  private readonly sessions = new Map<SessionId, Session>();
  private readonly locations = new Map<string, SessionId>();
  private readonly reservations = new Map<string, SessionId>();
  private readonly opening = new Map<string, Promise<Result<SessionId, PortError>>>();
  constructor(private readonly options: ApplicationOptions) {}

  create(format: DocumentFormat): SessionId {
    return this.add(createEditState(this.options.newId('document'), format), null);
  }
  getSnapshot(id: SessionId): SessionView | undefined {
    return this.sessions.get(id)?.view;
  }
  subscribe(id: SessionId, listener: () => void): () => void {
    const listeners = this.sessions.get(id)?.listeners;
    listeners?.add(listener);
    return () => {
      listeners?.delete(listener);
    };
  }
  open(ref: StorageRef): Promise<Result<SessionId, PortError>> {
    const issue = this.support(ref);
    if (issue) return Promise.resolve({ ok: false, error: issue });
    const resource = key(ref),
      existing = this.locations.get(resource);
    if (existing) return Promise.resolve(ok(existing));
    if (this.reservations.has(resource)) return Promise.resolve({ ok: false, error: busy() });
    const running = this.opening.get(resource);
    if (running) return running;
    const promise = this.load(copyFrozen(ref))
      .then((loaded): Result<SessionId, PortError> => {
        if (!loaded.ok) return loaded;
        const current = this.locations.get(resource);
        if (current) return ok(current);
        if (this.reservations.has(resource)) return { ok: false, error: busy() };
        return ok(
          this.add(
            createEditState(
              loaded.value.documentId,
              loaded.value.format,
              loaded.value.snapshot,
              loaded.value.ref,
            ),
            loaded.value.storageRevision,
          ),
        );
      })
      .finally(() => {
        this.opening.delete(resource);
      });
    this.opening.set(resource, promise);
    return promise;
  }

  apply(id: SessionId, transaction: EditTransaction): Result<CommandReply, CommandError> {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: missing() };
    if (s.closing) return { ok: false, error: busy() };
    const now = this.options.now(),
      last = s.lastInput;
    const change = transaction.body.changes[0];
    const input =
      Boolean(transaction.groupId) &&
      transaction.body.fileMetadata === undefined &&
      transaction.body.changes.length === 1 &&
      change !== undefined &&
      change.from <=
        Math.min(transaction.selectionBefore.anchor, transaction.selectionBefore.head) &&
      change.to >= Math.max(transaction.selectionBefore.anchor, transaction.selectionBefore.head);
    const merge =
      input &&
      last !== null &&
      last.groupId === transaction.groupId &&
      sameSelection(last.selection, transaction.selectionBefore) &&
      sameSelection(s.selection, transaction.selectionBefore) &&
      now - last.time >= 0 &&
      now - last.time <= 500;
    const result = s.history.apply(s.view.edit, transaction, merge);
    if (!result.ok) return result;
    if (result.value.changed)
      s.lastInput = input
        ? {
            time: now,
            groupId: transaction.groupId,
            selection: copyFrozen(transaction.selectionAfter),
          }
        : null;
    else if (!sameSelection(s.selection, transaction.selectionAfter)) this.breakGroup(s);
    return this.accept(s, result.value, result.value.changed);
  }
  undo(id: SessionId): Result<CommandReply, CommandError> {
    return this.travel(id, true);
  }
  redo(id: SessionId): Result<CommandReply, CommandError> {
    return this.travel(id, false);
  }
  setSelection(id: SessionId, selection: SourceSelection): Result<void, CommandError> {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: missing() };
    if (s.closing) return { ok: false, error: busy() };
    if (!validSelection(s.view.edit.document.text, selection))
      return { ok: false, error: { code: 'invalid-selection', message: 'Некорректное выделение' } };
    if (!sameSelection(s.selection, selection)) {
      this.breakGroup(s);
      s.selection = copyFrozen(selection);
    }
    return ok(undefined);
  }
  breakUndoGroup(id: SessionId): Result<void, PortError> {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: missing() };
    this.breakGroup(s);
    return ok(undefined);
  }

  save(id: SessionId, target?: SaveTarget): Promise<SaveResult> {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(notWritten(missing()));
    if (s.closing) return Promise.resolve(notWritten(busy()));
    if (s.running || blockedSave(s)) {
      if (!s.queued)
        s.queued = {
          target: target ? copyFrozen(target) : undefined,
          pending: deferred<SaveResult>(),
        };
      else if (target) s.queued.target = copyFrozen(target);
      return s.queued.pending.promise;
    }
    const location = s.view.edit.document.location;
    const destination =
      target ?? (location ? { ref: location, expectedRevision: s.view.storageRevision } : null);
    if (!destination)
      return Promise.resolve(notWritten(error('target-required', 'Выберите место сохранения')));
    const issue = this.support(destination.ref);
    if (issue) return Promise.resolve(notWritten(issue));
    if (s.view.conflict.kind !== 'none' && sameRef(location, destination.ref))
      return Promise.resolve(notWritten(busy()));
    const owner =
      this.locations.get(key(destination.ref)) ?? this.reservations.get(key(destination.ref));
    if ((owner && owner !== id) || this.opening.has(key(destination.ref)))
      return Promise.resolve(notWritten(busy()));
    const attempt = copyFrozen({
      request: {
        operationId: this.options.newId('operation'),
        documentId: s.view.edit.document.id,
        format: s.view.edit.document.format,
        target: destination,
        snapshot: snapshotOf(s.view.edit),
        access: null,
      },
      capturedStateRevision: s.view.edit.stateRevision,
    });
    return this.start(s, attempt, false);
  }
  reconcileSave(id: SessionId): Promise<SaveResult> {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(notWritten(missing()));
    if (s.running) return s.running;
    const state = s.view.save;
    if (state.kind !== 'unknown' && state.kind !== 'history-pending')
      return Promise.resolve(notWritten(error('invalid-input', 'Нет незавершённого сохранения')));
    return this.start(s, state.attempt, true);
  }

  async flushDraft(id: SessionId): Promise<Result<void, PortError>> {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: missing() };
    if (s.closing) return { ok: false, error: busy() };
    if (!s.view.isDirty) return this.clearDraft(s, s.view.edit.stateRevision);
    if (s.draft.stateRevision <= s.clearedThrough) return ok(undefined);
    const sequence = ++s.draftSequence;
    let result: Result<void, PortError>;
    try {
      const put = await this.options.storage.drafts.put(s.draft);
      result = put.ok ? ok(undefined) : put;
    } catch {
      result = { ok: false, error: error('io-error', 'Не удалось записать черновик') };
    }
    this.draftFeedback(s, sequence, result);
    return result;
  }

  async reload(
    id: SessionId,
    intent: 'if-clean' | 'discard-local',
    expected?: { readonly stateRevision: number; readonly storageRevision: string },
  ): Promise<Result<void, PortError>> {
    const guard = expected ? { ...expected } : undefined;
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: missing() };
    const ref = s.view.edit.document.location;
    if (!ref) return { ok: false, error: error('target-required', 'Документ ещё не сохранён') };
    if (s.closing || s.running || blockedSave(s)) return { ok: false, error: busy() };
    if (guard && guard.stateRevision !== s.view.edit.stateRevision)
      return { ok: false, error: busy() };
    const sequence = ++s.readSequence,
      generation = s.saveGeneration,
      revision = s.view.edit.stateRevision;
    const loaded = await this.load(ref);
    if (
      !this.live(s) ||
      sequence !== s.readSequence ||
      generation !== s.saveGeneration ||
      revision !== s.view.edit.stateRevision ||
      s.closing ||
      s.running ||
      blockedSave(s)
    )
      return { ok: false, error: busy() };
    if (!loaded.ok) {
      this.publish(s, {
        conflict:
          loaded.error.code === 'not-found'
            ? { kind: 'deleted' }
            : { kind: 'changed', observed: null },
      });
      return loaded;
    }
    if (
      loaded.value.documentId !== s.view.edit.document.id ||
      loaded.value.format !== s.view.edit.document.format
    )
      return {
        ok: false,
        error: error('invalid-input', 'Хранилище изменило идентичность документа'),
      };
    if (loaded.value.storageRevision === s.view.storageRevision && intent === 'if-clean')
      return ok(undefined);
    if (guard && guard.storageRevision !== loaded.value.storageRevision) {
      this.publish(s, { conflict: { kind: 'changed', observed: loaded.value } });
      return { ok: false, error: busy() };
    }
    if (s.view.isDirty && intent === 'if-clean') {
      this.publish(s, { conflict: { kind: 'changed', observed: loaded.value } });
      return ok(undefined);
    }
    const current = s.view.edit;
    const applied = applyTransaction(current, {
      documentId: current.document.id,
      baseStateRevision: current.stateRevision,
      body: {
        changes: [
          { from: 0, to: current.document.text.length, insert: loaded.value.snapshot.text },
        ],
        fileMetadata: loaded.value.snapshot.fileMetadata,
      },
      selectionBefore: s.selection,
      selectionAfter: { anchor: 0, head: 0 },
      groupId: null,
    });
    if (!applied.ok) return { ok: false, error: error('invalid-input', applied.error.message) };
    s.history.clear();
    this.breakGroup(s);
    s.selection = applied.value.selection;
    s.draft = this.captureDraft(
      s,
      applied.value.state,
      loaded.value.snapshot,
      loaded.value.storageRevision,
    );
    this.publish(s, {
      edit: applied.value.state,
      baseline: loaded.value.snapshot,
      storageRevision: loaded.value.storageRevision,
      conflict: { kind: 'none' },
      save: { kind: 'idle' },
    });
    return this.clearDraft(s, applied.value.state.stateRevision);
  }

  async close(
    id: SessionId,
    decision: 'cancel' | 'discard' | 'save',
    target?: SaveTarget,
  ): Promise<Result<{ readonly closed: boolean }, PortError>> {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: missing() };
    if (decision === 'cancel') return ok({ closed: false });
    if (s.closing || s.running || blockedSave(s)) return { ok: false, error: busy() };
    if (decision === 'save') {
      const outcome = await this.save(id, target);
      if (outcome.kind !== 'saved')
        return { ok: false, error: outcome.kind === 'not-written' ? outcome.error : busy() };
      if (!this.live(s)) return { ok: false, error: missing() };
      if (s.view.isDirty || s.view.conflict.kind !== 'none' || s.running)
        return ok({ closed: false });
    }
    s.closing = true;
    this.breakGroup(s);
    const cleared = await this.clearDraft(s, s.view.edit.stateRevision);
    if (!cleared.ok) {
      s.closing = false;
      return cleared;
    }
    this.sessions.delete(id);
    const ref = s.view.edit.document.location;
    if (ref && this.locations.get(key(ref)) === id) this.locations.delete(key(ref));
    this.emit(s);
    s.listeners.clear();
    return ok({ closed: true });
  }

  private add(edit: EditState, storageRevision: string | null): SessionId {
    const id = this.options.newId('session');
    if (!id || this.sessions.has(id))
      throw new TypeError('Генератор должен выдавать уникальный SessionId');
    const view: SessionView = copyFrozen({
      sessionId: id,
      edit,
      baseline: snapshotOf(edit),
      storageRevision,
      isDirty: false,
      save: { kind: 'idle' },
      conflict: { kind: 'none' },
      canUndo: false,
      canRedo: false,
      draftError: null,
    });
    const s: Session = {
      view,
      selection: { anchor: 0, head: 0 },
      history: new EditHistory(),
      listeners: new Set(),
      draft: this.draftRecord(view, edit, view.baseline, storageRevision),
      draftSequence: 0,
      clearedThrough: -1,
      closing: false,
      lastInput: null,
      readSequence: 0,
      saveGeneration: 0,
      running: null,
      queued: null,
    };
    this.sessions.set(id, s);
    if (edit.document.location) this.locations.set(key(edit.document.location), id);
    return id;
  }
  private support(ref: StorageRef): PortError | null {
    if (ref.storageId !== this.options.storage.id || this.options.storage.access !== null)
      return error('unsupported', 'Этот адаптер хранения пока не поддерживается');
    return !ref.resourceId ? error('invalid-input', 'Пустой ресурс') : null;
  }
  private async load(ref: StorageRef): Promise<Result<LoadedDocument, PortError>> {
    try {
      const result = await this.options.storage.documents.load(ref, null);
      if (
        result.ok &&
        (!sameRef(result.value.ref, ref) ||
          !result.value.documentId ||
          !result.value.storageRevision ||
          !['txt', 'markdown'].includes(result.value.format) ||
          validateSnapshot(result.value.snapshot))
      )
        return {
          ok: false,
          error: error('invalid-input', 'Хранилище вернуло некорректный документ'),
        };
      return copyFrozen(result);
    } catch {
      return { ok: false, error: error('io-error', 'Не удалось прочитать документ') };
    }
  }
  private live(s: Session): boolean {
    return this.sessions.get(s.view.sessionId) === s;
  }
  private breakGroup(s: Session): void {
    s.history.breakGroup();
    s.lastInput = null;
  }
  private travel(id: SessionId, undo: boolean): Result<CommandReply, CommandError> {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: missing() };
    if (s.closing) return { ok: false, error: busy() };
    const before = [s.history.canUndo, s.history.canRedo];
    const result = undo
      ? s.history.undo(s.view.edit, s.selection)
      : s.history.redo(s.view.edit, s.selection);
    if (!result.ok) return result;
    this.breakGroup(s);
    return this.accept(
      s,
      result.value,
      result.value.changed || before[0] !== s.history.canUndo || before[1] !== s.history.canRedo,
    );
  }
  private accept(
    s: Session,
    applied: AppliedTransaction,
    publish: boolean,
  ): Result<CommandReply, CommandError> {
    s.selection = applied.selection;
    if (applied.changed) s.draft = this.captureDraft(s, applied.state);
    if (publish) this.publish(s, { edit: applied.state });
    return { ok: true, value: { view: s.view, selection: s.selection } };
  }
  private draftRecord(
    view: SessionView,
    edit: EditState,
    baseline = view.baseline,
    revision = view.storageRevision,
  ): DraftRecord {
    return copyFrozen({
      key: { documentId: edit.document.id, sessionId: view.sessionId },
      format: edit.document.format,
      location: edit.document.location,
      snapshot: snapshotOf(edit),
      baseline,
      baseStorageRevision: revision,
      stateRevision: edit.stateRevision,
    });
  }
  private captureDraft(
    s: Session,
    edit: EditState,
    baseline = s.view.baseline,
    revision = s.view.storageRevision,
  ): DraftRecord {
    return this.draftRecord(s.view, edit, baseline, revision);
  }
  private publish(s: Session, changes: Partial<SessionView>): void {
    const next = { ...s.view, ...changes };
    s.view = copyFrozen({
      ...next,
      isDirty: !equalSnapshots(next.edit.document, next.baseline),
      canUndo: s.history.canUndo,
      canRedo: s.history.canRedo,
    });
    this.emit(s);
  }
  private emit(s: Session): void {
    for (const listener of [...s.listeners]) {
      try {
        listener();
      } catch {
        this.report(error('io-error', 'Ошибка слушателя сессии'));
      }
    }
  }
  private report(issue: PortError): void {
    try {
      this.options.onError?.(issue);
    } catch {
      /* Диагностика не должна ломать фиксацию состояния. */
    }
  }
  private draftFeedback(s: Session, sequence: number, result: Result<void, PortError>): void {
    if (!this.live(s) || sequence !== s.draftSequence) return;
    const issue = result.ok ? null : result.error;
    if (issue !== s.view.draftError) this.publish(s, { draftError: issue });
  }
  private async clearDraft(s: Session, through: number): Promise<Result<void, PortError>> {
    const sequence = ++s.draftSequence;
    let result: Result<void, PortError>;
    try {
      result = await this.options.storage.drafts.removeThrough(s.draft.key, through);
    } catch {
      result = { ok: false, error: error('io-error', 'Не удалось очистить черновик') };
    }
    if (result.ok) s.clearedThrough = Math.max(s.clearedThrough, through);
    this.draftFeedback(s, sequence, result);
    return result;
  }

  private start(s: Session, attempt: SaveAttempt, reconcile: boolean): Promise<SaveResult> {
    const task = deferred<SaveResult>();
    s.running = task.promise;
    s.saveGeneration++;
    this.reservations.set(key(attempt.request.target.ref), s.view.sessionId);
    this.breakGroup(s);
    if (!reconcile) this.publish(s, { save: { kind: 'saving', attempt } });
    void this.execute(s, attempt, reconcile).then((result) => {
      s.running = null;
      task.resolve(result);
      if (!this.live(s) || result.kind === 'unknown' || result.kind === 'history-pending') return;
      this.reservations.delete(key(attempt.request.target.ref));
      const queued = s.queued;
      s.queued = null;
      if (queued) {
        if (result.kind === 'saved') {
          const target =
            queued.target &&
            sameRef(queued.target.ref, result.receipt.ref) &&
            queued.target.expectedRevision === attempt.request.target.expectedRevision
              ? { ref: queued.target.ref, expectedRevision: result.receipt.storageRevision }
              : queued.target;
          void this.save(s.view.sessionId, target).then(queued.pending.resolve);
        } else queued.pending.resolve(result);
      }
    });
    return task.promise;
  }
  private async execute(s: Session, attempt: SaveAttempt, reconcile: boolean): Promise<SaveResult> {
    const request = attempt.request,
      documents = this.options.storage.documents;
    let result: SaveResult;
    try {
      if (reconcile) {
        const status = await documents.getOperation(request.operationId);
        if (!status.ok)
          result = { kind: 'unknown', operationId: request.operationId, error: status.error };
        else if (status.value.kind === 'missing') result = await documents.save(request);
        else if (status.value.kind === 'settled' && status.value.outcome.kind !== 'history-pending')
          result = status.value.outcome;
        else result = await documents.reconcile(request.operationId);
      } else result = await documents.save(request);
      if (!['saved', 'history-pending', 'conflict', 'not-written', 'unknown'].includes(result.kind))
        throw new Error('Некорректный результат');
      if (
        (result.kind === 'saved' || result.kind === 'history-pending') &&
        (result.receipt.operationId !== request.operationId ||
          result.receipt.documentId !== request.documentId ||
          result.receipt.format !== request.format ||
          !sameRef(result.receipt.ref, request.target.ref) ||
          !result.receipt.storageRevision)
      )
        throw new Error('Некорректное подтверждение');
      if (result.kind === 'unknown' && result.operationId !== request.operationId)
        throw new Error('Другая операция');
      result = copyFrozen(result);
    } catch {
      result = {
        kind: 'unknown',
        operationId: request.operationId,
        error: error('io-error', 'Исход сохранения неизвестен'),
      };
    }
    if (!this.live(s)) return result;
    s.saveGeneration++;
    if (result.kind === 'saved' || result.kind === 'history-pending') {
      const old = s.view.edit.document.location;
      if (old && !sameRef(old, result.receipt.ref)) this.locations.delete(key(old));
      this.locations.set(key(result.receipt.ref), s.view.sessionId);
      this.publish(s, {
        edit: {
          ...s.view.edit,
          document: { ...s.view.edit.document, location: result.receipt.ref },
        },
        baseline: request.snapshot,
        storageRevision: result.receipt.storageRevision,
        save:
          result.kind === 'saved'
            ? { kind: 'idle' }
            : { kind: 'history-pending', attempt, receipt: result.receipt, error: result.error },
        ...(!sameRef(old, result.receipt.ref) ? { conflict: { kind: 'none' as const } } : {}),
      });
      await this.clearDraft(s, attempt.capturedStateRevision);
    } else if (result.kind === 'unknown')
      this.publish(s, { save: { kind: 'unknown', attempt, error: result.error } });
    else if (result.kind === 'not-written')
      this.publish(s, { save: { kind: 'failed', attempt, error: result.error } });
    else
      this.publish(s, {
        save: { kind: 'idle' },
        ...(sameRef(s.view.edit.document.location, request.target.ref)
          ? {
              conflict:
                result.actualRevision === null
                  ? { kind: 'deleted' }
                  : { kind: 'changed', observed: null },
            }
          : {}),
      });
    return result;
  }
}
