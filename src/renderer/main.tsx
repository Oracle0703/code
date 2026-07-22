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
  const savedTheme = JSON.parse(window.localStorage.getItem('daily.appearance.theme') ?? '"dark"');
  document.documentElement.dataset.theme = savedTheme === 'light' ? 'light' : 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark';
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
