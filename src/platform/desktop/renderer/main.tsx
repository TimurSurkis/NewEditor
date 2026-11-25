import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../ui';
import { createDocumentApplication } from '../../../application';
import { createMemoryStorage } from '../../memory';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент интерфейса');

const application = createDocumentApplication({
  storage: createMemoryStorage().storage,
  newId: () => crypto.randomUUID(),
  now: () => performance.now(),
});
createRoot(root).render(
  <StrictMode>
    <App diagnostics={window.desktop} application={application} />
  </StrictMode>,
);
