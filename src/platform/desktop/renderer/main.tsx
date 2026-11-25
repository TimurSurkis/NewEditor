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
const beforeUnload = (event: BeforeUnloadEvent) => {
  const state = workspace.getSnapshot();
  if (!editor.hasPending() && !state.tabs.some((tab) => tab.view.isDirty)) return;
  event.preventDefault();
  event.returnValue = '';
  if (state.activeId)
    editor.report(
      state.activeId,
      'Закрытие или перезагрузка отменены: есть несохранённый или неподтверждённый ввод. Сохранение появится в P5.3.',
    );
};
window.addEventListener('beforeunload', beforeUnload);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    window.removeEventListener('beforeunload', beforeUnload);
    stop();
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
