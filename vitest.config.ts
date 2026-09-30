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
    include: ['packages/*/test/**/*.test.ts'],
  },
});
