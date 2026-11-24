import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../ui';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент интерфейса');

createRoot(root).render(
  <StrictMode>
    <App diagnostics={window.desktop} />
  </StrictMode>,
);
