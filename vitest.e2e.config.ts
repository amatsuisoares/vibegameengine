import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/** Browser tests: start the Vite dev server and drive the runtime page in headless Chromium. */
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ['packages/*/e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
