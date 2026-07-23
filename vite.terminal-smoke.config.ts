import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((module) => `node:${module}`)];

export default defineConfig({
  build: {
    target: 'node24',
    outDir: 'reports/terminal-smoke',
    emptyOutDir: true,
    minify: false,
    ssr: 'scripts/smoke-packaged-terminal-manager.ts',
    rollupOptions: {
      // Resolve node-pty from the packaged app through NODE_PATH at smoke-test
      // runtime so this exercises the Electron-rebuilt native module.
      external: ['node-pty', ...nodeBuiltins],
      output: {
        format: 'cjs',
        entryFileNames: 'terminal-manager-smoke.cjs',
      },
    },
  },
});
