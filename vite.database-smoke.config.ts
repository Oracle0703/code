import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((module) => `node:${module}`)];

export default defineConfig({
  build: {
    target: 'node24',
    outDir: 'reports/database-smoke',
    emptyOutDir: true,
    minify: false,
    ssr: 'scripts/smoke-packaged-database-service.ts',
    rollupOptions: {
      external: nodeBuiltins,
      output: {
        format: 'cjs',
        entryFileNames: 'database-service-smoke.cjs',
      },
    },
  },
});
