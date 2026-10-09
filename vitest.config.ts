import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@vibe/shared': pkg('shared'),
      '@vibe/engine': pkg('engine'),
      '@vibe/runtime': pkg('runtime'),
      '@vibe/server': pkg('server'),
    },
  },
  test: {
    // Games kept in projects/ (each its own repository) may bring tests that run against this engine.
    include: ['packages/*/test/**/*.test.ts', 'projects/*/tests/**/*.test.ts'],
  },
});
