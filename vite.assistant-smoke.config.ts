import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((module) => `node:${module}`)];

export default defineConfig({
  build: {
    target: 'node24',
    outDir: 'reports/assistant-provider-smoke',
    emptyOutDir: true,
    minify: false,
    ssr: 'scripts/smoke-packaged-assistant-provider.ts',
    rollupOptions: {
      external: nodeBuiltins,
      output: {
        format: 'cjs',
        entryFileNames: 'assistant-provider-smoke.cjs',
      },
    },
  },
});
