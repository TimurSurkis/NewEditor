import type { DocumentFormat, Result, StorageRef } from '../core';
import type { PortError, ResourceEvents, SaveResult, SaveTarget } from '../ports';
import { createWorkspaceObservation } from './workspace-observation';
import type { CommandError, DocumentApplication, SessionView } from './contracts';

export interface OpenDialogResult {
  readonly documents: readonly { readonly ref: StorageRef; readonly displayName: string }[];
  readonly errors: readonly { readonly displayName: string; readonly error: PortError }[];
}
export interface SaveDialogRequest {
  readonly suggestedName: string;
  readonly format: DocumentFormat;
  readonly current: StorageRef | null;
}
export interface SaveDialogResult {
  readonly target: SaveTarget;
  readonly displayName: string;
}
export type CloseDecision = 'save' | 'discard' | 'cancel';
export interface WorkspaceDialogs {
  pickSave(input: SaveDialogRequest): Promise<Result<SaveDialogResult | null, PortError>>;
  confirmClose(displayName: string): Promise<Result<CloseDecision, PortError>>;
}
export interface WorkspaceTab {
  readonly id: string;
  readonly name: string;
  readonly view: SessionView;
  readonly closing: boolean;
  readonly saving: boolean;
  readonly externalError: string | null;
}
export interface WorkspaceSnapshot {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeId: string | null;
  readonly opening: boolean;
  readonly transitioning: boolean;
  readonly ending: boolean;
  readonly errors: readonly string[];
}
export interface WorkspaceApplication {
  getSnapshot(): WorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  create(format: DocumentFormat): Promise<void>;
  select(id: string): Promise<void>;
  open(): Promise<void>;
  close(id: string): Promise<void>;
  closeAll(): Promise<boolean>;
  save(id: string, saveAs?: boolean): Promise<SaveResult | null>;
  reconcile(id: string): Promise<void>;
  refreshExternal(): Promise<void>;
  acceptExternal(
    id: string,
    expected: { readonly stateRevision: number; readonly storageRevision: string },
  ): Promise<void>;
  clearErrors(): void;
  dispose(): void;
}

export function createWorkspaceApplication(
  documents: DocumentApplication,
  pickOpen: () => Promise<Result<OpenDialogResult | null, PortError>>,
  beforeLeave?: (id: string) => Promise<Result<void, CommandError>>,
  dialogs?: WorkspaceDialogs,
  events?: ResourceEvents,
): WorkspaceApplication {
  let snapshot: WorkspaceSnapshot = Object.freeze({
    tabs: Object.freeze([]),
    activeId: null,
    opening: false,
    transitioning: false,
    ending: false,
    errors: Object.freeze([]),
  });
  const listeners = new Set<() => void>(),
    stops = new Map<string, () => void>();
  let serial = 0,
    live = true,
    opening: Promise<void> | null = null;
  const saves = new Map<string, Promise<SaveResult | null>>(),
    selectedNames = new Map<string, string>();
  let closingIntent: Promise<boolean> | null = null;
  let observation: ReturnType<typeof createWorkspaceObservation> | undefined;
  const publish = (changes: Partial<WorkspaceSnapshot>) => {
    if (!live) return;
    snapshot = Object.freeze({ ...snapshot, ...changes });
    observation?.synchronize(snapshot.tabs);
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
  const leave = async (id: string | null): Promise<boolean> => {
    if (!live || snapshot.transitioning) return false;
    if (!beforeLeave || id === null) return true;
    publish({ transitioning: true });
    try {
      const result = await beforeLeave(id);
      if (!live) return false;
      if (!result.ok) {
        issue(result.error.message);
        return false;
      }
      return true;
    } catch {
      issue('Не удалось подтвердить ввод редактора');
      return false;
    } finally {
      publish({ transitioning: false });
    }
  };
  const add = (id: string, name: string, activate = true) => {
    if (!live) return;
    const existing = snapshot.tabs.find((tab) => tab.id === id);
    if (existing) {
      if (!existing.closing && activate) publish({ activeId: id });
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
      tabs: Object.freeze([
        ...snapshot.tabs,
        Object.freeze({ id, name, view, closing: false, saving: false, externalError: null }),
      ]),
      activeId: activate ? id : snapshot.activeId,
    });
  };
  const updateTab = (
    id: string,
    changes: Partial<Pick<WorkspaceTab, 'name' | 'saving' | 'closing' | 'externalError'>>,
  ) =>
    publish({
      tabs: Object.freeze(
        snapshot.tabs.map((tab) => (tab.id === id ? Object.freeze({ ...tab, ...changes }) : tab)),
      ),
    });
  const blocked = (view: SessionView) =>
    view.save.kind === 'unknown' || view.save.kind === 'history-pending';
  const feedback = (id: string, result: SaveResult) => {
    if (result.kind === 'conflict' || result.kind === 'not-written') selectedNames.delete(id);
    if (result.kind === 'saved' || result.kind === 'history-pending') {
      const name = selectedNames.get(id);
      if (name) updateTab(id, { name });
      if (result.kind === 'saved') selectedNames.delete(id);
    }
    if (result.kind === 'conflict')
      issue(
        'Цель изменилась или появилась после проверки. Файл не перезаписан; выберите другую цель через «Сохранить как…».',
      );
    else if (result.kind !== 'saved') issue(result.error.message);
  };
  const closeOne = async (id: string): Promise<boolean> => {
    if (saves.has(id)) await saves.get(id);
    if (beforeLeave && !(await leave(id))) return false;
    const tab = snapshot.tabs.find((tab) => tab.id === id);
    if (!live || !tab || tab.closing) return false;
    if (blocked(tab.view) || tab.view.save.kind === 'saving') {
      issue('Сначала проверьте незавершённое сохранение.');
      return false;
    }
    const revision = tab.view.edit.stateRevision;
    if (tab.view.isDirty || tab.view.conflict.kind !== 'none') {
      if (!dialogs) {
        issue('Есть несохранённые изменения. Закрытие с выбором сохранения не подключено.');
        return false;
      }
      const answer = await dialogs.confirmClose(tab.name);
      if (!live) return false;
      if (!answer.ok) {
        issue(answer.error.message);
        return false;
      }
      const decision = answer.value;
      if (decision === 'cancel') {
        issue('Закрытие отменено.');
        return false;
      }
      if (beforeLeave && !(await leave(id))) return false;
      if (decision === 'save') {
        const result = await workspace.save(id, tab.view.conflict.kind !== 'none');
        if (!result || result.kind !== 'saved') return false;
        if (beforeLeave && !(await leave(id))) return false;
        if (documents.getSnapshot(id)?.isDirty) {
          issue('После снимка сохранения появились новые правки; вкладка оставлена открытой.');
          return false;
        }
      } else if (documents.getSnapshot(id)?.edit.stateRevision !== revision) {
        issue(
          'Во время диалога появились новые правки; прежнее разрешение отбросить текст отменено.',
        );
        return false;
      }
    }
    const current = documents.getSnapshot(id);
    if (!current) return false;
    const expected = current.edit.stateRevision;
    updateTab(id, { closing: true });
    try {
      const checked = documents.getSnapshot(id);
      if (!checked || checked.edit.stateRevision !== expected || blocked(checked)) {
        issue('Состояние изменилось перед закрытием.');
        return false;
      }
      const closed = await documents.close(id, 'discard');
      if (!live) return false;
      if (!closed.ok) {
        issue(closed.error.message);
        return false;
      }
      if (!closed.value.closed) return false;
      stops.get(id)?.();
      stops.delete(id);
      selectedNames.delete(id);
      const index = snapshot.tabs.findIndex((tab) => tab.id === id),
        tabs = snapshot.tabs.filter((tab) => tab.id !== id);
      publish({
        tabs: Object.freeze(tabs),
        activeId:
          snapshot.activeId === id
            ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
            : snapshot.activeId,
      });
      return true;
    } catch {
      issue('Не удалось закрыть документ');
      return false;
    } finally {
      if (live && snapshot.tabs.some((tab) => tab.id === id)) updateTab(id, { closing: false });
    }
  };
  const workspace: WorkspaceApplication = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (live) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async create(format) {
      if (snapshot.ending) return;
      if (beforeLeave && !(await leave(snapshot.activeId))) return;
      if (live)
        add(documents.create(format), `Без имени ${++serial}.${format === 'txt' ? 'txt' : 'md'}`);
    },
    async select(id) {
      if (snapshot.ending) return;
      if (snapshot.activeId === id) return;
      if (beforeLeave && !(await leave(snapshot.activeId))) return;
      if (
        live &&
        snapshot.activeId !== id &&
        snapshot.tabs.some((tab) => tab.id === id && !tab.closing)
      )
        publish({ activeId: id });
    },
    open() {
      if (!live || snapshot.ending) return Promise.resolve();
      if (opening) return opening;
      opening = Promise.resolve().then(async () => {
        try {
          if (!live) return;
          if (beforeLeave && !(await leave(snapshot.activeId))) return;
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
            if (loaded.ok) {
              const activate =
                !beforeLeave ||
                snapshot.activeId === loaded.value ||
                (await leave(snapshot.activeId));
              add(loaded.value, choice.displayName, activate);
            } else issue(`${choice.displayName}: ${loaded.error.message}`);
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
      if (!live || snapshot.ending || closingIntent) return;
      closingIntent = Promise.resolve()
        .then(() => closeOne(id))
        .catch(() => {
          issue('Не удалось подтвердить закрытие');
          return false;
        });
      try {
        await closingIntent;
      } finally {
        closingIntent = null;
      }
    },
    async closeAll() {
      if (!live || snapshot.ending) return false;
      if (closingIntent && !(await closingIntent)) return false;
      publish({ ending: true });
      try {
        await opening;
        await Promise.all([...saves.values()]);
        for (const tab of [...snapshot.tabs]) if (!(await closeOne(tab.id))) return false;
        return live && snapshot.tabs.length === 0;
      } catch {
        issue('Не удалось подготовить закрытие окна');
        return false;
      } finally {
        publish({ ending: false });
      }
    },
    save(id, saveAs = false) {
      const existing = saves.get(id);
      if (existing) return existing;
      if (!live) return Promise.resolve(null);
      const task = Promise.resolve().then(async (): Promise<SaveResult | null> => {
        try {
          const tab = snapshot.tabs.find((tab) => tab.id === id);
          if (!tab || tab.closing) return null;
          publish({ errors: Object.freeze([]) });
          if (blocked(tab.view)) {
            issue('Сначала проверьте незавершённое сохранение.');
            return null;
          }
          if (beforeLeave && !(await leave(id))) return null;
          const view = documents.getSnapshot(id);
          if (!view) return null;
          let chosen: SaveDialogResult | null = null;
          if (saveAs || !view.edit.document.location) {
            if (!dialogs) {
              issue('Диалог сохранения не подключён');
              return null;
            }
            const result = await dialogs.pickSave({
              suggestedName: tab.name,
              format: view.edit.document.format,
              current: view.edit.document.location,
            });
            if (!live) return null;
            if (!result.ok) {
              issue(result.error.message);
              return null;
            }
            if (result.value === null) return null;
            chosen = result.value;
            if (beforeLeave && !(await leave(id))) return null;
            if (!documents.getSnapshot(id)) return null;
            selectedNames.set(id, chosen.displayName);
          }
          const result = await documents.save(id, chosen?.target);
          if (live) feedback(id, result);
          return result;
        } catch {
          issue('Не удалось подготовить сохранение');
          return null;
        } finally {
          saves.delete(id);
          updateTab(id, { saving: false });
        }
      });
      saves.set(id, task);
      updateTab(id, { saving: true });
      return task;
    },
    async reconcile(id) {
      if (!live || saves.has(id) || snapshot.tabs.find((tab) => tab.id === id)?.saving) return;
      publish({ errors: Object.freeze([]) });
      if (beforeLeave && !(await leave(id))) return;
      updateTab(id, { saving: true });
      try {
        const result = await documents.reconcileSave(id);
        if (live) feedback(id, result);
      } finally {
        updateTab(id, { saving: false });
      }
    },
    async refreshExternal() {
      await observation?.refresh();
    },
    async acceptExternal(id, expected) {
      await observation?.accept(id, expected);
    },
    clearErrors() {
      if (snapshot.errors.length) publish({ errors: Object.freeze([]) });
    },
    dispose() {
      live = false;
      observation?.dispose();
      for (const stop of stops.values()) stop();
      stops.clear();
      listeners.clear();
    },
  };
  if (events)
    observation = createWorkspaceObservation(
      documents,
      events,
      beforeLeave,
      (id, externalError) => {
        if (snapshot.tabs.find((tab) => tab.id === id)?.externalError !== externalError)
          updateTab(id, { externalError });
      },
    );
  return workspace;
}
