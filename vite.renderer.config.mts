import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(currentDirectory, 'src/renderer'),
  plugins: [react()],
  build: {
    outDir: path.resolve(currentDirectory, '.vite/renderer/main_window'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    cors: {
      origin: /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(currentDirectory, 'src'),
    },
  },
});
