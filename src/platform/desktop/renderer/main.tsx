import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../ui';
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
const workspace = createWorkspaceApplication(documents, () => window.desktop.pickOpen());
if (import.meta.hot) import.meta.hot.dispose(() => workspace.dispose());
createRoot(root).render(
  <StrictMode>
    <App diagnostics={window.desktop} application={application} workspace={workspace} />
  </StrictMode>,
);
