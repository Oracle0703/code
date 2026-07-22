import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import { App } from './App';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Renderer root element was not found.');
}

try {
  // This cache only avoids a first-paint flash. The active SQLite workspace
  // replaces it as soon as the trusted workspace snapshot has loaded.
  const savedTheme = JSON.parse(window.localStorage.getItem('daily.paint.theme') ?? '"dark"');
  document.documentElement.dataset.theme = savedTheme === 'light' ? 'light' : 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark';
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
