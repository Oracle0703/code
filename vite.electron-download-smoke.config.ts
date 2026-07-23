import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((module) => `node:${module}`)];

export default defineConfig({
  build: {
    target: 'node24',
    outDir: 'reports/electron-download-smoke',
    emptyOutDir: true,
    minify: false,
    ssr: 'scripts/smoke-electron-downloads.ts',
    rollupOptions: {
      external: ['electron', ...nodeBuiltins],
      output: {
        format: 'cjs',
        entryFileNames: 'electron-download-smoke.cjs',
      },
    },
  },
});
