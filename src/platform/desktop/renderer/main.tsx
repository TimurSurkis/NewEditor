import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, WorkspaceEditor } from '../../../ui';
import { createDocumentApplication, createWorkspaceApplication } from '../../../application';
import { createMemoryStorage } from '../../memory';
import { createRendererStorage } from './local-storage';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент интерфейса');

const application = createDocumentApplication({
  storage: createMemoryStorage().storage,
  newId: () => crypto.randomUUID(),
  now: () => performance.now(),
});
const documents = createDocumentApplication({
  storage: createRendererStorage(window.desktop),
  newId: () => crypto.randomUUID(),
  now: () => performance.now(),
});
const editor = new WorkspaceEditor(documents);
const workspace = createWorkspaceApplication(
  documents,
  () => window.desktop.pickOpen(),
  (id) => editor.flush(id),
  {
    pickSave: (input) => window.desktop.pickSave(input),
    confirmClose: (displayName) => window.desktop.confirmClose(displayName),
  },
);
const synchronize = () => {
  const state = workspace.getSnapshot();
  editor.synchronize(
    state.tabs.map((tab) => tab.id),
    state.activeId,
    state.tabs.filter((tab) => tab.closing).map((tab) => tab.id),
  );
};
const stop = workspace.subscribe(synchronize);
synchronize();
let resolvingClose = false;
const stopClose = window.desktop.onCloseRequested(() => {
  if (resolvingClose) return;
  resolvingClose = true;
  void workspace
    .closeAll()
    .then(async (proceed) => {
      await window.desktop.resolveClose(
        proceed && !editor.hasPending() && workspace.getSnapshot().tabs.length === 0,
      );
    })
    .catch(async () => {
      await window.desktop.resolveClose(false);
    })
    .finally(() => {
      resolvingClose = false;
    });
});
const beforeUnload = (event: BeforeUnloadEvent) => {
  const state = workspace.getSnapshot();
  if (
    !editor.hasPending() &&
    !state.ending &&
    !state.tabs.some(
      (tab) =>
        tab.view.isDirty ||
        tab.saving ||
        ['saving', 'unknown', 'history-pending'].includes(tab.view.save.kind),
    )
  )
    return;
  event.preventDefault();
  event.returnValue = '';
  if (state.activeId)
    editor.report(
      state.activeId,
      'Перезагрузка отменена: есть несохранённый ввод или незавершённая запись. Сначала сохраните или закройте вкладки.',
    );
};
window.addEventListener('beforeunload', beforeUnload);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    window.removeEventListener('beforeunload', beforeUnload);
    stop();
    stopClose();
    editor.destroy();
    workspace.dispose();
  });
createRoot(root).render(
  <StrictMode>
    <App
      diagnostics={window.desktop}
      application={application}
      workspace={workspace}
      editor={editor}
    />
  </StrictMode>,
);
